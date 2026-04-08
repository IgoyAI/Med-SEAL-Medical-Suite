"""A3: Nudge Agent — proactive monitoring, nudge generation, and escalation.

The Nudge Agent runs on schedules and event triggers, monitoring FHIR
data streams for actionable signals.  When a trigger fires, it generates
empathetic nudge messages and delivers them to the patient app.  For
severe signals, it escalates to clinicians via FHIR Flag.
"""

from __future__ import annotations

import json
import logging
from enum import Enum
from typing import Annotated, Any, TypedDict

import httpx
from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent.config import settings
from agent.tools.fhir_tools_nudge import (
    NUDGE_FHIR_TOOLS,
    check_biometric_thresholds,
    check_engagement,
    check_medication_adherence,
    escalate_to_clinician,
    get_upcoming_appointments,
    send_nudge,
)

logger = logging.getLogger(__name__)


# ── Trigger types ────────────────────────────────────────────────────


class TriggerType(str, Enum):
    MISSED_DOSE = "missed_dose"
    HIGH_BIOMETRIC = "high_biometric"
    DAILY_CHECKIN = "daily_checkin"
    APPOINTMENT_REMINDER = "appointment_reminder"
    PRO_SCHEDULE = "pro_schedule"
    ENGAGEMENT_DECAY = "engagement_decay"
    BEHAVIORAL_ANTICIPATION = "behavioral_anticipation"


# ── State ────────────────────────────────────────────────────────────


class NudgeState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str
    trigger_type: str
    trigger_context: str
    severity: str
    nudge_text: str
    action_taken: str
    evaluation: dict


# ── System prompt ────────────────────────────────────────────────────

NUDGE_SYSTEM_PROMPT = """\
You are generating a brief, empathetic health nudge message for a patient managing
chronic conditions in Singapore/Southeast Asia.

RULES:
- Maximum 2 sentences.
- Warm, encouraging tone. Never guilt-tripping or commanding.
- Use the patient's preferred language.
- Reference the specific context: {trigger_context}.
- End with an invitation, not a demand: "Would you like to chat about it?" not "You must take your medication."
- For Malay/Tamil: use respectful forms appropriate for elderly patients.
- For Mandarin: use standard simplified Chinese, warm register.

Trigger: {trigger_type}
Patient ID: {patient_id}"""

TOOLS: list = NUDGE_FHIR_TOOLS


# ── Graph builder ────────────────────────────────────────────────────


def build_nudge_graph() -> StateGraph:
    """Construct and compile the A3 Nudge Agent graph.

    Graph flow::

        evaluate_trigger -> route ->
            needs_nudge      -> llm_node -> action_node -> END
            needs_escalation -> action_node -> END
            no_action        -> END
    """
    llm = ChatOpenAI(
        base_url=settings.sealion_api_url,
        api_key=settings.sealion_api_key,
        model=settings.sealion_model,
        temperature=settings.nudge_temperature,
        max_tokens=settings.nudge_max_tokens,
    )

    # -- nodes ---------------------------------------------------------

    def evaluate_trigger_node(state: NudgeState) -> dict:
        """Check FHIR data to determine if a nudge or escalation is needed."""
        patient_id = state.get("patient_id", "")
        trigger_type = state.get("trigger_type", "")
        evaluation: dict[str, Any] = {
            "trigger_type": trigger_type,
            "needs_action": False,
        }
        severity = "routine"

        try:
            if trigger_type == TriggerType.MISSED_DOSE:
                result = json.loads(
                    check_medication_adherence.invoke({"patient_id": patient_id})
                )
                missed = result.get("missed", [])
                adherence = result.get("adherence_rate", 1.0)
                evaluation["missed_medications"] = missed
                evaluation["adherence_rate"] = adherence
                if missed:
                    evaluation["needs_action"] = True
                    severity = "urgent" if len(missed) >= 2 or adherence < 0.5 else "routine"

            elif trigger_type == TriggerType.HIGH_BIOMETRIC:
                result = json.loads(
                    check_biometric_thresholds.invoke({"patient_id": patient_id})
                )
                alerts = result.get("alerts", [])
                evaluation["biometric_alerts"] = alerts
                if alerts:
                    evaluation["needs_action"] = True
                    critical = any(
                        a.get("breach") == "above_high"
                        and a.get("code") in ("8480-6", "2339-0")
                        for a in alerts
                    )
                    severity = "urgent" if critical else "high"

            elif trigger_type == TriggerType.ENGAGEMENT_DECAY:
                result = json.loads(
                    check_engagement.invoke({"patient_id": patient_id})
                )
                score = result.get("engagement_score", 1.0)
                evaluation["engagement_score"] = score
                if score < 0.3:
                    evaluation["needs_action"] = True
                    severity = "urgent" if score < 0.1 else "routine"

            elif trigger_type == TriggerType.APPOINTMENT_REMINDER:
                result = json.loads(
                    get_upcoming_appointments.invoke({"patient_id": patient_id})
                )
                appointments = result if isinstance(result, list) else []
                evaluation["upcoming_appointments"] = appointments
                if appointments:
                    evaluation["needs_action"] = True
                    severity = "routine"

            elif trigger_type in (
                TriggerType.DAILY_CHECKIN,
                TriggerType.PRO_SCHEDULE,
            ):
                evaluation["needs_action"] = True
                severity = "routine"

            elif trigger_type == TriggerType.BEHAVIORAL_ANTICIPATION:
                evaluation["needs_action"] = True
                severity = "routine"

        except Exception as exc:
            logger.error(
                "Trigger evaluation failed for %s/%s: %s",
                patient_id,
                trigger_type,
                exc,
            )
            evaluation["error"] = str(exc)

        evaluation["severity"] = severity
        return {"evaluation": evaluation, "severity": severity}

    def route_trigger(state: NudgeState) -> str:
        """Route to nudge generation, escalation, or exit."""
        evaluation = state.get("evaluation", {})
        if not evaluation.get("needs_action"):
            return "no_action"
        if state.get("severity") == "high":
            return "needs_escalation"
        return "needs_nudge"

    def llm_node(state: NudgeState) -> dict:
        """Generate a nudge message via the LLM."""
        prompt = NUDGE_SYSTEM_PROMPT.format(
            trigger_context=state.get("trigger_context", ""),
            trigger_type=state.get("trigger_type", ""),
            patient_id=state.get("patient_id", "unknown"),
        )
        evaluation_summary = json.dumps(
            state.get("evaluation", {}), default=str
        )
        messages = [
            SystemMessage(content=prompt),
            HumanMessage(
                content=(
                    "Generate a nudge based on this evaluation:\n"
                    f"{evaluation_summary}"
                )
            ),
        ]
        from agent.core.reasoning import invoke_with_retry
        response = invoke_with_retry(llm, messages)
        return {"messages": [response], "nudge_text": response.content}

    def action_node(state: NudgeState) -> dict:
        """Deliver the nudge or escalate to the care team."""
        patient_id = state.get("patient_id", "")
        severity = state.get("severity", "routine")

        if severity == "high":
            reason = (
                f"[{state.get('trigger_type', 'unknown')}] "
                f"{state.get('trigger_context', '')}"
            )
            result = escalate_to_clinician.invoke({
                "patient_id": patient_id,
                "severity": severity,
                "reason": reason,
            })
            return {"action_taken": f"escalated: {result}"}

        nudge_text = state.get("nudge_text", "")
        if nudge_text:
            priority = "urgent" if severity == "urgent" else "routine"
            result = send_nudge.invoke({
                "patient_id": patient_id,
                "message": nudge_text,
                "priority": priority,
            })
            return {"action_taken": f"nudge_sent: {result}"}

        return {"action_taken": "no_action"}

    # -- wiring --------------------------------------------------------

    graph = StateGraph(NudgeState)
    graph.add_node("evaluate_trigger_node", evaluate_trigger_node)
    graph.add_node("llm_node", llm_node)
    graph.add_node("action_node", action_node)

    graph.add_edge(START, "evaluate_trigger_node")
    graph.add_conditional_edges(
        "evaluate_trigger_node",
        route_trigger,
        {
            "needs_nudge": "llm_node",
            "needs_escalation": "action_node",
            "no_action": END,
        },
    )
    graph.add_edge("llm_node", "action_node")
    graph.add_edge("action_node", END)

    return graph


# ── Cached compiled graph ────────────────────────────────────────────

_compiled_nudge_graph = None


def _get_compiled_nudge_graph():
    global _compiled_nudge_graph
    if _compiled_nudge_graph is None:
        _compiled_nudge_graph = build_nudge_graph().compile()
    return _compiled_nudge_graph


# ── Trigger engine ───────────────────────────────────────────────────


async def run_trigger(
    patient_id: str, trigger_type: str, context: dict
) -> dict:
    """Main entry point for triggering nudges.

    Creates the agent state, runs the compiled graph, and returns the
    result dict with severity, nudge text, and action taken.
    """
    graph = _get_compiled_nudge_graph()
    initial_state: NudgeState = {
        "messages": [],
        "patient_id": patient_id,
        "trigger_type": trigger_type,
        "trigger_context": json.dumps(context, default=str),
        "severity": "",
        "nudge_text": "",
        "action_taken": "",
        "evaluation": {},
    }
    result = await graph.ainvoke(
        initial_state,
        config={"recursion_limit": settings.max_recursion},
    )
    return {
        "patient_id": patient_id,
        "trigger_type": trigger_type,
        "severity": result.get("severity", ""),
        "nudge_text": result.get("nudge_text", ""),
        "action_taken": result.get("action_taken", ""),
        "evaluation": result.get("evaluation", {}),
    }


async def check_all_triggers(patient_ids: list[str]) -> list[dict]:
    """Run all trigger checks for a list of patients.

    Checks medication adherence, biometric thresholds, and engagement
    decay for every patient in parallel.  Returns a list of fired
    triggers, each a dict with ``patient_id``, ``trigger_type``, and
    ``details``.
    """
    import asyncio

    async def _check_patient(pid: str) -> list[dict]:
        results: list[dict] = []
        try:
            adherence = json.loads(
                check_medication_adherence.invoke({"patient_id": pid})
            )
            if adherence.get("missed"):
                results.append({
                    "patient_id": pid,
                    "trigger_type": TriggerType.MISSED_DOSE,
                    "details": adherence,
                })
        except Exception as exc:
            logger.error("Adherence check failed for %s: %s", pid, exc)

        try:
            biometrics = json.loads(
                check_biometric_thresholds.invoke({"patient_id": pid})
            )
            if biometrics.get("alert_count", 0) > 0:
                results.append({
                    "patient_id": pid,
                    "trigger_type": TriggerType.HIGH_BIOMETRIC,
                    "details": biometrics,
                })
        except Exception as exc:
            logger.error("Biometric check failed for %s: %s", pid, exc)

        try:
            engagement = json.loads(
                check_engagement.invoke({"patient_id": pid})
            )
            if engagement.get("engagement_score", 1.0) < 0.3:
                results.append({
                    "patient_id": pid,
                    "trigger_type": TriggerType.ENGAGEMENT_DECAY,
                    "details": engagement,
                })
        except Exception as exc:
            logger.error("Engagement check failed for %s: %s", pid, exc)
        return results

    all_results = await asyncio.gather(
        *[_check_patient(pid) for pid in patient_ids],
        return_exceptions=True,
    )
    triggered: list[dict] = []
    for result in all_results:
        if isinstance(result, list):
            triggered.extend(result)
        elif isinstance(result, Exception):
            logger.error("Patient trigger check failed: %s", result)
    return triggered


# ── Health check ─────────────────────────────────────────────────────


async def health_check() -> dict:
    """Verify that the SEA-LION backend is reachable for the Nudge Agent."""
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.get(
                f"{settings.sealion_api_url}/models",
                headers={"Authorization": f"Bearer {settings.sealion_api_key}"},
            )
            resp.raise_for_status()
            return {"status": "ok", "agent": "nudge"}
    except Exception as exc:
        return {"status": "error", "agent": "nudge", "detail": str(exc)}
