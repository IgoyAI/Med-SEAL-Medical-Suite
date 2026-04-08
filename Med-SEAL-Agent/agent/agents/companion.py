"""A1: Companion Agent — ReAct agentic loop (Claude Code standard).

Graph topology:
  START → context_loader → agent ⇄ tools → END

The LLM decides which tools to call: patient records, appointments,
medical search, clinical/lifestyle delegation.  No keyword routing,
no regex sanitization — the LLM has full agency.
"""

from __future__ import annotations

import json, logging, re, threading
from typing import Annotated, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from agent.config import settings
from agent.core.reasoning import invoke_with_retry, strip_thinking
from agent.tools.medical_tools import SEARCH_TOOLS, ALL_TOOLS
from agent.tools.journal_tools import JOURNAL_TOOLS, search_medical_journals
from agent.tools.fhir_tools_companion import COMPANION_FHIR_TOOLS
from agent.tools.fhir_tools_appointment import APPOINTMENT_TOOLS

logger = logging.getLogger(__name__)
_URL_RE = re.compile(r"https?://[^\s\]\)\"',]+")


# ── State ────────────────────────────────────────────────────────────────


class CompanionState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str
    language: str
    task_type: str
    search_results: str
    ehr_context: str
    sources: list[str]
    structured_sources: list[dict]
    steps: list[dict]
    appointment_context: str
    cached_slots: list[dict]
    session_memory: dict


# ── Delegation tools ─────────────────────────────────────────────────────


@tool
def delegate_to_clinical(query: str, patient_id: str) -> str:
    """Delegate a complex clinical question to the Clinical Reasoning Agent.

    Use for: drug interactions, side effect analysis, lab result interpretation,
    clinical risk assessment, treatment context questions.

    Args:
        query: The clinical question to answer
        patient_id: The patient's FHIR ID

    Returns: Clinical assessment with evidence and confidence level.
    """
    from agent.core.orchestrator import call_agent
    import asyncio
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(
                asyncio.run,
                call_agent("clinical-reasoning-agent", query, patient_id)
            ).result(timeout=60)
    else:
        result = asyncio.run(
            call_agent("clinical-reasoning-agent", query, patient_id)
        )
    return result.get("content", "Clinical assessment unavailable.")


@tool
def delegate_to_lifestyle(query: str, patient_id: str) -> str:
    """Delegate a dietary or exercise question to the Lifestyle Agent.

    Use for: food recommendations, diet planning, exercise guidance,
    drug-food interactions, culturally-appropriate meal suggestions.

    Args:
        query: The dietary/exercise question
        patient_id: The patient's FHIR ID

    Returns: Structured lifestyle recommendations.
    """
    from agent.core.orchestrator import call_agent
    import asyncio
    try:
        loop = asyncio.get_running_loop()
    except RuntimeError:
        loop = None
    if loop and loop.is_running():
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            result = pool.submit(
                asyncio.run,
                call_agent("lifestyle-agent", query, patient_id)
            ).result(timeout=60)
    else:
        result = asyncio.run(
            call_agent("lifestyle-agent", query, patient_id)
        )
    return result.get("content", "Lifestyle recommendations unavailable.")


@tool
def get_assistant_info() -> str:
    """Return information about Med-SEAL's identity and capabilities.

    Use when the patient asks "who are you", "what can you do", etc.

    Returns: Med-SEAL's self-description.
    """
    from agent.core.identity import build_identity_response
    return build_identity_response("en")


# ── Helpers ──────────────────────────────────────────────────────────────


def _run_async(coro):
    import asyncio
    try:
        asyncio.get_running_loop()
        import concurrent.futures
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            future = pool.submit(_run_in_new_loop, coro)
            return future.result(timeout=25)
    except RuntimeError:
        return asyncio.run(coro)


def _run_in_new_loop(coro):
    import asyncio
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _clean_internal(text) -> str:
    """Strip FHIR IDs, patient IDs, and internal markers from LLM output."""
    # Handle Qwen 3.6+ list content blocks
    if isinstance(text, list):
        parts = []
        for b in text:
            if isinstance(b, dict) and b.get("type") == "text":
                parts.append(b.get("content", ""))
            elif isinstance(b, str):
                parts.append(b)
        text = "".join(parts)
    if not isinstance(text, str):
        text = str(text)
    text = re.sub(r"\[INTERNAL.*?\[END INTERNAL\]", "", text, flags=re.DOTALL)
    text = re.sub(r"Patient ID:\s*[a-f0-9-]{36}", "", text)
    text = re.sub(r"FHIR\s+\w+/[a-f0-9-]+", "", text)
    text = re.sub(r"\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b", "", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


async def _fetch_ehr(patient_id):
    """Fetch basic patient profile from FHIR for context injection."""
    from agent.tools.fhir_client import get_medplum
    fhir = get_medplum()
    parts = []
    try:
        patient = await fhir.read("Patient", patient_id)
        name = patient.get("name", [{}])[0]
        parts.append(f"Name: {' '.join(name.get('given', []))} {name.get('family', '')}")
        parts.append(f"DOB: {patient.get('birthDate', '?')}  Gender: {patient.get('gender', '?')}")
    except Exception:
        parts.append(f"Patient ID: {patient_id}")
    try:
        conditions = await fhir.search("Condition", {"patient": patient_id, "clinical-status": "active"})
        if conditions:
            cl = []
            for c in conditions[:10]:
                t = c.get("code", {}).get("text", "")
                if not t:
                    codings = c.get("code", {}).get("coding", [])
                    t = codings[0].get("display", "?") if codings else "?"
                cl.append(t)
            parts.append(f"Active conditions: {', '.join(cl)}")
    except Exception:
        pass
    try:
        meds = await fhir.search("MedicationRequest", {"patient": patient_id})
        if meds:
            ml = [f"{m.get('medicationCodeableConcept', {}).get('text', '?')} ({m.get('status', '?')})" for m in meds[:10]]
            parts.append(f"Medications: {', '.join(ml)}")
    except Exception:
        pass
    try:
        obs = await fhir.search("Observation", {"patient": patient_id, "_sort": "-date", "_count": "10"})
        if obs:
            ol = []
            for o in obs[:10]:
                ct = o.get("code", {}).get("text", "")
                if not ct:
                    codings = o.get("code", {}).get("coding", [])
                    ct = codings[0].get("display", "?") if codings else "?"
                vq = o.get("valueQuantity", {})
                val = f"{vq.get('value', '?')} {vq.get('unit', '')}".strip() if vq else "?"
                date = o.get("effectiveDateTime", "")[:10]
                ol.append(f"{ct}: {val} ({date})")
            parts.append("Recent observations:\n  " + "\n  ".join(ol))
    except Exception:
        pass
    return "\n".join(parts)


# ── Context engineering ──────────────────────────────────────────────────

_LARGE_CONTENT_THRESHOLD = 500


def _clear_tool_results(messages: list[BaseMessage], keep_recent: int = 4) -> list[BaseMessage]:
    """Replace large old tool results with placeholders to save context."""
    if len(messages) <= keep_recent:
        cleaned = []
        for msg in messages:
            if isinstance(msg, ToolMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                if '"ephemeral": true' in content or '"ephemeral":true' in content:
                    new_msg = ToolMessage(
                        content="[Paper content consumed — use DOI to re-fetch if needed]",
                        tool_call_id=getattr(msg, "tool_call_id", ""),
                    )
                    cleaned.append(new_msg)
                    continue
            cleaned.append(msg)
        return cleaned

    boundary = len(messages) - keep_recent
    cleaned = []
    for i, msg in enumerate(messages):
        if i >= boundary:
            if isinstance(msg, ToolMessage):
                content = msg.content if isinstance(msg.content, str) else str(msg.content)
                if '"ephemeral": true' in content or '"ephemeral":true' in content:
                    new_msg = ToolMessage(
                        content="[Paper content consumed — use DOI to re-fetch if needed]",
                        tool_call_id=getattr(msg, "tool_call_id", ""),
                    )
                    cleaned.append(new_msg)
                    continue
            cleaned.append(msg)
            continue
        if isinstance(msg, ToolMessage):
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            if len(content) > _LARGE_CONTENT_THRESHOLD:
                new_msg = ToolMessage(
                    content="[Previous tool result cleared]",
                    tool_call_id=getattr(msg, "tool_call_id", ""),
                )
                cleaned.append(new_msg)
                continue
        elif isinstance(msg, AIMessage):
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            if len(content) > _LARGE_CONTENT_THRESHOLD and (
                '"resourceType"' in content or "Bundle" in content
            ):
                new_msg = AIMessage(content="[Previous FHIR data summary cleared]")
                cleaned.append(new_msg)
                continue
        cleaned.append(msg)
    return cleaned


_COMPACTION_PROMPT = (
    "Summarize the following medical conversation. Structure your summary:\n"
    "1. PATIENT CONTEXT: name, demographics, key conditions mentioned\n"
    "2. CLINICAL TOPICS: medical issues discussed, symptoms reported\n"
    "3. MEDICATION DISCUSSION: medications mentioned or changes discussed\n"
    "4. APPOINTMENT ACTIONS: bookings, cancellations, upcoming visits\n"
    "5. PATIENT PREFERENCES: expressed preferences, language, communication style\n"
    "6. PENDING ITEMS: unresolved questions, promised follow-ups\n"
    "Maximum 250 words. Preserve all clinical details accurately. "
    "Write in third person.\n\n"
    "Conversation:\n{conversation}"
)

_compaction_lock = threading.Lock()
_compaction_failures: int = 0
_compaction_last_failure: float = 0.0
_COMPACTION_RESET_SECONDS = 600


def _compact_messages(
    messages: list[BaseMessage],
    session_memory: dict,
    keep_recent: int | None = None,
) -> list[BaseMessage]:
    """Summarize old messages when token count exceeds threshold."""
    import time
    from agent.core.token_utils import count_message_tokens

    global _compaction_failures, _compaction_last_failure

    if keep_recent is None:
        keep_recent = settings.compaction_keep_recent

    non_sys = [m for m in messages if not isinstance(m, SystemMessage)]
    token_count = count_message_tokens(non_sys)
    threshold = settings.context_window_tokens - settings.compaction_reserve_tokens

    if token_count < threshold:
        return messages

    with _compaction_lock:
        if _compaction_failures >= settings.compaction_max_failures:
            elapsed = time.time() - _compaction_last_failure
            if elapsed < _COMPACTION_RESET_SECONDS:
                logger.warning(
                    "Compaction circuit breaker open (%d failures, %.0fs ago) — skipping",
                    _compaction_failures, elapsed,
                )
                return messages
            _compaction_failures = 0

    old = non_sys[:-keep_recent]
    recent = non_sys[-keep_recent:]

    conv_lines = []
    for m in old:
        role = "Patient" if isinstance(m, HumanMessage) else "Assistant"
        content = m.content if isinstance(m.content, str) else str(m.content)
        conv_lines.append(f"{role}: {content[:300]}")
    conv_text = "\n".join(conv_lines)

    summary = f"[Earlier conversation had {len(old)} messages but details were not summarized]"
    try:
        prompt_text = _COMPACTION_PROMPT.format(conversation=conv_text[:4000])

        async def _do_compact():
            async with httpx.AsyncClient(timeout=15.0) as client:
                resp = await client.post(
                    f"{settings.sealion_api_url}/chat/completions",
                    headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
                    json={
                        "model": settings.sealion_model,
                        "messages": [{"role": "user", "content": prompt_text}],
                        "max_tokens": settings.compaction_summary_max_tokens,
                        "temperature": 0.0,
                    },
                )
                resp.raise_for_status()
                return resp.json()["choices"][0]["message"]["content"].strip()

        summary = _run_async(_do_compact())
        logger.info("Compacted %d old messages into %d-char summary", len(old), len(summary))
        with _compaction_lock:
            _compaction_failures = 0
    except Exception as e:
        logger.warning("Compaction summarization failed: %s", e)
        with _compaction_lock:
            _compaction_failures += 1
            _compaction_last_failure = time.time()

    summary_msg = SystemMessage(
        content=f"[CONVERSATION SUMMARY — previous {len(old)} messages]\n{summary}"
    )
    return [summary_msg] + recent


def _build_session_context(mem: dict) -> str:
    """Build session context block from session memory for the system prompt."""
    if not mem:
        return ""
    parts = []
    if mem.get("patient_name"):
        parts.append(f"Patient: {mem['patient_name']}")
    if mem.get("conditions_summary"):
        parts.append(f"Conditions: {mem['conditions_summary']}")
    if mem.get("meds_summary"):
        parts.append(f"Medications: {mem['meds_summary']}")
    if mem.get("topics_discussed"):
        parts.append(f"Previously discussed: {', '.join(mem['topics_discussed'][-5:])}")
    if mem.get("appointment_actions"):
        parts.append(f"Recent appointment actions: {'; '.join(mem['appointment_actions'][-3:])}")
    if not parts:
        return ""
    return "[SESSION CONTEXT — do NOT show this to the patient]\n" + "\n".join(parts)


# ── Route to SEA-LION for cultural/empathetic queries ────────────────────

_CULTURAL_KW = re.compile(
    # Emotional/empathetic
    r"\b(scared|worried|anxious|afraid|depressed|sad|overwhelmed|confused|"
    r"frustrated|hopeless|lonely|stressed|tired|exhausted|don'?t\s+know\s+what|"
    # Malay / Indonesian
    r"takut|risau|sedih|bingung|penat|sian|"
    # Chinese
    r"怕|担心|害怕|难过|累|"
    # Tamil
    r"பயம்|கவலை|"
    # SEA cultural food / lifestyle (SEA-LION excels here)
    r"nasi\s+lemak|roti\s+prata|laksa|mee\s+siam|char\s+kway\s+teow|"
    r"bak\s+kut\s+teh|satay|rendang|nasi\s+padang|teh\s+tarik|"
    r"kopitiam|hawker|singlish|"
    # Non-English full messages (detect by script)
    r"[\u4e00-\u9fff]{3,}|[\u0B80-\u0BFF]{3,})\b", re.I)


def _is_empathetic_query(query: str) -> bool:
    """Route to SEA-LION for cultural context, emotional support, or non-English."""
    return bool(_CULTURAL_KW.search(query))


# ══════════════════════════════════════════════════════════════════════════
# System Prompt — Claude Code standard: tool-aware, minimal constraints
# ══════════════════════════════════════════════════════════════════════════

SYSTEM_PROMPT = """\
You are **Med-SEAL AI Health Assistant**, chatting directly with a patient \
in Singapore/Southeast Asia. You speak English, 中文, Bahasa Melayu, and தமிழ்.

APPROACH:
1. ALWAYS start your response with <think>your reasoning here</think> before your answer.
   Inside <think>, explain: what the patient is asking, what data you need, which tools to call, and your reasoning.
   This is MANDATORY for every response — even simple greetings should have brief thinking.
2. Use your tools to gather information — don't guess when you can look it up.
3. Respond warmly and directly using "you/your" — never "the patient/their".
4. ALWAYS cite sources with clickable links when using search results or referencing guidelines.
5. End health responses with: "Please consult your doctor for personalised advice."

CITATION RULES (IMPORTANT — follow Claude's citation style):
- When you use search tools, include the source URLs as inline citations.
- Format: "According to [Source Name](URL), ..." or add a "Sources:" section at the end.
- For Singapore guidelines, cite: [MOH Singapore](https://www.moh.gov.sg), [HealthHub](https://www.healthhub.sg), etc.
- For medical search results, include the actual URLs returned by the search tools.
- Example format at end of response:
  **Sources:**
  - [Mayo Clinic — Diabetes Overview](https://www.mayoclinic.org/diseases/diabetes)
  - [MOH — Clinical Practice Guidelines](https://www.moh.gov.sg/...)
- NEVER fabricate URLs. Only cite URLs returned by your search tools or known official sites.

TOOLS AVAILABLE:
- **Health records**: read_patient, read_conditions, read_medications, read_recent_observations
- **Appointments**: search_slots, book_slot, cancel_booking, list_appointments
- **Medical search**: search_webmd, search_mayoclinic, search_moh_sg, search_healthhub_sg, search_medical_journals
- **Delegation**: delegate_to_clinical (drug interactions, complex clinical Qs), delegate_to_lifestyle (diet, exercise)
- **Identity**: get_assistant_info (when asked "who are you")

WHEN TO USE TOOLS:
- "What medications am I on?" → read_medications
- "Book a cardiologist" → search_slots(specialty="Cardiology")
- "Is metformin safe with grapefruit?" → delegate_to_clinical or search_medical_journals
- "What can I eat?" → delegate_to_lifestyle
- "Show my appointments" → list_appointments
- Simple greetings/thanks → respond directly, no tools needed

IMPORTANT — MEDICATION REPORTING:
- read_medications returns ALL medications (active, completed, stopped).
- Report ALL medications found to the patient — do NOT skip "completed" or "stopped" ones.
- A "completed" status means a past prescription; the patient should still know about it.
- Only say "no medications" if the tool returns an empty list.

SAFETY:
- NEVER diagnose, prescribe, or share raw patient IDs or FHIR data.
- If patient mentions self-harm/suicide → immediately provide: SOS 1-767, IMH 6389-2222, Emergency 995.
- If chest pain, stroke, cannot breathe → tell them to call 995 NOW.
- NEVER fabricate URLs or clinical data.
- NEVER claim to personally "know" the patient. You have access to their health records \
but you are an AI — say "I can access your health records" not "I know you".

{session_context}

{ehr_block}

{memory_block}"""


# ══════════════════════════════════════════════════════════════════════════
# Graph Builder — ReAct loop following Claude Code pattern
# ══════════════════════════════════════════════════════════════════════════


def build_companion_graph():
    """Build the ReAct agentic companion graph.

    Architecture:
      START → context_loader → agent ⇄ tools → END

    The LLM decides which tools to call. No keyword routing.
    """
    # All tools the LLM can call
    ALL_COMPANION_TOOLS = (
        COMPANION_FHIR_TOOLS
        + APPOINTMENT_TOOLS
        + list(ALL_TOOLS)
        + list(JOURNAL_TOOLS)
        + [delegate_to_clinical, delegate_to_lifestyle, get_assistant_info]
    )

    # Primary: Qwen 3.6 Plus via OpenRouter (native reasoning/CoT)
    # Falls back to SEA-LION if OpenRouter key is invalid
    _use_openrouter = bool(settings.openrouter_api_key and len(settings.openrouter_api_key) > 10)
    if _use_openrouter:
        try:
            llm_primary = ChatOpenAI(
                base_url="https://openrouter.ai/api/v1",
                api_key=settings.openrouter_api_key,
                model=settings.openrouter_model,
                temperature=0.3,
                max_tokens=settings.companion_max_tokens,
                model_kwargs={"reasoning": {"effort": "medium"}},
            ).bind_tools(ALL_COMPANION_TOOLS)
            logger.info("Companion primary LLM: OpenRouter %s", settings.openrouter_model)
        except Exception:
            _use_openrouter = False

    if not _use_openrouter:
        llm_primary = ChatOpenAI(
            base_url=settings.sealion_api_url,
            api_key=settings.sealion_api_key,
            model=settings.sealion_model,
            temperature=0.3,
            max_tokens=settings.companion_max_tokens,
        ).bind_tools(ALL_COMPANION_TOOLS)
        logger.info("Companion primary LLM: SEA-LION (OpenRouter unavailable)")

    # Cultural/empathetic: SEA-LION for Singlish, Malay, Tamil, SEA-specific context
    llm_cultural = ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=0.7,
        max_tokens=settings.companion_max_tokens,
    ).bind_tools(ALL_COMPANION_TOOLS)

    tool_node = ToolNode(ALL_COMPANION_TOOLS)

    # ── Node: Context loader (one-time patient profile + memory) ─────

    def context_loader(state: CompanionState) -> dict:
        """Load patient EHR context and session memory.

        Unlike the old auto_fhir + auto_search, this only loads the
        patient profile — search is left to the LLM's tool calls.
        """
        pid = state.get("patient_id", "")
        steps: list[dict] = []
        mem = dict(state.get("session_memory") or {})

        if not pid or pid in ("default-patient", "test-patient-1"):
            return {"ehr_context": "", "steps": steps, "session_memory": mem}

        # Use cached session memory if available
        if mem.get("patient_name") and mem.get("conditions_summary"):
            ehr = (
                f"Patient: {mem['patient_name']}\n"
                f"Active conditions: {mem['conditions_summary']}\n"
                f"Medications: {mem.get('meds_summary', 'unknown')}"
            )
            steps.append({"action": "Health profile loaded (cached)", "category": "result"})
            return {"ehr_context": ehr, "steps": steps, "session_memory": mem}

        # Fetch from FHIR
        steps.append({"action": "Loading your health profile", "category": "fhir"})
        try:
            ehr = _run_async(_fetch_ehr(pid))
            if ehr and len(ehr.strip()) > 10:
                steps.append({"action": "Health profile loaded", "category": "result"})
                for line in ehr.split("\n"):
                    if line.startswith("Name:"):
                        mem["patient_name"] = line.replace("Name:", "").strip()
                    elif line.startswith("Active conditions:"):
                        mem["conditions_summary"] = line.replace("Active conditions:", "").strip()[:200]
                    elif line.startswith("Current medications:"):
                        mem["meds_summary"] = line.replace("Current medications:", "").strip()[:200]
                return {"ehr_context": ehr, "steps": steps, "session_memory": mem}
            steps.append({"action": "No records found", "category": "result"})
            return {"ehr_context": "", "steps": steps, "session_memory": mem}
        except Exception as e:
            logger.warning("FHIR fetch failed: %s", e)
            steps.append({"action": "Could not load health profile", "category": "error"})
            return {"ehr_context": "", "steps": steps, "session_memory": mem}

    # ── Node: Agent (LLM with tool calling + retry) ──────────────────

    def agent_node(state: CompanionState) -> dict:
        """ReAct agent node — LLM decides what tools to call.

        Uses adaptive temperature (empathetic vs factual) and retry
        logic for empty/thinking-only responses.
        """
        ehr = state.get("ehr_context", "")
        mem = dict(state.get("session_memory") or {})

        # Build system prompt with context
        pid = state.get("patient_id", "")
        ehr_block = ""
        if ehr:
            ehr_block = (
                f"[PATIENT PROFILE — do NOT show raw data to the patient]\n"
                f"FHIR Patient ID: {pid}\n"
                f"{ehr[:2000]}\n"
                "Use this to personalize your response.\n"
                f"IMPORTANT: When calling tools that need patient_id, ALWAYS use the exact FHIR ID: {pid}"
            )

        session_context = _build_session_context(mem)

        # Load patient memories from previous sessions
        memory_block = ""
        try:
            from agent.core.memory import get_memory_store, format_memories_for_prompt
            mstore = get_memory_store()
            if mstore and state.get("patient_id"):
                import concurrent.futures, asyncio as _aio
                def _load():
                    return _aio.run(mstore.load_memories(state["patient_id"]))
                with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                    patient_memories = pool.submit(_load).result()
                memory_block = format_memories_for_prompt(patient_memories)
        except Exception as _mem_err:
            logger.debug("Memory load failed (non-fatal): %s", _mem_err)

        prompt = SYSTEM_PROMPT.format(
            ehr_block=ehr_block,
            session_context=session_context,
            memory_block=memory_block,
        )

        # Prepare messages: system prompt first, then conversation
        non_sys = [m for m in state["messages"] if not isinstance(m, SystemMessage)]
        non_sys = _clear_tool_results(non_sys, keep_recent=6)
        non_sys = _compact_messages(non_sys, mem)

        # Separate any system messages from compaction
        sys_msgs = [m for m in non_sys if isinstance(m, SystemMessage)]
        non_sys = [m for m in non_sys if not isinstance(m, SystemMessage)]

        # Get last human message for temperature selection
        query = ""
        for msg in reversed(non_sys):
            if isinstance(msg, HumanMessage):
                query = msg.content if isinstance(msg.content, str) else str(msg.content)
                break

        # Primary: Qwen 3.6 Plus (reasoning). Cultural: SEA-LION (empathetic/SEA context)
        active_llm = llm_cultural if _is_empathetic_query(query) else llm_primary

        # Invoke with retry (Claude Code standard)
        ordered = [SystemMessage(content=prompt)] + sys_msgs + non_sys
        response = invoke_with_retry(active_llm, ordered)

        # Clean internal markers from final response (safety)
        if response.content and not response.tool_calls:
            cleaned = _clean_internal(response.content)
            if cleaned != response.content:
                response = AIMessage(content=cleaned, tool_calls=response.tool_calls or [])

        # Track topics in session memory
        if query:
            topics = mem.get("topics_discussed", [])
            topic_snippet = query[:40].strip()
            if topic_snippet and topic_snippet not in topics:
                topics.append(topic_snippet)
                mem["topics_discussed"] = topics[-10:]

        existing_steps = list(state.get("steps", []))
        if response.tool_calls:
            for tc in response.tool_calls:
                existing_steps.append({
                    "action": f"Using {tc['name']}",
                    "category": "search" if "search" in tc["name"] else "fhir",
                    "tool": tc["name"],
                })
        else:
            existing_steps.append({"action": "Composing response", "category": "thinking"})

        return {
            "messages": [response],
            "steps": existing_steps,
            "session_memory": mem,
        }

    # ── Routing ──────────────────────────────────────────────────────

    def should_continue(state: CompanionState) -> str:
        """Route to tools if LLM made tool calls, otherwise end."""
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    # ── Wire the graph ───────────────────────────────────────────────

    g = StateGraph(CompanionState)
    g.add_node("context_loader", context_loader)
    g.add_node("agent", agent_node)
    g.add_node("tools", tool_node)

    g.add_edge(START, "context_loader")
    g.add_edge("context_loader", "agent")
    g.add_conditional_edges("agent", should_continue, {"tools": "tools", END: END})
    g.add_edge("tools", "agent")

    return g


# ── Exports ──────────────────────────────────────────────────────────────


def extract_sources_from_messages(messages):
    """Extract URLs from tool messages for source tracking."""
    urls, seen = [], set()
    for msg in messages:
        if isinstance(msg, ToolMessage):
            content = msg.content if isinstance(msg.content, str) else str(msg.content)
            for url in _URL_RE.findall(content):
                c = url.rstrip(".,;:)")
                if c not in seen:
                    seen.add(c)
                    urls.append(c)
    return urls


async def health_check():
    """Verify that the SEA-LION backend is reachable for the Companion Agent."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as c:
            r = await c.get(
                f"{settings.sealion_api_url}/models",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
            )
            r.raise_for_status()
            return {"status": "ok", "agent": "companion"}
    except Exception as e:
        return {"status": "error", "agent": "companion", "detail": str(e)}
