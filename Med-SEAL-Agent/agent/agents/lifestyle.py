"""A4: Lifestyle Agent — dietary recommendations and wellness coaching.

The Lifestyle Agent handles dietary recommendations, exercise guidance,
and wellness goal tracking.  It understands SEA food context including
hawker centre meals and local ingredients.  It never speaks directly
to patients; it returns structured recommendations to A1.
"""

from __future__ import annotations

import logging
from typing import Annotated, TypedDict

import httpx
from langchain_core.messages import AIMessage, BaseMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages
from langgraph.prebuilt import ToolNode

from agent.config import settings
from agent.tools.fhir_tools_lifestyle import LIFESTYLE_FHIR_TOOLS

logger = logging.getLogger(__name__)

# ── State ────────────────────────────────────────────────────────────


class LifestyleState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str


# ── System prompt ────────────────────────────────────────────────────

SYSTEM_PROMPT = """\
You are the Med-SEAL Lifestyle Agent, a dietary and wellness coach specializing in
chronic disease management for patients in Singapore and Southeast Asia.

EXPERTISE:
- Singapore and SEA food context: hawker centre meals, local dishes (nasi lemak, mee siam,
  roti prata, thosai, char kway teow, ban mian), festive foods (CNY reunion dinner,
  Hari Raya rendang, Deepavali murukku, Pongal sweet rice).
- Practical substitutions: brown rice for white rice, less coconut milk in curry,
  grilled instead of fried, smaller nasi lemak portion.
- Drug-food interactions: grapefruit with statins, high-potassium foods with ACE inhibitors,
  consistent vitamin K intake with warfarin.
- Exercise for chronic conditions: walking, tai chi, swimming adapted to the patient's
  mobility and climate (Singapore heat and humidity).

OUTPUT FORMAT:
Return structured JSON (A1 will rephrase for the patient):
{{
  "recommendations": [{{"category": "diet/exercise/goal", "text": "specific recommendation", "reason": "why"}}],
  "warnings": [{{"food": "item", "drug": "name", "severity": "high", "message": "avoid"}}],
  "alternatives": [{{"instead_of": "original", "try": "healthier option", "benefit": "explanation"}}],
  "goal_suggestions": [{{"description": "target", "value": 0, "unit": "string", "timeframe": "string"}}]
}}

RULES:
- Never recommend extreme diets or fasting without clinician guidance.
- Always respect cultural and religious dietary requirements (halal, vegetarian, etc.).
- Frame recommendations positively: "try this" not "don't eat that".
- Base recommendations on the patient's actual conditions, medications, and latest biometrics.

Patient ID: {patient_id}"""

TOOLS: list = LIFESTYLE_FHIR_TOOLS

# ── Graph builder ────────────────────────────────────────────────────


def build_lifestyle_graph() -> StateGraph:
    """Construct and compile the A4 Lifestyle Agent graph.

    Returns a compiled LangGraph ``StateGraph`` ready for ``.invoke()``
    or ``.astream()``.
    """
    llm = ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=settings.lifestyle_temperature,
        max_tokens=settings.lifestyle_max_tokens,
    ).bind_tools(TOOLS)

    # -- nodes ---------------------------------------------------------

    def system_prompt_node(state: LifestyleState) -> dict:
        """Inject the system prompt once (idempotent on checkpoint resume)."""
        for msg in state.get("messages", []):
            if isinstance(msg, SystemMessage):
                return {}
        prompt = SYSTEM_PROMPT.format(
            patient_id=state.get("patient_id", "unknown"),
        )
        return {"messages": [SystemMessage(content=prompt)]}

    def llm_node(state: LifestyleState) -> dict:
        """Invoke the LLM with system message guaranteed first.

        Retries on empty/thinking-only responses (Claude Code standard).
        """
        from agent.core.reasoning import invoke_with_retry
        msgs = list(state["messages"])
        sys_msgs = [m for m in msgs if isinstance(m, SystemMessage)]
        non_sys = [m for m in msgs if not isinstance(m, SystemMessage)]
        response = invoke_with_retry(llm, sys_msgs + non_sys)
        return {"messages": [response]}

    def should_continue(state: LifestyleState) -> str:
        """Route to tool execution or terminate."""
        last = state["messages"][-1]
        if isinstance(last, AIMessage) and last.tool_calls:
            return "tool_node"
        return END

    tool_node = ToolNode(TOOLS)

    # -- wiring --------------------------------------------------------

    graph = StateGraph(LifestyleState)
    graph.add_node("system_prompt_node", system_prompt_node)
    graph.add_node("llm_node", llm_node)
    graph.add_node("tool_node", tool_node)

    graph.add_edge(START, "system_prompt_node")
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
    """Verify that the SEA-LION backend is reachable for the Lifestyle Agent."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{settings.sealion_api_url}/models",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
            )
            resp.raise_for_status()
            return {"status": "ok", "agent": "lifestyle"}
    except Exception as exc:
        return {"status": "error", "agent": "lifestyle", "detail": str(exc)}
