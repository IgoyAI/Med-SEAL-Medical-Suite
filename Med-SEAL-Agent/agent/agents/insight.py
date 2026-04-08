"""A5: Insight Synthesis Agent — pre-visit briefs for clinicians.

Aggregates patient-side data (adherence, biometrics, PROs, engagement,
goals, flags) into a 7-section FHIR Composition that appears in the
clinician's OpenEMR chart.  Triggered by CDS Hooks (patient-view)
or scheduled 24 h before appointments.
"""

from __future__ import annotations

import json
import logging
from typing import Annotated, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from agent.config import settings
from agent.tools.fhir_tools_insight import INSIGHT_FHIR_TOOLS

logger = logging.getLogger(__name__)

SYSTEM_PROMPT = """\
You are the Med-SEAL Insight Synthesis Agent. You generate structured pre-visit briefs
for clinicians by aggregating patient-side data from the Med-SEAL patient app.

OUTPUT:
A FHIR Composition with exactly 7 sections:
1. Adherence summary: per-medication PDC %, missed dose patterns, overall trend.
2. Biometric trends: BP/glucose/weight direction, anomalies flagged, sparkline data points.
3. PRO scores: current instrument scores, delta from last collection, clinical interpretation.
4. Engagement level: app usage frequency, nudge response rate, conversation topics.
5. Flagged concerns: active Flags from nudge agent, conversation safety flags.
6. Goal progress: each Goal with % completion and trajectory (on-track/at-risk/off-track).
7. Recommended actions: suggested clinician follow-ups based on all data patterns.

RULES:
- Be concise. Each section = 2-3 sentences maximum.
- Cite specific numbers: "PDC 78% for metformin (target 80%), declining from 85% last month."
- Flag actionable items clearly: "[ACTION] Consider adjusting amlodipine -- BP averaging 148/92 despite adherence."
- Do not include raw data dumps. Synthesise and interpret.
- Status = preliminary. Clinician reviews and finalizes.

Patient ID: {patient_id}
"""

TOOLS = list(INSIGHT_FHIR_TOOLS)


class InsightState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str


def build_insight_graph() -> StateGraph:
    llm = ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=settings.insight_temperature,
        max_tokens=settings.insight_max_tokens,
    )
    llm_with_tools = llm.bind_tools(TOOLS)
    tool_node = ToolNode(TOOLS)

    def system_prompt_node(state: InsightState) -> dict:
        patient_id = state.get("patient_id", "unknown")
        for m in state["messages"]:
            if isinstance(m, SystemMessage):
                return {}
        prompt = SYSTEM_PROMPT.format(patient_id=patient_id)
        return {"messages": [SystemMessage(content=prompt)]}

    def llm_node(state: InsightState) -> dict:
        from agent.core.reasoning import invoke_with_retry
        msgs = list(state["messages"])
        sys_msgs = [m for m in msgs if isinstance(m, SystemMessage)]
        non_sys = [m for m in msgs if not isinstance(m, SystemMessage)]
        response = invoke_with_retry(llm_with_tools, sys_msgs + non_sys)
        return {"messages": [response]}

    def should_continue(state: InsightState) -> str:
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tools"
        return END

    builder = StateGraph(InsightState)
    builder.add_node("system_prompt", system_prompt_node)
    builder.add_node("llm", llm_node)
    builder.add_node("tools", tool_node)

    builder.set_entry_point("system_prompt")
    builder.add_edge("system_prompt", "llm")
    builder.add_conditional_edges("llm", should_continue, {"tools": "tools", END: END})
    builder.add_edge("tools", "llm")

    return builder


async def health_check() -> dict:
    """Verify that the SEA-LION backend is reachable for the Insight Agent."""
    status = {"agent": "insight-synthesis-agent", "status": "ok"}
    try:
        async with httpx.AsyncClient(timeout=5) as c:
            r = await c.get(
                f"{settings.sealion_api_url}/models",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
            )
            status["sealion"] = "ok" if r.status_code == 200 else "unhealthy"
    except Exception as exc:
        status["sealion"] = f"unreachable ({exc})"
        status["status"] = "degraded"
    return status
