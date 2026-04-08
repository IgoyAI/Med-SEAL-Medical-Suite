"""O1: Rule-based Orchestrator — request routing and FHIR Task lifecycle.

Receives validated inputs from the Guard, classifies intent, creates
FHIR Task resources, routes to the appropriate agent, collects responses,
and coordinates output-guard validation before persistence.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any

from langchain_core.messages import HumanMessage
from langgraph.checkpoint.memory import MemorySaver

from agent.config import settings
from agent.core.guard import Decision, input_gate, output_gate
from agent.tools.fhir_client import get_medplum

logger = logging.getLogger(__name__)

_TIMEOUT = 90.0


def _ensure_langfuse_env() -> None:
    """Set standard LANGFUSE_* env vars from app settings (Langfuse v4 SDK reads these)."""
    import os
    if not os.environ.get("LANGFUSE_PUBLIC_KEY"):
        os.environ["LANGFUSE_PUBLIC_KEY"] = settings.langfuse_public_key
    if not os.environ.get("LANGFUSE_SECRET_KEY"):
        os.environ["LANGFUSE_SECRET_KEY"] = settings.langfuse_secret_key
    if not os.environ.get("LANGFUSE_HOST"):
        os.environ["LANGFUSE_HOST"] = settings.langfuse_host

# Task tracker (F3) — set via set_task_tracker() from main.py
_task_tracker = None


def set_task_tracker(tracker) -> None:
    global _task_tracker
    _task_tracker = tracker


def get_task_tracker():
    return _task_tracker


class Surface(str, Enum):
    PATIENT_APP = "patient_app"
    OPENEMR = "openemr"
    SYSTEM = "system"


class AgentId(str, Enum):
    COMPANION = "companion-agent"
    CLINICAL = "clinical-reasoning-agent"
    NUDGE = "nudge-agent"
    LIFESTYLE = "lifestyle-agent"
    INSIGHT = "insight-synthesis-agent"
    MEASUREMENT = "measurement-agent"
    PREVISIT = "previsit-summary-agent"
    DOCTOR_CDS = "doctor-cds-agent"


@dataclass
class Route:
    agent: AgentId
    delegation: AgentId | None = None
    priority: str = "routine"
    signal_to: AgentId | None = None
    bypass_delegation: bool = False


# ── Intent classification (LLM-based via Qwen 3.6 Plus) ─────────────────

# Emergency regex kept as a safety fast-path — must not wait for LLM
_EMERGENCY_RE = re.compile(
    r"\b(chest\s+pain|cannot\s+breathe|difficulty\s+breathing|stroke|"
    r"heart\s+attack|faint|unconscious|sakit\s+dada|sesak\s+nafas|"
    r"suicide|kill\s+myself|want\s+to\s+die|self[-\s]?harm|"
    r"胸痛|呼吸困难|中风|自杀)\b",
    re.IGNORECASE,
)

_ROUTER_SYSTEM_PROMPT = """\
You are an intent classifier for Med-SEAL, a multilingual health assistant \
for chronic disease patients in Singapore and Southeast Asia.

Given a patient message, classify it into EXACTLY ONE of these intents:

- **emergency**: Life-threatening situation (chest pain, stroke, cannot breathe, suicidal ideation)
- **appointment**: Booking, cancelling, rescheduling, listing appointments, seeing a doctor
- **previsit**: Preparing for an upcoming visit, pre-visit summary requests
- **clinical**: Drug interactions, side effects, dosage questions, lab results, diagnosis explanations, medication info
- **dietary**: Food, diet, nutrition, exercise, weight, culturally-specific meals (nasi lemak, roti prata, etc.)
- **ehr**: Asking about their own health records — "what medications am I on", "my conditions", "my lab results"
- **greeting**: Simple hello/hi/hey with no health question attached
- **general**: Any other health-related conversation that doesn't fit the above

Respond with ONLY a JSON object, nothing else:
{"intent": "<one of the intents above>"}"""

_ROUTER_INTENT_TO_ROUTE: dict[str, Route] = {
    "emergency": Route(agent=AgentId.COMPANION, priority="immediate", bypass_delegation=True),
    "appointment": Route(agent=AgentId.COMPANION, bypass_delegation=True),
    "previsit": Route(agent=AgentId.PREVISIT, bypass_delegation=True),
    "clinical": Route(agent=AgentId.COMPANION, delegation=AgentId.CLINICAL),
    "dietary": Route(agent=AgentId.COMPANION, delegation=AgentId.LIFESTYLE),
    "ehr": Route(agent=AgentId.COMPANION, bypass_delegation=True),
    "greeting": Route(agent=AgentId.COMPANION, bypass_delegation=True),
    "general": Route(agent=AgentId.COMPANION),
}

_LLM_ROUTER_TIMEOUT = 8.0


async def _llm_classify_patient_intent(query: str) -> Route:
    """Classify patient intent using Qwen 3.6 Plus via OpenRouter."""
    import httpx

    try:
        async with httpx.AsyncClient(timeout=_LLM_ROUTER_TIMEOUT) as client:
            resp = await client.post(
                "https://openrouter.ai/api/v1/chat/completions",
                headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                json={
                    "model": settings.openrouter_model,
                    "messages": [
                        {"role": "system", "content": _ROUTER_SYSTEM_PROMPT},
                        {"role": "user", "content": query[:500]},
                    ],
                    "max_tokens": 30,
                    "temperature": 0.0,
                },
            )
            resp.raise_for_status()
            answer = resp.json()["choices"][0]["message"]["content"].strip()

            # Parse JSON from response
            match = re.search(r"\{.*\}", answer, re.DOTALL)
            if match:
                parsed = json.loads(match.group())
                intent = parsed.get("intent", "").lower().strip()
            else:
                intent = answer.lower().strip().strip('"')

            route = _ROUTER_INTENT_TO_ROUTE.get(intent)
            if route:
                logger.info("LLM router: %r → %s", query[:60], intent)
                return route

            logger.warning("LLM router: unrecognized intent %r, defaulting to companion", intent)
            return Route(agent=AgentId.COMPANION)

    except Exception as exc:
        logger.warning("LLM router failed (%s), defaulting to companion", exc)
        return Route(agent=AgentId.COMPANION)


async def classify_intent(query: str, surface: Surface, context: dict | None = None) -> Route:
    """Intent classification — LLM-based for patients, rule-based for system surfaces."""
    ctx = context or {}

    if surface == Surface.PATIENT_APP:
        # Safety fast-path: emergencies bypass LLM for zero-latency response
        if _EMERGENCY_RE.search(query):
            return Route(agent=AgentId.COMPANION, priority="immediate", bypass_delegation=True)
        return await _llm_classify_patient_intent(query)

    if surface == Surface.OPENEMR:
        trigger = ctx.get("trigger", "")
        if trigger == "patient-view":
            return Route(agent=AgentId.INSIGHT)
        if trigger == "order-sign":
            return Route(agent=AgentId.CLINICAL)
        if trigger == "doctor-chat":
            return Route(agent=AgentId.DOCTOR_CDS)
        return Route(agent=AgentId.DOCTOR_CDS)

    if surface == Surface.SYSTEM:
        trigger_type = ctx.get("trigger_type", "")
        if trigger_type in ("missed_dose", "high_biometric", "engagement_decay",
                            "daily_checkin", "appointment_reminder"):
            return Route(agent=AgentId.NUDGE)
        if trigger_type == "measurement_schedule":
            return Route(agent=AgentId.MEASUREMENT)
        if trigger_type == "pro_schedule":
            return Route(agent=AgentId.NUDGE, signal_to=AgentId.COMPANION)
        return Route(agent=AgentId.NUDGE)

    return Route(agent=AgentId.COMPANION)


# ── FHIR Task lifecycle ──────────────────────────────────────────────────


async def _create_task(patient_id: str, route: Route, query: str) -> dict:
    """Create a FHIR Task to track this request."""
    try:
        fhir = get_medplum()
        task = await fhir.create("Task", {
            "resourceType": "Task",
            "status": "in-progress",
            "intent": "order",
            "priority": route.priority,
            "code": {"text": f"route-to-{route.agent.value}"},
            "for": {"reference": f"Patient/{patient_id}"},
            "owner": {"reference": f"Device/medseal-orchestrator"},
            "input": [{"type": {"text": "query"}, "valueString": query}],
            "authoredOn": datetime.now(timezone.utc).isoformat(),
        })
        return task
    except Exception:
        logger.exception("Failed to create FHIR Task")
        return {"id": "local-fallback", "status": "in-progress"}


async def _complete_task(task_id: str, status: str = "completed", output: str = "") -> None:
    if task_id == "local-fallback":
        return
    try:
        fhir = get_medplum()
        existing = await fhir.read("Task", task_id)
        existing["status"] = status
        existing["output"] = [{"type": {"text": "result"}, "valueString": output[:500]}]
        existing["lastModified"] = datetime.now(timezone.utc).isoformat()
        await fhir.update("Task", task_id, existing)
    except Exception:
        logger.debug("Could not update FHIR Task %s (non-critical)", task_id)


# ── Agent registry (populated at startup) ─────────────────────────────────

_compiled_graphs: dict[str, Any] = {}


def register_agent(agent_id: str, compiled_graph: Any) -> None:
    """Register a compiled LangGraph for an agent."""
    _compiled_graphs[agent_id] = compiled_graph
    logger.info("Registered agent: %s", agent_id)


def get_agent(agent_id: str) -> Any:
    graph = _compiled_graphs.get(agent_id)
    if graph is None:
        raise ValueError(f"Agent '{agent_id}' not registered")
    return graph


def list_agents() -> list[str]:
    return list(_compiled_graphs.keys())


# ── Delegation helper ─────────────────────────────────────────────────────


async def call_agent(
    agent_id: str,
    query: str,
    patient_id: str,
    thread_id: str | None = None,
    extra_state: dict | None = None,
) -> dict:
    """Invoke a registered agent and return response + metadata."""
    graph = get_agent(agent_id)
    config = {"configurable": {"thread_id": thread_id or f"delegation-{agent_id}-{patient_id}"}}

    # LangFuse tracing (v4: uses LANGFUSE_* env vars, metadata via langchain config)
    try:
        if settings.langfuse_enabled:
            _ensure_langfuse_env()
            from langfuse.langchain import CallbackHandler as LangfuseHandler
            lf_handler = LangfuseHandler()
            config["callbacks"] = [lf_handler]
            config.setdefault("metadata", {}).update({
                "langfuse_session_id": thread_id,
                "langfuse_user_id": patient_id,
                "agent_id": agent_id,
            })
            logger.info("LangFuse callback attached for agent=%s session=%s", agent_id, thread_id)
    except Exception as _lf_exc:
        logger.warning("LangFuse handler init FAILED: %s", _lf_exc)

    state: dict[str, Any] = {
        "messages": [HumanMessage(content=query)],
        "patient_id": patient_id,
    }
    if extra_state:
        state.update(extra_state)

    try:
        result = await asyncio.wait_for(
            graph.ainvoke(state, config=config),
            timeout=_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logger.error("Agent %s timed out after %.0fs", agent_id, _TIMEOUT)
        return {"content": json.dumps({"error": "timeout", "agent": agent_id}), "sources": [], "steps": []}

    messages = result.get("messages", [])

    sources = result.get("sources", [])
    structured_sources = result.get("structured_sources", [])
    steps = result.get("steps", [])

    if not sources:
        try:
            from agent.agents.companion import extract_sources_from_messages
            sources = extract_sources_from_messages(messages)
        except Exception:
            pass

    content = ""
    for msg in reversed(messages):
        if hasattr(msg, "content") and msg.content:
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            break

    return {"content": content, "sources": sources,
            "structured_sources": structured_sources, "steps": steps}


# ── Main orchestration flow ───────────────────────────────────────────────


_session_last: dict[str, tuple[float, dict]] = {}
_SESSION_DEDUP_TTL = 3.0
_SESSION_CACHE_MAX = 1000


async def handle_request(
    query: str,
    patient_id: str,
    surface: Surface,
    session_id: str | None = None,
    context: dict | None = None,
) -> dict:
    """End-to-end orchestration: guard -> route -> agent -> guard -> persist."""
    import time
    now = time.time()

    # Evict stale entries to prevent unbounded growth
    if len(_session_last) > _SESSION_CACHE_MAX:
        stale = [k for k, (t, _) in _session_last.items() if now - t > _SESSION_DEDUP_TTL]
        for k in stale:
            del _session_last[k]
        # If still over limit, drop oldest half
        if len(_session_last) > _SESSION_CACHE_MAX:
            by_age = sorted(_session_last, key=lambda k: _session_last[k][0])
            for k in by_age[:len(by_age) // 2]:
                del _session_last[k]

    if session_id:
        if session_id in _session_last:
            cached_time, _ = _session_last[session_id]
            if now - cached_time < _SESSION_DEDUP_TTL:
                logger.info("Session dedup: suppressing duplicate for session=%s (%.1fs ago)", session_id, now - cached_time)
                return {"status": "dedup"}

    # F3: Create clinical task
    _ct = None
    if _task_tracker:
        from agent.core.task_tracker import TaskStatus
        _ct = await _task_tracker.create(session_id or "no-session", patient_id, query)

    # 1. Input guard
    if _ct:
        await _task_tracker.update_status(_ct.task_id, TaskStatus.INPUT_GUARD)
    guard_in = await input_gate(query, patient_id=patient_id, surface=surface.value)
    if guard_in.decision == Decision.BLOCK:
        from agent.core.identity import AGENT_FULL_NAME
        block_msg = (
            f"I'm {AGENT_FULL_NAME}. I'm unable to process that request. "
            "If you have a health-related question, I'm happy to help."
        )
        if guard_in.reasons:
            for r in guard_in.reasons:
                if "identity" in r.lower() or "I am" in r:
                    block_msg = r
                    break
                if "scope" in r.lower():
                    block_msg = r
                    break
        return {
            "status": "blocked",
            "reasons": guard_in.reasons,
            "response": block_msg,
        }
    effective_query = guard_in.content

    # 1b. Crisis — prepend crisis resources to the agent call
    if guard_in.is_crisis:
        from agent.core.identity import CRISIS_RESPONSE
        logger.warning("CRISIS detected for patient=%s — prepending helplines", patient_id)
        effective_query = (
            f"[SYSTEM CRISIS OVERRIDE — The patient may be in distress. "
            f"You MUST lead your response with empathy and these helplines: "
            f"SOS 1-767, IMH 6389-2222, Emergency 995. Do NOT diagnose.]\n\n{effective_query}"
        )

    # 1c. Medical emergency — flag for immediate 995 response
    if guard_in.is_emergency:
        from agent.core.identity import EMERGENCY_DISCLAIMER_EN
        logger.info("EMERGENCY keywords detected for patient=%s", patient_id)
        effective_query = (
            f"[SYSTEM EMERGENCY — The patient may be experiencing a medical emergency. "
            f"You MUST tell them to call 995 (Singapore) or go to the nearest Emergency Department "
            f"IMMEDIATELY before providing any other information.]\n\n{effective_query}"
        )

    # 2. Route
    if _ct:
        await _task_tracker.update_status(_ct.task_id, TaskStatus.ROUTING,
                                          guard_input_decision=guard_in.decision.value)
    route = await classify_intent(effective_query, surface, context)
    logger.info(
        "Routing: surface=%s agent=%s delegation=%s priority=%s",
        surface.value, route.agent.value,
        route.delegation.value if route.delegation else None,
        route.priority,
    )

    # 3. Create FHIR Task
    task = await _create_task(patient_id, route, effective_query)
    task_id = task.get("id", "unknown")

    # 4. Call primary agent
    sources: list[str] = []
    structured_sources: list[dict] = []
    steps: list[dict] = []
    try:
        extra = {}
        if route.agent == AgentId.NUDGE:
            extra["trigger_type"] = (context or {}).get("trigger_type", "manual")
            extra["trigger_context"] = effective_query
            extra["severity"] = route.priority

        if _ct:
            await _task_tracker.update_status(_ct.task_id, TaskStatus.AGENT_RUNNING,
                                              agent_id=route.agent.value)
        agent_result = await call_agent(
            route.agent.value,
            effective_query,
            patient_id,
            thread_id=session_id,
            extra_state=extra,
        )
        response = agent_result["content"]
        sources = agent_result.get("sources", [])
        structured_sources = agent_result.get("structured_sources", [])
        steps = agent_result.get("steps", [])

        # Delegation is now handled inside the companion's ReAct tool
        # loop via delegate_to_clinical / delegate_to_lifestyle tools.
        # No orchestrator-level JSON parsing needed.

    except Exception as _exc:
        logger.exception("Agent %s failed", route.agent.value)
        if _ct:
            await _task_tracker.update_status(_ct.task_id, TaskStatus.FAILED,
                                              error=str(_exc)[:200])
        await _complete_task(task_id, status="failed")
        return {
            "status": "error",
            "response": "I'm having trouble right now. Please try again in a moment.",
            "task_id": task_id,
        }

    # 5. Output guard
    if _ct:
        await _task_tracker.update_status(_ct.task_id, TaskStatus.OUTPUT_GUARD)
    guard_out = await output_gate(response, agent_id=route.agent.value, surface=surface.value)
    if guard_out.decision == Decision.BLOCK:
        logger.warning("Output BLOCKED for task %s: %s", task_id, guard_out.reasons)
        response = guard_out.content
    elif guard_out.decision == Decision.MODIFY:
        response = guard_out.content

    # 6. Complete task
    if _ct:
        await _task_tracker.update_status(_ct.task_id, TaskStatus.COMPLETED,
                                          guard_output_decision=guard_out.decision.value)
    await _complete_task(task_id, status="completed", output=response)

    # Deduplicate sources
    seen_sources: set[str] = set()
    unique_sources: list[str] = []
    for s in sources:
        if s not in seen_sources:
            seen_sources.add(s)
            unique_sources.append(s)

    result = {
        "status": "ok",
        "response": response,
        "agent": route.agent.value,
        "task_id": task_id,
        "guard_input": guard_in.decision.value,
        "guard_output": guard_out.decision.value,
        "sources": unique_sources,
        "structured_sources": structured_sources,
        "steps": steps,
    }
    if session_id:
        _session_last[session_id] = (time.time(), result)

    # F4: Background memory extraction
    if settings.memory_enabled and result.get("status") == "ok" and patient_id:
        try:
            from agent.core.memory import extract_memories_background
            from langchain_core.messages import HumanMessage as _HM, AIMessage as _AI
            _msgs = [_HM(content=query), _AI(content=response)]
            asyncio.create_task(
                extract_memories_background(_msgs, patient_id, session_id or "")
            )
        except Exception as _mem_exc:
            logger.debug("Memory extraction trigger failed: %s", _mem_exc)

    return result


# =====================================================================
# Streaming orchestration (F5)
# =====================================================================

async def handle_request_streaming(
    query: str,
    patient_id: str,
    surface: Surface,
    session_id: str | None = None,
    context: dict | None = None,
):
    """Async generator that yields StreamEvents during request processing.

    Same logic as handle_request() but yields real-time events instead
    of returning a final dict.  Used by the ``?events=v2`` SSE endpoint.
    """
    from agent.core.events import EventType, StreamEvent

    # 1. Input guard
    yield StreamEvent(type=EventType.GUARD_CHECK, summary="Checking input safety")
    guard_in = await input_gate(query, patient_id=patient_id, surface=surface.value)

    if guard_in.decision == Decision.BLOCK:
        from agent.core.identity import AGENT_FULL_NAME
        block_msg = (
            f"I'm {AGENT_FULL_NAME}. I'm unable to process that request. "
            "If you have a health-related question, I'm happy to help."
        )
        yield StreamEvent(type=EventType.COMPLETE, content=block_msg, done=True)
        return

    effective_query = guard_in.content
    if guard_in.is_crisis:
        from agent.core.identity import CRISIS_RESPONSE
        effective_query = (
            f"[SYSTEM CRISIS OVERRIDE — The patient may be in distress. "
            f"You MUST lead your response with empathy and these helplines: "
            f"SOS 1-767, IMH 6389-2222, Emergency 995. Do NOT diagnose.]\n\n{effective_query}"
        )
    if guard_in.is_emergency:
        effective_query = (
            f"[SYSTEM EMERGENCY — The patient may be experiencing a medical emergency. "
            f"You MUST tell them to call 995 (Singapore) or go to the nearest Emergency Department "
            f"IMMEDIATELY before providing any other information.]\n\n{effective_query}"
        )

    # 2. Route
    route = await classify_intent(effective_query, surface, context)
    yield StreamEvent(
        type=EventType.AGENT_START,
        agent=route.agent.value,
        summary=f"Routing to {route.agent.value}",
    )

    # 3. Call agent with streaming
    graph = get_agent(route.agent.value)
    if not graph:
        yield StreamEvent(type=EventType.ERROR, content="Agent not available", done=True)
        return

    state = {
        "messages": [HumanMessage(content=effective_query)],
        "patient_id": patient_id,
    }
    config = {"configurable": {"thread_id": session_id or f"stream-{patient_id}"}}

    # LangFuse tracing for streaming path
    try:
        if settings.langfuse_enabled:
            _ensure_langfuse_env()
            from langfuse.langchain import CallbackHandler as LangfuseHandler
            lf_handler = LangfuseHandler()
            config["callbacks"] = [lf_handler]
            config.setdefault("metadata", {}).update({
                "langfuse_session_id": session_id,
                "langfuse_user_id": patient_id,
                "agent_id": route.agent.value,
                "streaming": True,
            })
    except Exception as _lf_exc:
        logger.warning("LangFuse handler init FAILED (streaming): %s", _lf_exc)

    # Human-friendly tool descriptions
    _TOOL_LABELS = {
        "read_patient": "Loading your health profile",
        "read_conditions": "Checking your conditions",
        "read_medications": "Reading your medications",
        "read_recent_observations": "Checking recent vitals",
        "search_slots": "Searching appointment slots",
        "book_slot": "Booking appointment",
        "cancel_booking": "Cancelling appointment",
        "list_appointments": "Loading your appointments",
        "search_webmd": "Searching WebMD",
        "search_mayoclinic": "Searching Mayo Clinic",
        "search_moh_sg": "Searching MOH Singapore",
        "search_healthhub_sg": "Searching HealthHub SG",
        "search_medical_journals": "Searching medical journals",
        "delegate_to_clinical": "Consulting clinical reasoning",
        "delegate_to_lifestyle": "Consulting lifestyle advisor",
    }

    final_content = ""
    v2_steps: list[dict] = []
    v2_sources: list[str] = []
    patient_record_loaded = False
    search_engines: list[str] = []

    # Track <think> state for CoT streaming
    _in_think = False
    _think_buffer = ""  # buffer to detect <think> / </think> tags across chunks
    _TAG_OPEN = "<think>"
    _TAG_CLOSE = "</think>"

    try:
        async for event in graph.astream_events(state, config=config, version="v2"):
            kind = event.get("event", "")
            if kind == "on_chat_model_stream":
                chunk = event.get("data", {}).get("chunk")
                if not chunk:
                    continue

                # OpenRouter reasoning: check additional_kwargs for reasoning_content
                reasoning = None
                if hasattr(chunk, "additional_kwargs"):
                    reasoning = chunk.additional_kwargs.get("reasoning_content") or chunk.additional_kwargs.get("reasoning")
                if reasoning:
                    yield StreamEvent(type=EventType.THINKING_TOKEN, content=reasoning, agent=route.agent.value)
                    continue

                if not (hasattr(chunk, "content") and chunk.content):
                    continue

                raw = chunk.content
                # Handle list content (Qwen 3.6+ returns content blocks)
                if isinstance(raw, list):
                    for block in raw:
                        if isinstance(block, dict):
                            if block.get("type") == "reasoning_content" or "reasoning" in block.get("type", ""):
                                yield StreamEvent(type=EventType.THINKING_TOKEN, content=block.get("content", ""), agent=route.agent.value)
                            elif block.get("type") == "text":
                                _think_buffer += block.get("content", "")
                        elif isinstance(block, str):
                            _think_buffer += block
                    if not _think_buffer:
                        continue
                    raw = ""  # already processed into _think_buffer
                else:
                    _think_buffer += raw

                # Process buffer for think tag transitions
                while _think_buffer:
                    if not _in_think:
                        idx = _think_buffer.find(_TAG_OPEN)
                        if idx == -1:
                            if len(_think_buffer) > len(_TAG_OPEN):
                                emit = _think_buffer[:-(len(_TAG_OPEN) - 1)]
                                _think_buffer = _think_buffer[-(len(_TAG_OPEN) - 1):]
                                if emit:
                                    yield StreamEvent(type=EventType.LLM_TOKEN, content=emit, agent=route.agent.value)
                            break
                        else:
                            if idx > 0:
                                yield StreamEvent(type=EventType.LLM_TOKEN, content=_think_buffer[:idx], agent=route.agent.value)
                            _think_buffer = _think_buffer[idx + len(_TAG_OPEN):]
                            _in_think = True
                    else:
                        idx = _think_buffer.find(_TAG_CLOSE)
                        if idx == -1:
                            if len(_think_buffer) > len(_TAG_CLOSE):
                                emit = _think_buffer[:-(len(_TAG_CLOSE) - 1)]
                                _think_buffer = _think_buffer[-(len(_TAG_CLOSE) - 1):]
                                if emit:
                                    yield StreamEvent(type=EventType.THINKING_TOKEN, content=emit, agent=route.agent.value)
                            break
                        else:
                            if idx > 0:
                                yield StreamEvent(type=EventType.THINKING_TOKEN, content=_think_buffer[:idx], agent=route.agent.value)
                            _think_buffer = _think_buffer[idx + len(_TAG_CLOSE):]
                            _in_think = False
            elif kind == "on_tool_start":
                tool_name = event.get("name", "")
                label = _TOOL_LABELS.get(tool_name, f"Using {tool_name}")
                category = "fhir" if tool_name.startswith("read_") else "search" if "search" in tool_name else "thinking"
                step = {"action": label, "category": category, "tool": tool_name}
                v2_steps.append(step)
                if tool_name.startswith("read_"):
                    patient_record_loaded = True
                if "search" in tool_name:
                    engine = _TOOL_LABELS.get(tool_name, tool_name).replace("Searching ", "")
                    if engine not in search_engines:
                        search_engines.append(engine)
                yield StreamEvent(
                    type=EventType.TOOL_START,
                    tool=tool_name,
                    agent=route.agent.value,
                    summary=label,
                )
            elif kind == "on_tool_end":
                tool_name = event.get("name", "")
                label = _TOOL_LABELS.get(tool_name, tool_name)
                step = {"action": f"{label} complete", "category": "result", "tool": tool_name}
                v2_steps.append(step)
                # Extract sources from tool output
                output = event.get("data", {}).get("output", "")
                if isinstance(output, str) and "http" in output:
                    import re as _re
                    urls = _re.findall(r"https?://[^\s\"']+", output)
                    v2_sources.extend(urls)
                yield StreamEvent(
                    type=EventType.TOOL_END,
                    tool=tool_name,
                    agent=route.agent.value,
                    summary=f"{label} complete",
                )
            elif kind == "on_chain_end":
                output = event.get("data", {}).get("output", {})
                if isinstance(output, dict) and "messages" in output:
                    msgs = output["messages"]
                    if msgs:
                        last = msgs[-1]
                        if hasattr(last, "content"):
                            raw_content = last.content
                            if isinstance(raw_content, str):
                                final_content = raw_content
                            elif isinstance(raw_content, list):
                                # Qwen 3.6+ content blocks
                                parts = []
                                for b in raw_content:
                                    if isinstance(b, dict) and b.get("type") == "text":
                                        parts.append(b.get("content", ""))
                                    elif isinstance(b, str):
                                        parts.append(b)
                                final_content = "".join(parts)
                            else:
                                final_content = str(raw_content)
                        # Collect sources from state
                        if isinstance(output.get("sources"), list):
                            v2_sources.extend(output["sources"])
    except Exception as exc:
        logger.exception("Streaming agent failed: %s", exc)
        yield StreamEvent(
            type=EventType.ERROR,
            content="I'm having trouble right now. Please try again.",
            done=True,
        )
        return

    # Flush remaining think buffer
    if _think_buffer:
        if _in_think:
            yield StreamEvent(type=EventType.THINKING_TOKEN, content=_think_buffer, agent=route.agent.value)
        else:
            yield StreamEvent(type=EventType.LLM_TOKEN, content=_think_buffer, agent=route.agent.value)

    # Add final "composing" step
    v2_steps.append({"action": "Composing response", "category": "thinking"})

    # Ensure final_content is a string (Qwen 3.6+ may return list blocks)
    if isinstance(final_content, list):
        parts = []
        for b in final_content:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("content", ""))
            elif isinstance(b, str):
                parts.append(b)
        final_content = "".join(parts)
    if not isinstance(final_content, str):
        final_content = str(final_content)

    # 4. Output guard
    yield StreamEvent(type=EventType.GUARD_CHECK, summary="Checking output safety")
    guard_out = await output_gate(final_content, agent_id=route.agent.value, surface=surface.value)
    if guard_out.decision in (Decision.BLOCK, Decision.MODIFY):
        final_content = guard_out.content

    # Build rich context for the COMPLETE event
    sources_used = len(set(v2_sources))
    context_label = ""
    if search_engines:
        context_label += f"Searched {', '.join(search_engines)}"
    if patient_record_loaded:
        context_label += (" · " if context_label else "") + "used patient record"
    if not context_label:
        context_label = "Processed"

    # 5. Complete — include full response data like V1
    yield StreamEvent(
        type=EventType.COMPLETE,
        content=final_content,
        agent=route.agent.value,
        done=True,
        metadata={
            "guard_input": guard_in.decision.value,
            "guard_output": guard_out.decision.value,
            "sources": list(set(v2_sources)),
            "steps": v2_steps,
            "context": {
                "label": context_label,
                "sources_used": sources_used,
                "patient_record_loaded": patient_record_loaded,
                "search_engines": search_engines,
                "details": [s["action"] for s in v2_steps],
            },
        },
    )


async def handle_delegation(
    caller_agent: str,
    target_agent: str,
    query: str,
    patient_id: str,
) -> str:
    """Inter-agent delegation (A1->A2, A1->A4, A5->A2, etc.)."""
    logger.info("Delegation: %s -> %s (patient=%s)", caller_agent, target_agent, patient_id)
    return await call_agent(
        target_agent,
        query,
        patient_id,
        extra_state={"caller_agent": caller_agent},
    )
