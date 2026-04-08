"""FastAPI route handlers for the Med-SEAL multi-agent system.

Surfaces:
- Patient app: /sessions/* (existing, now routed through orchestrator)
- CDS Hooks: POST /cds-services/patient-view
- System triggers: POST /triggers/{trigger_type}
- Admin: GET /agents, GET /agents/{agent_id}/health
"""

from __future__ import annotations

import json
import logging
import re
import uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from agent.core.orchestrator import AgentId, Surface, handle_request, list_agents

logger = logging.getLogger(__name__)

router = APIRouter()

_THINK_RE = re.compile(r"<think>.*?</think>", flags=re.DOTALL)
_THINK_OPEN_RE = re.compile(r"<think>.*", flags=re.DOTALL)
_THINK_CLOSE_RE = re.compile(r"^.*?</think>\s*", flags=re.DOTALL)
_ANSWER_RE = re.compile(r"</?answer\s*>", flags=re.IGNORECASE)


# ── Request / response schemas ────────────────────────────────────────────


class CreateSessionResponse(BaseModel):
    session_id: str
    created_at: str


class SendMessageRequest(BaseModel):
    message: str
    patient_id: str = Field(default="default-patient", description="FHIR Patient ID")
    image: str | None = Field(default=None, description="Base64-encoded image")
    thinking_effort: str = Field(default="balanced")


class ContextIndicator(BaseModel):
    """Rendered as a collapsible context pill in the chat UI."""
    label: str = ""
    sources_used: int = 0
    patient_record_loaded: bool = False
    search_engines: list[str] = Field(default_factory=list)
    details: list[str] = Field(default_factory=list)


class StructuredSource(BaseModel):
    """Typed source reference — journal papers include citation metadata."""
    type: str = Field(description="'journal' or 'web'")
    title: str = ""
    url: str = ""
    authors: str = Field(default="", description="Journal only: author list")
    year: str = Field(default="", description="Journal only: publication year")
    doi: str = Field(default="", description="Journal only: DOI")
    source_label: str = Field(default="", description="e.g. 'PubMed', 'WebMD', 'Mayo Clinic'")
    relevance_score: float = Field(default=0.0, description="Semantic relevance 0-1")


class ConfidenceInfo(BaseModel):
    """Response confidence metadata for the frontend."""
    score: float = Field(default=0.5, description="0-1 confidence score")
    has_ehr_data: bool = False
    has_search_results: bool = False
    source_count: int = 0
    reasoning: str = ""


class AssistantResponse(BaseModel):
    role: str = "assistant"
    content: str
    thinking: str | None = None
    task_type: str = "general"
    language: str = "en"
    sources: list[str] = Field(default_factory=list, description="Flat URL list (backward compat)")
    structured_sources: list[StructuredSource] = Field(
        default_factory=list,
        description="Typed sources with journal citations and relevance scores",
    )
    confidence: ConfidenceInfo | None = Field(
        default=None, description="Response confidence based on grounding data",
    )
    steps: list[dict[str, Any]] = Field(default_factory=list)
    context: ContextIndicator | None = None
    agent: str | None = None
    task_id: str | None = None
    appointment_action: str | None = None
    appointment_verified: bool | None = None


class ClarifyResponse(BaseModel):
    clarify: str


class MessageEntry(BaseModel):
    role: str
    content: str


class HistoryResponse(BaseModel):
    session_id: str
    messages: list[MessageEntry]


class HealthResponse(BaseModel):
    status: str
    vllm: str
    redis: str
    medplum: str = "unknown"
    agents: dict[str, str] = Field(default_factory=dict)


class TriggerRequest(BaseModel):
    patient_id: str
    context: dict[str, Any] = Field(default_factory=dict)


class TriggerResponse(BaseModel):
    status: str
    trigger_type: str
    patient_id: str
    result: dict[str, Any] = Field(default_factory=dict)


class CDSHookRequest(BaseModel):
    hookInstance: str = ""
    hook: str = "patient-view"
    context: dict[str, Any] = Field(default_factory=dict)
    prefetch: dict[str, Any] = Field(default_factory=dict)


class CDSHookResponse(BaseModel):
    cards: list[dict[str, Any]] = Field(default_factory=list)


class AgentHealthResponse(BaseModel):
    agent_id: str
    status: str
    details: dict[str, Any] = Field(default_factory=dict)


# ── Helpers ───────────────────────────────────────────────────────────────


def _extract_sources(messages: list) -> list[str]:
    urls: list[str] = []
    seen: set[str] = set()
    url_re = re.compile(r"https?://[^\s\]\)]+")
    for msg in messages:
        if getattr(msg, "type", None) == "tool":
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            for url in url_re.findall(content):
                if url not in seen:
                    seen.add(url)
                    urls.append(url)
    return urls


def _clean_thinking(text: str) -> str:
    text = _THINK_RE.sub("", text)
    text = _THINK_CLOSE_RE.sub("", text)
    text = _THINK_OPEN_RE.sub("", text)
    text = _ANSWER_RE.sub("", text)
    return text.strip()


def _build_context_indicator(steps: list[dict], sources: list[str]) -> ContextIndicator:
    """Build the context pill from steps and sources."""
    engines = []
    patient_loaded = False
    details = []
    total_results = 0

    for s in steps:
        cat = s.get("category", "")
        action = s.get("action", "")
        if cat == "search" and s.get("tool"):
            label_map = {
                "search_webmd": "WebMD",
                "search_mayoclinic": "Mayo Clinic",
                "search_moh_sg": "MOH Singapore",
                "search_healthhub_sg": "HealthHub SG",
                "search_nuh": "NUH Singapore",
            }
            engine = label_map.get(s["tool"], s["tool"])
            if engine not in engines:
                engines.append(engine)
        elif cat == "result" and "sources_count" in s:
            total_results += s["sources_count"]
        elif cat == "fhir":
            details.append("Reading patient health record")
        elif cat == "result" and "loaded" in action.lower():
            patient_loaded = True
            details.append("Patient profile loaded")
        elif cat == "thinking":
            details.append(action)

    parts = []
    if engines:
        parts.append(f"Searched {len(engines)} source{'s' if len(engines) != 1 else ''}")
    if patient_loaded:
        parts.append("used patient record")
    label = " · ".join(parts) if parts else "Processed"

    return ContextIndicator(
        label=label,
        sources_used=len(sources),
        patient_record_loaded=patient_loaded,
        search_engines=engines,
        details=details,
    )


# ── Patient app surface (existing + orchestrator) ─────────────────────────


@router.post("/sessions", response_model=CreateSessionResponse)
async def create_session() -> CreateSessionResponse:
    session_id = uuid.uuid4().hex
    return CreateSessionResponse(
        session_id=session_id,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


@router.post(
    "/sessions/{session_id}/messages",
    response_model=AssistantResponse | ClarifyResponse,
)
async def send_message(
    session_id: str,
    body: SendMessageRequest,
    request: Request,
) -> AssistantResponse | ClarifyResponse:
    result = await handle_request(
        query=body.message,
        patient_id=body.patient_id,
        surface=Surface.PATIENT_APP,
        session_id=session_id,
    )

    if result.get("status") == "dedup":
        return AssistantResponse(content="")

    if result.get("status") == "blocked":
        return AssistantResponse(
            content=result.get("response", "Request blocked."),
            agent="guard",
        )

    content = result.get("response", "")
    thinking = None
    think_match = _THINK_RE.search(content)
    if think_match:
        thinking = think_match.group(0).removeprefix("<think>").removesuffix("</think>").strip()

    sources = result.get("sources", [])
    steps = result.get("steps", [])
    ctx = _build_context_indicator(steps, sources)

    appt_action = None
    appt_verified = None
    for s in steps:
        if s.get("category") == "appointment_meta":
            appt_action = s.get("appointment_action")
            appt_verified = s.get("appointment_verified")
            break

    # Build structured sources from orchestrator result
    raw_structured = result.get("structured_sources", [])
    typed_sources = [StructuredSource(**s) for s in raw_structured] if raw_structured else []

    # Compute response confidence
    from agent.core.schemas import compute_confidence
    conf = compute_confidence(
        ehr_context=result.get("ehr_context", ""),
        search_results=result.get("search_results", ""),
        source_count=len(sources),
        response_length=len(content),
    )
    confidence_info = ConfidenceInfo(**conf.model_dump())

    return AssistantResponse(
        content=_clean_thinking(content),
        thinking=thinking,
        sources=sources,
        structured_sources=typed_sources,
        confidence=confidence_info,
        steps=steps,
        context=ctx,
        agent=result.get("agent"),
        task_id=result.get("task_id"),
        appointment_action=appt_action,
        appointment_verified=appt_verified,
    )


class AnimatedStepsResponse(BaseModel):
    """Alternative response with steps ordered for client-side animation."""
    role: str = "assistant"
    content: str
    sources: list[str] = Field(default_factory=list)
    steps: list[dict[str, Any]] = Field(default_factory=list)
    context: ContextIndicator | None = None
    agent: str | None = None
    animate_delay_ms: int = Field(default=200, description="Suggested delay between step animations")


@router.post("/sessions/{session_id}/messages/stream")
async def stream_message(
    session_id: str,
    body: SendMessageRequest,
    request: Request,
    events: str = "",
):
    """SSE endpoint — single orchestrator call, real agent steps only.

    Pass ``?events=v2`` to opt into the new real-time event format (F5).
    Without the flag, the original step-based format is preserved.
    """
    if events == "v2":
        return await _stream_message_v2(session_id, body, request)

    async def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    async def event_generator():
        try:
            result = await handle_request(
                query=body.message,
                patient_id=body.patient_id,
                surface=Surface.PATIENT_APP,
                session_id=session_id,
            )

            if result.get("status") == "dedup":
                return

            agent_steps = result.get("steps", [])
            for step in agent_steps:
                yield await _sse({"step": step.get("action", ""), "detail": step, "done": False})

            final_content = result.get("response", "")
            thinking = None
            think_match = _THINK_RE.search(final_content)
            if think_match:
                thinking = think_match.group(0).removeprefix("<think>").removesuffix("</think>").strip()

            sources = result.get("sources", [])
            ctx = _build_context_indicator(agent_steps, sources)

            final_event: dict = {
                "content": _clean_thinking(final_content),
                "thinking": thinking,
                "task_type": "general",
                "language": "en",
                "sources": sources,
                "steps": agent_steps,
                "context": ctx.model_dump(),
                "agent": result.get("agent"),
                "task_id": result.get("task_id"),
                "done": True,
            }

            for step in agent_steps:
                if step.get("category") == "appointment_meta":
                    final_event["appointment_action"] = step.get("appointment_action")
                    final_event["appointment_verified"] = step.get("appointment_verified")
                    break

            yield await _sse(final_event)

        except Exception:
            logger.exception("Stream error")
            yield await _sse({
                "content": "I'm having trouble right now. Please try again.",
                "done": True,
            })

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.get("/sessions/{session_id}/messages", response_model=HistoryResponse)
async def get_history(session_id: str, request: Request) -> HistoryResponse:
    graph = request.app.state.graphs.get("companion-agent")
    if not graph:
        graph = request.app.state.graph
    config = {"configurable": {"thread_id": session_id}}

    try:
        snapshot = await graph.aget_state(config)
    except Exception:
        raise HTTPException(status_code=404, detail="Session not found")

    if not snapshot or not snapshot.values:
        raise HTTPException(status_code=404, detail="Session not found")

    entries: list[MessageEntry] = []
    for msg in snapshot.values.get("messages", []):
        role = getattr(msg, "type", "unknown")
        if role == "human":
            role = "user"
        elif role == "ai":
            role = "assistant"
        content = msg.content if isinstance(msg.content, str) else str(msg.content)
        entries.append(MessageEntry(role=role, content=content))

    return HistoryResponse(session_id=session_id, messages=entries)


@router.delete("/sessions/{session_id}", status_code=204)
async def delete_session(session_id: str, request: Request) -> None:
    checkpointer = request.app.state.checkpointer
    config = {"configurable": {"thread_id": session_id}}
    try:
        await checkpointer.adelete(config)
    except Exception:
        logger.debug("Failed to delete session %s", session_id, exc_info=True)


# ── Pre-Visit Summary (dedicated endpoint) ──────────────────────────────


class PrevisitRequest(BaseModel):
    patient_id: str = Field(..., description="FHIR Patient ID")


class PrevisitSummaryResponse(BaseModel):
    status: str
    patient_id: str
    summary: dict[str, Any] = Field(default_factory=dict)
    formatted: str = ""
    steps: list[dict[str, Any]] = Field(default_factory=list)


@router.post("/patients/{patient_id}/previsit-summary", response_model=PrevisitSummaryResponse)
async def get_previsit_summary(patient_id: str) -> PrevisitSummaryResponse:
    """Generate a pre-visit summary for a patient (all 11 sections from FHIR)."""
    try:
        from agent.tools.fhir_tools_previsit import get_patient_summary
        from agent.agents.previsit import _format_summary_text
        data = get_patient_summary(patient_id)
        formatted = _format_summary_text(data)
        return PrevisitSummaryResponse(
            status="ok",
            patient_id=patient_id,
            summary=data,
            formatted=formatted,
            steps=[
                {"action": "Collecting patient records from FHIR", "category": "fhir"},
                {"action": "Pre-visit summary generated", "category": "result"},
            ],
        )
    except Exception as exc:
        logger.exception("Pre-visit summary failed for %s", patient_id)
        return PrevisitSummaryResponse(
            status="error",
            patient_id=patient_id,
            formatted="Could not generate pre-visit summary. Please try again.",
            steps=[{"action": "Pre-visit summary failed", "category": "error"}],
        )


# ── F5: Real-time streaming (v2) ────────────────────────────────────────


async def _stream_message_v2(
    session_id: str,
    body: SendMessageRequest,
    request: Request,
):
    """V2 streaming — real-time events via handle_request_streaming()."""
    from agent.core.orchestrator import handle_request_streaming, Surface

    async def event_generator():
        try:
            async for event in handle_request_streaming(
                query=body.message,
                patient_id=body.patient_id,
                surface=Surface.PATIENT_APP,
                session_id=session_id,
            ):
                yield f"data: {json.dumps(event.to_dict())}\n\n"
        except Exception:
            logger.exception("V2 stream error")
            from agent.core.events import EventType, StreamEvent
            err = StreamEvent(
                type=EventType.ERROR,
                content="I'm having trouble right now. Please try again.",
                done=True,
            )
            yield f"data: {json.dumps(err.to_dict())}\n\n"

    return StreamingResponse(event_generator(), media_type="text/event-stream")


# ── OpenEMR Doctor Chat surface ──────────────────────────────────────────


class DoctorChatRequest(BaseModel):
    message: str = Field(..., description="Clinician's question")
    patient_id: str = Field(..., description="FHIR Patient ID in context")


@router.post("/openemr/sessions/{session_id}/chat")
async def doctor_chat(
    session_id: str,
    body: DoctorChatRequest,
    request: Request,
):
    """OpenEMR doctor chat — streams CDS with journal citations (OpenEvidence-style)."""
    import asyncio
    from agent.agents.doctor_cds import _fetch_patient_summary, SYSTEM_PROMPT
    from agent.tools.journal_tools import _pubmed_search, _semantic_scholar_search
    from agent.config import settings
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import SystemMessage, HumanMessage

    async def _sse(obj: dict) -> str:
        return f"data: {json.dumps(obj)}\n\n"

    async def event_generator():
        steps: list[dict] = []
        structured_sources: list[dict] = []
        try:
            # Step 1: Fetch patient context + search journals in parallel
            steps.append({"action": "Loading patient record", "category": "fhir"})
            yield await _sse({"step": "Loading patient record", "detail": steps[-1], "done": False})

            patient_ctx = ""
            journal_context = ""

            async def fetch_patient():
                nonlocal patient_ctx
                try:
                    patient_ctx = await _fetch_patient_summary(body.patient_id)
                except Exception as e:
                    logger.warning("CDS patient fetch failed: %s", e)

            async def search_journals():
                nonlocal journal_context, structured_sources
                try:
                    # Search multiple sources in parallel
                    pubmed_results, scholar_results = await asyncio.gather(
                        _pubmed_search(body.message, max_results=8),
                        _semantic_scholar_search(body.message, max_results=5),
                    )

                    # ── MinHash LSH deduplication ──
                    # Uses character n-gram shingling + MinHash signatures
                    # to detect near-duplicate titles (not just exact matches)
                    import hashlib

                    def _shingle(text: str, k: int = 3) -> set[str]:
                        """Generate character k-shingles from text."""
                        t = text.strip().lower()
                        if len(t) < k:
                            return {t}
                        return {t[i:i+k] for i in range(len(t) - k + 1)}

                    def _minhash(shingles: set[str], num_perm: int = 64) -> list[int]:
                        """Compute MinHash signature from shingles."""
                        if not shingles:
                            return [0] * num_perm
                        sig = []
                        for i in range(num_perm):
                            min_h = float('inf')
                            for s in shingles:
                                h = int(hashlib.md5(f"{i}:{s}".encode()).hexdigest(), 16)
                                if h < min_h:
                                    min_h = h
                            sig.append(min_h)
                        return sig

                    def _jaccard_minhash(sig_a: list[int], sig_b: list[int]) -> float:
                        """Estimate Jaccard similarity from MinHash signatures."""
                        if not sig_a or not sig_b:
                            return 0.0
                        return sum(a == b for a, b in zip(sig_a, sig_b)) / len(sig_a)

                    # Build signatures for all papers
                    all_raw = pubmed_results + scholar_results
                    signatures: list[tuple[dict, list[int]]] = []
                    for p in all_raw:
                        title = (p.get("title") or "").strip().lower()
                        shingles = _shingle(title, k=4)
                        sig = _minhash(shingles, num_perm=64)
                        signatures.append((p, sig))

                    # LSH dedup: keep paper only if no existing paper has
                    # Jaccard similarity > 0.5 (catches rephrased/near-duplicate titles)
                    LSH_THRESHOLD = 0.5
                    seen_dois: set[str] = set()
                    all_papers: list[dict] = []
                    kept_sigs: list[list[int]] = []

                    for paper, sig in signatures:
                        doi = (paper.get("doi") or "").strip().lower()

                        # Exact DOI dedup
                        if doi and doi in seen_dois:
                            continue

                        # LSH near-duplicate check against kept papers
                        is_dup = False
                        for existing_sig in kept_sigs:
                            if _jaccard_minhash(sig, existing_sig) > LSH_THRESHOLD:
                                is_dup = True
                                break

                        if is_dup:
                            continue

                        if doi:
                            seen_dois.add(doi)
                        all_papers.append(paper)
                        kept_sigs.append(sig)

                    # Classify source type and build structured sources
                    GUIDELINE_KEYWORDS = {"guideline", "recommendation", "consensus", "statement", "standard", "protocol", "practice"}
                    REVIEW_KEYWORDS = {"review", "meta-analysis", "systematic", "overview"}

                    for i, paper in enumerate(all_papers[:12]):
                        title_lower = (paper.get("title") or "").lower()
                        journal_lower = (paper.get("journal") or "").lower()

                        # Classify reference type
                        if any(kw in title_lower for kw in GUIDELINE_KEYWORDS):
                            ref_type = "guideline"
                        elif any(kw in title_lower for kw in REVIEW_KEYWORDS):
                            ref_type = "review"
                        elif "cochrane" in journal_lower:
                            ref_type = "review"
                        else:
                            ref_type = "research"

                        # Determine source database
                        source_db = "PubMed" if paper in pubmed_results else "Semantic Scholar"

                        authors_raw = paper.get("authors", "")
                        if isinstance(authors_raw, list):
                            authors_str = ", ".join(authors_raw[:5])
                        else:
                            authors_str = str(authors_raw)[:120]

                        structured_sources.append({
                            "type": ref_type,
                            "title": paper.get("title", ""),
                            "authors": paper.get("authors", ""),
                            "journal": paper.get("journal", ""),
                            "year": paper.get("year", ""),
                            "doi": paper.get("doi", ""),
                            "pmid": paper.get("pmid", ""),
                            "abstract": (paper.get("abstract") or "")[:400],
                            "source_label": source_db,
                            "relevance_score": round(0.95 - (i * 0.04), 2),
                        })

                    # Build context block for LLM with type labels
                    if structured_sources:
                        type_labels = {"guideline": "GUIDELINE", "review": "REVIEW", "research": "RESEARCH"}
                        lines = ["[MEDICAL LITERATURE — cite using [1], [2], etc. Place citation immediately after the claim.]"]
                        for i, s in enumerate(structured_sources):
                            label = type_labels.get(s["type"], "RESEARCH")
                            lines.append(
                                f"[{i+1}] [{label}] {authors_str[:60]}. \"{s['title']}\". "
                                f"{s['journal']}, {s['year']}. "
                                f"{'DOI:'+s['doi'] if s['doi'] else ''}\n"
                                f"    Abstract: {s['abstract'][:250]}"
                            )
                        lines.append("[END LITERATURE]")
                        journal_context = "\n".join(lines)
                except Exception as e:
                    logger.warning("Journal search failed: %s", e)

            # Run both in parallel
            await asyncio.gather(fetch_patient(), search_journals())

            if patient_ctx:
                steps.append({"action": "Patient record loaded", "category": "result"})
                yield await _sse({"step": "Patient record loaded", "detail": steps[-1], "done": False})
            else:
                steps.append({"action": "Could not load patient record", "category": "error"})
                yield await _sse({"step": "Could not load patient record", "detail": steps[-1], "done": False})

            if structured_sources:
                steps.append({"action": f"Found {len(structured_sources)} journal references", "category": "search"})
                yield await _sse({"step": f"Found {len(structured_sources)} journal references", "detail": steps[-1], "done": False})

            # Step 2: Build prompt with citation instructions
            patient_block = ""
            if patient_ctx:
                patient_block = (
                    f"[PATIENT RECORD — LIVE EHR DATA]\n{patient_ctx}\n[END PATIENT RECORD]\n"
                    "Base your response on this live EHR data. Cite specifics."
                )

            citation_instructions = """
CITATION RULES (IMPORTANT — follow strictly):
- You MUST cite medical literature using inline numbered references like [1], [2], [3].
- Place the citation number IMMEDIATELY after the claim it supports.
- Example: "Metformin reduces HbA1c by 1-1.5% [1] and has cardiovascular benefits [2]."
- Cite the literature references provided in the [MEDICAL LITERATURE] block.
- If no literature is provided, still provide evidence-based reasoning.
- Every factual clinical claim should have a citation if literature is available.
"""
            prompt = SYSTEM_PROMPT.format(patient_block=patient_block) + citation_instructions

            msgs = [SystemMessage(content=prompt)]
            if patient_ctx:
                msgs.append(SystemMessage(content=f"[LIVE EHR DATA]\n{patient_ctx}"))
            if journal_context:
                msgs.append(SystemMessage(content=journal_context))
            msgs.append(HumanMessage(content=body.message))

            # Step 3: Stream LLM tokens
            steps.append({"action": "Analyzing clinical query", "category": "thinking"})
            yield await _sse({"step": "Analyzing clinical query", "detail": steps[-1], "done": False})

            llm = ChatOpenAI(
                base_url=settings.sealion_api_url,
                api_key=settings.sealion_api_key,
                model=settings.sealion_model,
                temperature=0.3,
                max_tokens=3000,
                streaming=True,
            )

            full_content = ""
            async for chunk in llm.astream(msgs):
                token = chunk.content or ""
                if token:
                    full_content += token
                    yield await _sse({"type": "llm_token", "content": token, "done": False})

            steps.append({"action": "Clinical assessment ready", "category": "result"})

            # Extract thinking
            thinking = None
            think_match = _THINK_RE.search(full_content)
            if think_match:
                thinking = think_match.group(0).removeprefix("<think>").removesuffix("</think>").strip()

            yield await _sse({
                "content": _clean_thinking(full_content),
                "thinking": thinking,
                "sources": [],
                "structured_sources": structured_sources,
                "steps": steps,
                "agent": "doctor-cds-agent",
                "done": True,
            })

        except Exception:
            logger.exception("Doctor chat stream error")
            yield await _sse({
                "content": "CDS service error. Please try again.",
                "done": True,
            })

    return StreamingResponse(event_generator(), media_type="text/event-stream")


@router.post("/openemr/sessions/{session_id}/chat/sync")
async def doctor_chat_sync(
    session_id: str,
    body: DoctorChatRequest,
    request: Request,
) -> dict[str, Any]:
    """OpenEMR doctor chat — synchronous response (non-streaming)."""
    result = await handle_request(
        query=body.message,
        patient_id=body.patient_id,
        surface=Surface.OPENEMR,
        session_id=f"doctor-{session_id}",
        context={"trigger": "doctor-chat"},
    )

    return {
        "content": _clean_thinking(result.get("response", "")),
        "sources": result.get("sources", []),
        "steps": result.get("steps", []),
        "agent": result.get("agent"),
        "status": result.get("status", "ok"),
    }


# ── SOAP Note Draft Generation ───────────────────────────────────────────


class SOAPGenerateRequest(BaseModel):
    patient_id: str = Field(description="Patient ID (FHIR UUID or OpenEMR PID)")
    subjective: str = Field(description="Subjective section written by clinician")
    objective: str = Field(default="", description="Optional existing Objective text")
    encounter_id: str = Field(default="", description="Optional encounter ID for context")


class SOAPGenerateResponse(BaseModel):
    objective: str = Field(description="Draft Objective section")
    assessment: str = Field(description="Draft Assessment section")
    plan: str = Field(description="Draft Plan section")
    confidence: str = Field(description="high | medium | low")
    data_sources: list[str] = Field(default_factory=list)
    caveats: list[str] = Field(default_factory=list)


@router.post("/openemr/soap/generate", response_model=SOAPGenerateResponse)
async def generate_soap_draft(body: SOAPGenerateRequest) -> SOAPGenerateResponse:
    """Generate draft OAP sections from clinician's Subjective input.

    Uses patient FHIR data from both Medplum and OpenEMR to ground the
    Objective, Assessment, and Plan in real clinical evidence.
    """
    from agent.agents.doctor_cds import _fetch_patient_summary, _run_async
    from agent.config import settings
    from langchain_openai import ChatOpenAI
    from langchain_core.messages import SystemMessage, HumanMessage

    # Fetch patient context from both FHIR sources
    try:
        patient_ctx = _run_async(_fetch_patient_summary(body.patient_id))
    except Exception as e:
        logger.warning("SOAP generate: patient fetch failed: %s", e)
        patient_ctx = ""

    # Build the SOAP generation prompt
    soap_system = """\
You are **Med-SEAL SOAP Assistant**, an AI clinical documentation tool for clinicians.

TASK: Given the clinician's **Subjective** section and the patient's **EHR data**, generate
draft **Objective**, **Assessment**, and **Plan** sections for a SOAP note.

RULES:
- The Objective section should include relevant physical exam findings and vital signs
  based on the chief complaint. Include specific measurements from EHR data when available.
- The Assessment section should synthesise the subjective complaint with objective data,
  list differential diagnoses ranked by likelihood, and cite specific EHR evidence.
- The Plan section should include diagnostic workup, treatment, follow-up, and patient education.
- Cite actual EHR values: "HbA1c 7.2% (2026-02-15)" not "HbA1c is elevated."
- If EHR data is sparse, state what additional data is needed.
- These are DRAFTS for clinician review — clearly state this.
- NEVER fabricate data not present in the EHR context.

RESPOND IN EXACTLY THIS JSON FORMAT (no markdown, no extra text):
{
  "objective": "Pain:\\n...",
  "assessment": "1. ...\\n2. ...",
  "plan": "Diagnostics:\\n...\\nTreatment:\\n...\\nFollow-up:\\n...",
  "confidence": "high|medium|low",
  "caveats": ["list of caveats"]
}"""

    user_msg = f"""SUBJECTIVE (written by clinician):
{body.subjective}
"""
    if body.objective:
        user_msg += f"""
EXISTING OBJECTIVE (clinician-entered):
{body.objective}
"""
    if patient_ctx:
        user_msg += f"""
[PATIENT EHR DATA]
{patient_ctx}
[END EHR DATA]
"""
    user_msg += """
Generate the draft SOAP OAP sections. Respond ONLY with the JSON object."""

    llm = ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=0.3,
        max_tokens=2048,
    )

    # LangFuse tracing for SOAP generation
    invoke_kwargs: dict[str, Any] = {}
    try:
        if settings.langfuse_enabled:
            from agent.core.orchestrator import _ensure_langfuse_env
            _ensure_langfuse_env()
            from langfuse.langchain import CallbackHandler as LangfuseHandler
            lf_handler = LangfuseHandler()
            invoke_kwargs["config"] = {
                "callbacks": [lf_handler],
                "metadata": {
                    "langfuse_user_id": body.patient_id,
                    "agent_id": "soap-generator",
                    "encounter_id": body.encounter_id,
                },
            }
    except Exception as _lf_exc:
        logger.warning("LangFuse handler init FAILED (SOAP): %s", _lf_exc)

    try:
        response = llm.invoke(
            [SystemMessage(content=soap_system), HumanMessage(content=user_msg)],
            **invoke_kwargs,
        )

        content = response.content.strip()
        # Strip thinking tags if present
        content = _clean_thinking(content)

        # Try to parse as JSON
        import json as json_mod
        # Find JSON object in response
        start = content.find("{")
        end = content.rfind("}") + 1
        if start >= 0 and end > start:
            parsed = json_mod.loads(content[start:end])
        else:
            # Fallback: return raw content as assessment
            parsed = {
                "objective": "",
                "assessment": content,
                "plan": "",
                "confidence": "low",
                "caveats": ["Could not parse structured response"],
            }

        data_sources = ["Medplum FHIR"]
        if settings.openemr_fhir_url:
            data_sources.append("OpenEMR FHIR")

        return SOAPGenerateResponse(
            objective=parsed.get("objective", ""),
            assessment=parsed.get("assessment", ""),
            plan=parsed.get("plan", ""),
            confidence=parsed.get("confidence", "medium"),
            data_sources=data_sources,
            caveats=parsed.get("caveats", [
                "AI-generated draft — must be reviewed and edited by the treating clinician.",
            ]),
        )

    except Exception as e:
        logger.exception("SOAP generation failed")
        raise HTTPException(status_code=500, detail=f"SOAP generation failed: {e}")


# ── CDS Hooks surface ────────────────────────────────────────────────────


@router.post("/cds-services/patient-view", response_model=CDSHookResponse)
async def cds_patient_view(body: CDSHookRequest) -> CDSHookResponse:
    """CDS Hooks patient-view: triggers A5 Insight Synthesis."""
    patient_id = body.context.get("patientId", "")
    if not patient_id:
        return CDSHookResponse(cards=[{
            "summary": "Missing patient ID",
            "indicator": "warning",
            "source": {"label": "Med-SEAL"},
        }])

    result = await handle_request(
        query="Generate pre-visit brief",
        patient_id=patient_id,
        surface=Surface.OPENEMR,
        context={"trigger": "patient-view"},
    )

    if result.get("status") != "ok":
        return CDSHookResponse(cards=[{
            "summary": "Med-SEAL insight generation failed",
            "indicator": "warning",
            "source": {"label": "Med-SEAL"},
            "detail": result.get("response", "Unknown error"),
        }])

    return CDSHookResponse(cards=[{
        "summary": "Med-SEAL Pre-Visit Brief Available",
        "indicator": "info",
        "source": {"label": "Med-SEAL Insight Synthesis Agent"},
        "detail": result.get("response", ""),
    }])


# ── System trigger surface ────────────────────────────────────────────────


@router.post("/triggers/{trigger_type}", response_model=TriggerResponse)
async def fire_trigger(trigger_type: str, body: TriggerRequest) -> TriggerResponse:
    """Manual/cron trigger endpoint for nudge, measurement, PRO scheduling."""
    valid_triggers = {
        "missed_dose", "high_biometric", "daily_checkin",
        "appointment_reminder", "pro_schedule", "engagement_decay",
        "behavioral_anticipation", "measurement_schedule",
    }
    if trigger_type not in valid_triggers:
        raise HTTPException(status_code=400, detail=f"Unknown trigger: {trigger_type}")

    result = await handle_request(
        query=json.dumps(body.context) if body.context else trigger_type,
        patient_id=body.patient_id,
        surface=Surface.SYSTEM,
        context={"trigger_type": trigger_type, **body.context},
    )

    return TriggerResponse(
        status=result.get("status", "error"),
        trigger_type=trigger_type,
        patient_id=body.patient_id,
        result=result,
    )


# ── Admin endpoints ──────────────────────────────────────────────────────


@router.get("/agents")
async def get_agents() -> dict[str, Any]:
    """List all registered agents."""
    agents = list_agents()
    return {"agents": agents, "count": len(agents)}


@router.get("/agents/{agent_id}/health", response_model=AgentHealthResponse)
async def agent_health(agent_id: str) -> AgentHealthResponse:
    """Health check for a specific agent."""
    health_checks = {
        "companion-agent": "agent.agents.companion",
        "clinical-reasoning-agent": "agent.agents.clinical",
        "nudge-agent": "agent.agents.nudge",
        "lifestyle-agent": "agent.agents.lifestyle",
        "insight-synthesis-agent": "agent.agents.insight",
        "measurement-agent": "agent.agents.measurement",
        "previsit-summary-agent": "agent.agents.previsit",
    }

    module_path = health_checks.get(agent_id)
    if not module_path:
        raise HTTPException(status_code=404, detail=f"Unknown agent: {agent_id}")

    try:
        import importlib
        mod = importlib.import_module(module_path)
        result = await mod.health_check()
        return AgentHealthResponse(
            agent_id=agent_id,
            status=result.get("status", "unknown"),
            details=result,
        )
    except Exception as exc:
        return AgentHealthResponse(
            agent_id=agent_id,
            status="error",
            details={"error": str(exc)},
        )


# ── Health check ──────────────────────────────────────────────────────────


@router.get("/health", response_model=HealthResponse)
async def health(request: Request) -> HealthResponse:
    vllm_status = "ok"
    redis_status = "ok"
    medplum_status = "unknown"

    try:
        import httpx
        async with httpx.AsyncClient(timeout=5) as client:
            r = await client.get(f"{request.app.state.settings.vllm_url}/health")
            if r.status_code != 200:
                vllm_status = f"unhealthy ({r.status_code})"
    except Exception as exc:
        vllm_status = f"unreachable ({exc})"

    try:
        checkpointer = request.app.state.checkpointer
        if hasattr(checkpointer, "conn") and hasattr(checkpointer.conn, "ping"):
            await checkpointer.conn.ping()
    except Exception as exc:
        redis_status = f"unreachable ({exc})"

    try:
        from agent.tools.fhir_client import get_medplum
        medplum_status = "ok" if await get_medplum().ping() else "unreachable"
    except Exception:
        medplum_status = "not_configured"

    overall = "ok"
    if vllm_status != "ok" or redis_status != "ok":
        overall = "degraded"

    return HealthResponse(
        status=overall,
        vllm=vllm_status,
        redis=redis_status,
        medplum=medplum_status,
    )


# ── Guard health (safety monitoring) ───────────────────────────────


@router.get("/guard/health", tags=["admin"])
async def guard_health():
    """SEA-Guard safety layer health metrics."""
    from agent.core.guard import get_seaguard_stats
    return get_seaguard_stats()


# ── Patient feedback endpoint ──────────────────────────────────────


class FeedbackRequest(BaseModel):
    rating: int = Field(ge=1, le=5, description="1-5 star rating")
    flag: str = Field(default="", description="'incorrect', 'harmful', 'unhelpful', or ''")
    comment: str = Field(default="", max_length=1000)
    message_content: str = Field(default="", description="The response being rated")


@router.post("/sessions/{session_id}/feedback", tags=["feedback"])
async def submit_feedback(session_id: str, body: FeedbackRequest):
    """Submit patient/clinician feedback on a response."""
    from datetime import datetime, timezone
    import aiosqlite, os

    db_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "medseal_sessions.db",
    )
    try:
        async with aiosqlite.connect(db_path) as db:
            await db.execute(
                "CREATE TABLE IF NOT EXISTS response_feedback ("
                "  id INTEGER PRIMARY KEY AUTOINCREMENT,"
                "  session_id TEXT NOT NULL,"
                "  rating INTEGER NOT NULL,"
                "  flag TEXT DEFAULT '',"
                "  comment TEXT DEFAULT '',"
                "  message_content TEXT DEFAULT '',"
                "  created_at TEXT NOT NULL"
                ")",
            )
            await db.execute(
                "INSERT INTO response_feedback "
                "(session_id, rating, flag, comment, message_content, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?)",
                (session_id, body.rating, body.flag, body.comment,
                 body.message_content[:500], datetime.now(timezone.utc).isoformat()),
            )
            await db.commit()
        return {"status": "ok", "session_id": session_id}
    except Exception as exc:
        logger.warning("Feedback save failed: %s", exc)
        raise HTTPException(status_code=500, detail="Failed to save feedback")


@router.get("/feedback/summary", tags=["admin"])
async def feedback_summary(days: int = 7):
    """Summary of recent feedback for evaluation."""
    import aiosqlite, os

    db_path = os.path.join(
        os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))),
        "medseal_sessions.db",
    )
    try:
        async with aiosqlite.connect(db_path) as db:
            db.row_factory = aiosqlite.Row
            cursor = await db.execute(
                "SELECT rating, flag, COUNT(*) as cnt FROM response_feedback "
                "WHERE created_at >= datetime('now', ?) GROUP BY rating, flag "
                "ORDER BY rating",
                (f"-{days} days",),
            )
            rows = await cursor.fetchall()
            cursor2 = await db.execute(
                "SELECT * FROM response_feedback WHERE flag != '' "
                "ORDER BY created_at DESC LIMIT 20",
            )
            flagged = [dict(r) for r in await cursor2.fetchall()]
        return {
            "distribution": [dict(r) for r in rows],
            "flagged_responses": flagged,
            "period_days": days,
        }
    except Exception:
        return {"distribution": [], "flagged_responses": [], "period_days": days}


# ── Tool audit (F2) ─────────────────────────────────────────────────


@router.get("/audit/tools/{patient_id}", tags=["admin"])
async def get_tool_audit(patient_id: str, limit: int = 50):
    """Return recent tool execution audit entries for a patient."""
    from agent.core.audit import get_patient_audit

    entries = await get_patient_audit(patient_id, limit=limit)
    return {"entries": entries, "count": len(entries)}


# ── Clinical task tracking (F3) ─────────────────────────────────────


@router.get("/tasks/{session_id}", tags=["admin"])
async def get_session_tasks(session_id: str, request: Request):
    """Return clinical task lifecycle entries for a session."""
    tracker = getattr(request.app.state, "task_tracker", None)
    if not tracker:
        raise HTTPException(status_code=503, detail="Task tracker not initialised")
    tasks = await tracker.get_tasks(session_id)
    return {"tasks": [t.to_dict() for t in tasks], "count": len(tasks)}
