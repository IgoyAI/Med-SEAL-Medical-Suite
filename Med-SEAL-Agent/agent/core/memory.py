"""Patient memory extraction and retrieval.

Extracts persistent clinical memories from conversations and stores
them per-patient in SQLite.  Memories are loaded into the system prompt
at the start of each session so the agent "remembers" across visits.
"""

from __future__ import annotations

import asyncio
import json
import logging
import uuid
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

import httpx
import aiosqlite
from langchain_core.messages import BaseMessage, HumanMessage, AIMessage

from agent.config import settings

logger = logging.getLogger(__name__)


class MemoryType(str, Enum):
    PATIENT_OBSERVATION = "patient_observation"
    TREATMENT_RESPONSE = "treatment_response"
    PATIENT_PREFERENCE = "patient_preference"
    CLINICAL_NOTE = "clinical_note"


@dataclass
class PatientMemory:
    patient_id: str
    memory_type: MemoryType
    content: str
    source_session: str
    memory_id: str = field(default_factory=lambda: uuid.uuid4().hex[:12])
    created_at: str = field(
        default_factory=lambda: datetime.now(timezone.utc).isoformat()
    )


_EXTRACTION_PROMPT = """\
Extract key memories from this medical conversation between a patient and \
their health assistant.  For each memory, specify:
- type: one of patient_observation, treatment_response, patient_preference, clinical_note
- content: a concise factual statement (max 30 words)

Rules:
- Only extract genuinely new, clinically relevant information.
- Skip greetings, generic advice, and repeated information.
- Maximum 5 memories per conversation.

Return ONLY a JSON array: [{"type": "...", "content": "..."}, ...]

Conversation:
{conversation}"""


_CREATE_SQL = """
CREATE TABLE IF NOT EXISTS patient_memories (
    memory_id       TEXT PRIMARY KEY,
    patient_id      TEXT NOT NULL,
    memory_type     TEXT NOT NULL,
    content         TEXT NOT NULL,
    source_session  TEXT NOT NULL,
    created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_patient_memories_patient
    ON patient_memories(patient_id, created_at);
"""


class MemoryStore:
    """SQLite-backed patient memory store."""

    def __init__(self, db_path: str):
        self._db_path = db_path

    async def setup(self) -> None:
        try:
            async with aiosqlite.connect(self._db_path) as db:
                await db.executescript(_CREATE_SQL)
                await db.commit()
            logger.info("MemoryStore initialised")
        except Exception as exc:
            logger.warning("MemoryStore setup failed (non-fatal): %s", exc)

    async def save_memories(
        self, patient_id: str, memories: list[PatientMemory]
    ) -> None:
        """Save memories with embedding-based deduplication.

        Before saving, check cosine similarity against existing memories.
        Skip if >0.85 similar to prevent duplicate facts.
        """
        if not memories:
            return
        try:
            # Load existing memories for dedup
            existing = await self.load_memories(patient_id, limit=20)
            existing_texts = [m.content for m in existing]

            # Deduplicate using embeddings
            new_texts = [m.content for m in memories]
            deduped: list[PatientMemory] = []

            if existing_texts and new_texts:
                try:
                    from agent.core.embeddings import embed_texts, cosine_similarity
                    all_texts = existing_texts + new_texts
                    embeddings = await embed_texts(all_texts)

                    if embeddings and embeddings[0]:
                        existing_embs = embeddings[:len(existing_texts)]
                        new_embs = embeddings[len(existing_texts):]

                        for i, mem in enumerate(memories):
                            new_emb = new_embs[i] if i < len(new_embs) else []
                            is_dup = False
                            if new_emb:
                                for ex_emb in existing_embs:
                                    if ex_emb and cosine_similarity(new_emb, ex_emb) > 0.85:
                                        logger.info(
                                            "Memory dedup: skipping %r (similar to existing)",
                                            mem.content[:50],
                                        )
                                        is_dup = True
                                        break
                            if not is_dup:
                                deduped.append(mem)
                    else:
                        deduped = memories  # Embedding failed, save all
                except Exception as e:
                    logger.warning("Memory dedup failed, saving all: %s", e)
                    deduped = memories
            else:
                deduped = memories

            if not deduped:
                logger.info("All memories deduplicated for patient %s", patient_id)
                return

            async with aiosqlite.connect(self._db_path) as db:
                for m in deduped:
                    await db.execute(
                        "INSERT OR IGNORE INTO patient_memories "
                        "(memory_id, patient_id, memory_type, content, "
                        "source_session, created_at) VALUES (?,?,?,?,?,?)",
                        (
                            m.memory_id,
                            m.patient_id,
                            m.memory_type.value,
                            m.content,
                            m.source_session,
                            m.created_at,
                        ),
                    )
                await db.commit()
            logger.info(
                "Saved %d memories for patient %s (%d deduped)",
                len(deduped), patient_id, len(memories) - len(deduped),
            )
        except Exception as exc:
            logger.warning("Memory save failed: %s", exc)

    async def load_memories(
        self, patient_id: str, limit: int | None = None
    ) -> list[PatientMemory]:
        if limit is None:
            limit = settings.memory_load_limit
        try:
            async with aiosqlite.connect(self._db_path) as db:
                db.row_factory = aiosqlite.Row
                cursor = await db.execute(
                    "SELECT * FROM patient_memories WHERE patient_id = ? "
                    "ORDER BY created_at DESC LIMIT ?",
                    (patient_id, limit),
                )
                rows = await cursor.fetchall()
                return [
                    PatientMemory(
                        memory_id=r["memory_id"],
                        patient_id=r["patient_id"],
                        memory_type=MemoryType(r["memory_type"]),
                        content=r["content"],
                        source_session=r["source_session"],
                        created_at=r["created_at"],
                    )
                    for r in rows
                ]
        except Exception as exc:
            logger.warning("Memory load failed: %s", exc)
            return []


# ---------------------------------------------------------------------------
# Extraction
# ---------------------------------------------------------------------------

def _messages_to_text(messages: list[BaseMessage], max_messages: int) -> str:
    """Convert recent messages to text for the extraction prompt."""
    recent = messages[-max_messages:]
    lines = []
    for m in recent:
        if isinstance(m, HumanMessage):
            role = "Patient"
        elif isinstance(m, AIMessage):
            role = "Assistant"
        else:
            continue
        content = m.content if isinstance(m.content, str) else str(m.content)
        lines.append(f"{role}: {content[:400]}")
    return "\n".join(lines)


def _parse_memories_json(raw: str) -> list[dict]:
    """Best-effort JSON array parsing from LLM output."""
    raw = raw.strip()
    # Try direct parse
    try:
        parsed = json.loads(raw)
        if isinstance(parsed, list):
            return parsed
    except json.JSONDecodeError:
        pass
    # Try extracting array from surrounding text
    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1 and end > start:
        try:
            parsed = json.loads(raw[start : end + 1])
            if isinstance(parsed, list):
                return parsed
        except json.JSONDecodeError:
            pass
    return []


async def extract_memories(
    messages: list[BaseMessage],
    patient_id: str,
    session_id: str,
) -> list[PatientMemory]:
    """Call SEA-LION to extract memories from recent messages."""
    conv_text = _messages_to_text(messages, settings.memory_extraction_max_messages)
    if not conv_text.strip():
        return []

    prompt = _EXTRACTION_PROMPT.format(conversation=conv_text[:4000])
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                f"{settings.sealion_api_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
                json={
                    "model": settings.sealion_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 400,
                    "temperature": 0.0,
                },
            )
            resp.raise_for_status()
            raw = resp.json()["choices"][0]["message"]["content"]
    except Exception as exc:
        logger.warning("Memory extraction LLM call failed: %s", exc)
        return []

    items = _parse_memories_json(raw)
    if not items:
        logger.debug("No memories parsed from LLM response: %s", raw[:200])
        return []

    valid_types = {t.value for t in MemoryType}
    memories = []
    for item in items[:5]:
        if not isinstance(item, dict):
            continue
        mtype = str(item.get("type", "")).strip()
        content = str(item.get("content", "")).strip()
        if not mtype or not content:
            continue
        if mtype not in valid_types:
            # Try to map common LLM variations
            for vt in valid_types:
                if mtype.lower().replace(" ", "_") in vt or vt in mtype.lower():
                    mtype = vt
                    break
            else:
                mtype = "clinical_note"  # Default fallback
        memories.append(
            PatientMemory(
                patient_id=patient_id,
                memory_type=MemoryType(mtype),
                content=content[:200],
                source_session=session_id,
            )
        )
    return memories


def format_memories_for_prompt(memories: list[PatientMemory]) -> str:
    """Format memories as a block for injection into the system prompt."""
    if not memories:
        return ""
    lines = ["[PATIENT MEMORY — from previous sessions]"]
    for m in memories:
        lines.append(f"- ({m.memory_type.value}) {m.content}")
    lines.append("[END PATIENT MEMORY]")
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

_memory_store: MemoryStore | None = None
_extraction_locks: dict[str, asyncio.Lock] = {}
_EXTRACTION_LOCKS_MAX = 500


async def init_memory_store(db_path: str) -> MemoryStore:
    global _memory_store
    _memory_store = MemoryStore(db_path)
    await _memory_store.setup()
    return _memory_store


def get_memory_store() -> MemoryStore | None:
    return _memory_store


async def extract_memories_background(
    messages: list[BaseMessage],
    patient_id: str,
    session_id: str,
) -> None:
    """Fire-and-forget background memory extraction with per-patient locking."""
    if not settings.memory_enabled or _memory_store is None:
        return

    # Per-patient lock to prevent overlapping extractions (with eviction)
    if len(_extraction_locks) > _EXTRACTION_LOCKS_MAX:
        unlocked = [k for k, v in _extraction_locks.items() if not v.locked()]
        for k in unlocked[:len(unlocked) // 2]:
            del _extraction_locks[k]
    if patient_id not in _extraction_locks:
        _extraction_locks[patient_id] = asyncio.Lock()
    lock = _extraction_locks[patient_id]

    if lock.locked():
        logger.debug("Memory extraction already running for %s — skipping", patient_id)
        return

    async with lock:
        try:
            memories = await extract_memories(messages, patient_id, session_id)
            if memories:
                await _memory_store.save_memories(patient_id, memories)
        except Exception as exc:
            logger.warning("Background memory extraction failed: %s", exc)
