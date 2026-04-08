"""A2: Clinical Reasoning Agent — EHR synthesis and clinical decision support.

This agent synthesises electronic health record data to answer clinical
questions: drug interactions, lab interpretation, condition progression,
risk assessment, and treatment context.  It never speaks directly to
patients — it returns structured JSON to A1 or A5.

Graph topology:
  START → auto_evidence → system_prompt_node → llm_node ⇄ tool_node → END
"""

from __future__ import annotations

import json
import logging
import re
from typing import Annotated, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from agent.config import settings
from agent.tools.fhir_tools_clinical import CLINICAL_FHIR_TOOLS
from agent.tools.journal_tools import JOURNAL_TOOLS, search_medical_journals

logger = logging.getLogger(__name__)

# ── State ────────────────────────────────────────────────────────────


class ClinicalState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str
    caller_agent: str
    evidence_context: str


# ── System prompt ────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are the Med-SEAL Clinical Reasoning Agent, a medical AI assistant for clinical
decision support in chronic disease management (diabetes, hypertension, hyperlipidemia).

ROLE:
- You synthesise electronic health record (EHR) data to answer clinical questions.
- You are called by other agents (Companion, Insight Synthesis, Nudge) -- you never
  interact directly with patients or clinicians.
- Your responses are structured clinical assessments, not patient-friendly text.

CLINICAL REASONING:
- Always cite specific EHR data points: "HbA1c 7.2% (2026-02-15, LOINC:4548-4)".
- Use SNOMED CT codes for diagnoses, LOINC for lab results, RxNorm for medications.
- When assessing drug interactions, check AllergyIntolerance first.
- For trend analysis, compare at least 3 data points over 90+ days.
- State confidence level: high (clear EHR evidence), medium (partial data), low (insufficient data).

OUTPUT FORMAT:
Return structured JSON:
{{
  "assessment": "plain text clinical summary",
  "evidence": [{{"resource_type", "resource_id", "key_value", "date"}}],
  "confidence": "high/medium/low",
  "warnings": ["any safety concerns"],
  "suggested_actions": ["optional clinician follow-ups"]
}}

EVIDENCE-BASED REASONING:
- Pre-fetched journal evidence is provided below — use it to ground your assessment.
- You may also call search_medical_journals or read_journal_paper for additional evidence.
- When citing research, include: author(s), year, journal, and DOI.
- Combine EHR data with literature evidence for comprehensive clinical assessments.

{evidence_block}

SAFETY:
- NEVER fabricate data not present in the EHR.
- If data is missing, state explicitly: "No HbA1c on record in the last 6 months."
- NEVER recommend starting, stopping, or changing medications. You may flag interactions
  or contraindications for clinician review.
- All outputs pass through the Guard before reaching any surface.

Patient ID: {patient_id}
Caller: {caller_agent}"""

TOOLS: list = CLINICAL_FHIR_TOOLS + JOURNAL_TOOLS

# ── Graph builder ────────────────────────────────────────────────────


def _run_sync(coro):
    """Run async coroutine from sync context."""
    import asyncio
    import concurrent.futures
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result(timeout=20)


def build_clinical_graph() -> StateGraph:
    """Construct and compile the A2 Clinical Reasoning Agent graph.

    Returns a compiled LangGraph ``StateGraph`` ready for ``.invoke()``
    or ``.astream()``.
    """
    from agent.core.llm_factory import create_clinical_llm

    _llm, _backend = create_clinical_llm(
        temperature=settings.clinical_temperature,
        max_tokens=settings.clinical_max_tokens,
    )
    llm = _llm.bind_tools(TOOLS)
    logger.info("Clinical agent using %s backend", _backend)

    # -- nodes ---------------------------------------------------------

    def auto_evidence_node(state: ClinicalState) -> dict:
        """Auto-retrieve journal evidence before LLM reasoning.

        Reformulates the clinical query and searches PubMed/Semantic Scholar,
        then ranks results by semantic relevance using SEA-LION embeddings.
        """
        query = ""
        for msg in reversed(state.get("messages", [])):
            if isinstance(msg, HumanMessage):
                query = msg.content if isinstance(msg.content, str) else str(msg.content)
                break
        if not query:
            return {"evidence_context": ""}

        try:
            # Reformulate for clinical search
            from agent.core.embeddings import reformulate_query, rank_by_relevance
            search_query = _run_sync(reformulate_query(query))

            # Search journals
            raw = search_medical_journals.invoke({"query": search_query, "max_results": 5})
            data = json.loads(raw or "{}")
            papers = data.get("papers", [])

            if not papers:
                return {"evidence_context": ""}

            # Prepare items for ranking
            items = []
            for p in papers:
                items.append({
                    "title": p.get("title", ""),
                    "snippet": p.get("abstract", "")[:400],
                    "authors": ", ".join(p.get("authors", [])[:3]),
                    "year": p.get("year", ""),
                    "doi": p.get("doi", ""),
                    "url": p.get("pubmed_url", "") or p.get("url", ""),
                })

            # Rank by relevance
            ranked = _run_sync(rank_by_relevance(query, items, text_key="snippet", min_score=0.20))
            top = ranked[:3]

            # Format evidence block
            lines = ["[AUTO-RETRIEVED EVIDENCE]"]
            for item in top:
                score = item.get("_relevance_score", "")
                lines.append(
                    f"- {item['title']} ({item['authors']}, {item['year']})"
                    f" DOI:{item['doi']} [relevance:{score}]"
                )
                if item["snippet"]:
                    lines.append(f"  Abstract: {item['snippet'][:250]}")
            lines.append("[END EVIDENCE]")

            evidence = "\n".join(lines)
            logger.info("Clinical auto-evidence: %d papers retrieved, %d after ranking",
                       len(papers), len(top))
            return {"evidence_context": evidence}

        except Exception as exc:
            logger.warning("Clinical auto-evidence failed: %s", exc)
            return {"evidence_context": ""}

    def system_prompt_node(state: ClinicalState) -> dict:
        """Inject the system prompt once (idempotent on checkpoint resume)."""
        for msg in state.get("messages", []):
            if isinstance(msg, SystemMessage):
                return {}
        evidence = state.get("evidence_context", "")
        evidence_block = evidence if evidence else "No pre-fetched evidence available. Use search_medical_journals tool if needed."
        prompt = SYSTEM_PROMPT.format(
            patient_id=state.get("patient_id", "unknown"),
            caller_agent=state.get("caller_agent", "unknown"),
            evidence_block=evidence_block,
        )
        return {"messages": [SystemMessage(content=prompt)]}

    def llm_node(state: ClinicalState) -> dict:
        """Invoke the LLM with system message guaranteed first.

        Retries on empty/thinking-only responses (Claude Code standard).
        """
        from agent.core.reasoning import invoke_with_retry
        msgs = list(state["messages"])
        sys_msgs = [m for m in msgs if isinstance(m, SystemMessage)]
        non_sys = [m for m in msgs if not isinstance(m, SystemMessage)]
        response = invoke_with_retry(llm, sys_msgs + non_sys)
        return {"messages": [response]}

    def should_continue(state: ClinicalState) -> str:
        """Route to tool execution or terminate."""
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tool_node"
        return END

    tool_node = ToolNode(TOOLS)

    # -- wiring --------------------------------------------------------

    graph = StateGraph(ClinicalState)
    graph.add_node("auto_evidence", auto_evidence_node)
    graph.add_node("system_prompt_node", system_prompt_node)
    graph.add_node("llm_node", llm_node)
    graph.add_node("tool_node", tool_node)

    graph.add_edge(START, "auto_evidence")
    graph.add_edge("auto_evidence", "system_prompt_node")
    graph.add_edge("system_prompt_node", "llm_node")
    graph.add_conditional_edges(
        "llm_node",
        should_continue,
        {"tool_node": "tool_node", END: END},
    )
    graph.add_edge("tool_node", "llm_node")

    return graph


# ── Health check ─────────────────────────────────────────────────────


async def health_check() -> dict:
    """Verify that the configured clinical LLM backend is reachable."""
    backend = settings.clinical_llm_backend.strip().lower()
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            if backend == "openrouter":
                resp = await client.get(
                    "https://openrouter.ai/api/v1/models",
                    headers={"Authorization": f"Bearer {settings.openrouter_api_key}"},
                )
            elif backend == "azure":
                resp = await client.get(
                    f"{settings.azure_openai_endpoint}/openai/models?api-version={settings.azure_openai_api_version}",
                    headers={"api-key": settings.azure_openai_api_key},
                )
            else:
                resp = await client.get(f"{settings.vllm_url}/v1/models")
            resp.raise_for_status()
            return {"status": "ok", "agent": "clinical", "backend": backend}
    except Exception as exc:
        return {"status": "error", "agent": "clinical", "backend": backend, "detail": str(exc)}
