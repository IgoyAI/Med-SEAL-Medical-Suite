"""SEA-LION Embedding client for semantic search and relevance ranking.

Uses BAAI/bge-m3 via the SEA-LION API (OpenAI-compatible /v1/embeddings).
1024-dimensional multilingual embeddings supporting EN, ZH, MS, TA and 100+ languages.
"""

from __future__ import annotations

import logging
import math
from typing import Sequence

import httpx

from agent.config import settings

logger = logging.getLogger(__name__)

_EMBED_TIMEOUT = 10.0


async def embed_texts(texts: list[str]) -> list[list[float]]:
    """Embed a batch of texts using SEA-LION's BAAI/bge-m3 model.

    Returns a list of 1024-dim float vectors, one per input text.
    Returns empty vectors on failure (fails open).
    """
    if not texts:
        return []
    # Truncate each text to avoid exceeding token limits
    truncated = [t[:2000] for t in texts]
    try:
        async with httpx.AsyncClient(timeout=_EMBED_TIMEOUT) as client:
            resp = await client.post(
                f"{settings.sealion_api_url}/embeddings",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
                json={
                    "model": settings.sealion_embedding_model,
                    "input": truncated,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            embeddings = [d["embedding"] for d in data["data"]]
            return embeddings
    except Exception as exc:
        logger.warning("SEA-LION embedding failed: %s", exc)
        return [[] for _ in texts]


async def embed_single(text: str) -> list[float]:
    """Embed a single text string."""
    results = await embed_texts([text])
    return results[0] if results else []


def cosine_similarity(a: list[float], b: list[float]) -> float:
    """Compute cosine similarity between two vectors."""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    norm_a = math.sqrt(sum(x * x for x in a))
    norm_b = math.sqrt(sum(x * x for x in b))
    if norm_a == 0 or norm_b == 0:
        return 0.0
    return dot / (norm_a * norm_b)


# ── Source authority tiers (healthcare hierarchy) ─────────────────────

_AUTHORITY_TIERS: dict[str, float] = {
    # Tier 1: Government clinical practice guidelines (boost +0.15)
    "MOH Singapore": 0.15,
    "moh.gov.sg": 0.15,
    "hpp.moh.gov.sg": 0.15,
    "who.int": 0.15,
    "cdc.gov": 0.12,
    "nice.org.uk": 0.12,
    # Tier 2: Academic medical centres & peer-reviewed (boost +0.10)
    "PubMed/Scholar": 0.10,
    "pubmed.ncbi.nlm.nih.gov": 0.10,
    "NUH Singapore": 0.10,
    "nuh.com.sg": 0.10,
    "Mayo Clinic": 0.08,
    "mayoclinic.org": 0.08,
    "nejm.org": 0.10,
    "thelancet.com": 0.10,
    "bmj.com": 0.10,
    # Tier 3: Consumer health (no boost)
    "WebMD": 0.0,
    "webmd.com": 0.0,
    "HealthHub SG": 0.03,
    "healthhub.sg": 0.03,
}


def _get_authority_boost(item: dict) -> float:
    """Get authority tier boost for a search result."""
    label = item.get("source_label", "")
    url = item.get("url", "")
    # Check by label first
    boost = _AUTHORITY_TIERS.get(label, 0.0)
    if boost:
        return boost
    # Check by URL domain
    for domain, b in _AUTHORITY_TIERS.items():
        if domain in url:
            return b
    return 0.0


async def rank_by_relevance(
    query: str,
    items: list[dict],
    text_key: str = "snippet",
    min_score: float = 0.25,
) -> list[dict]:
    """Rank items by semantic similarity + source authority.

    Each item gets a '_relevance_score' field (semantic + authority boost).
    Items below min_score are dropped.
    """
    if not items:
        return []
    texts = [item.get(text_key, "") or item.get("title", "") for item in items]
    all_texts = [query] + texts
    embeddings = await embed_texts(all_texts)

    if not embeddings or not embeddings[0]:
        # Embedding failed — return items with authority-only ranking
        for item in items:
            item["_relevance_score"] = 0.5 + _get_authority_boost(item)
        items.sort(key=lambda x: x["_relevance_score"], reverse=True)
        return items

    query_emb = embeddings[0]
    scored = []
    for i, item in enumerate(items):
        item_emb = embeddings[i + 1]
        semantic_score = cosine_similarity(query_emb, item_emb) if item_emb else 0.0
        authority_boost = _get_authority_boost(item)
        final_score = semantic_score + authority_boost
        item["_relevance_score"] = round(final_score, 4)
        item["_semantic_score"] = round(semantic_score, 4)
        item["_authority_boost"] = authority_boost
        if final_score >= min_score:
            scored.append(item)

    scored.sort(key=lambda x: x["_relevance_score"], reverse=True)
    return scored


async def reformulate_query(patient_message: str) -> str:
    """Extract a focused medical search query from a conversational patient message.

    Uses SEA-LION to strip conversational noise and produce a clean search query.
    Falls back to the original message on failure.
    """
    prompt = (
        "Extract the core medical question from this patient message. "
        "Return ONLY a concise search query (5-10 words), no explanation.\n\n"
        "Examples:\n"
        "- 'I'm worried about my sugar levels, my mom had diabetes too' → 'diabetes blood sugar management hereditary risk'\n"
        "- 'my back has been hurting a lot lately and I can't sleep' → 'chronic back pain sleep disturbance treatment'\n"
        "- 'what happens if I forget to take my metformin' → 'missed metformin dose effects'\n"
        "- 'apa kesan sampingan ubat darah tinggi' → 'hypertension medication side effects'\n\n"
        f"Patient message: {patient_message[:300]}\n"
        "Search query:"
    )
    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(
                f"{settings.sealion_api_url}/chat/completions",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
                json={
                    "model": settings.sealion_model,
                    "messages": [{"role": "user", "content": prompt}],
                    "max_tokens": 30,
                    "temperature": 0.0,
                },
            )
            resp.raise_for_status()
            answer = resp.json()["choices"][0]["message"]["content"].strip()
            # Clean up: take first line, strip quotes
            query = answer.split("\n")[0].strip().strip("'\"")
            if 3 <= len(query) <= 100:
                logger.info("Query reformulated: %r → %r", patient_message[:40], query)
                return query
    except Exception as exc:
        logger.warning("Query reformulation failed: %s", exc)
    return patient_message
