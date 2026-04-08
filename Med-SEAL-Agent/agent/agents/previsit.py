"""A7: Pre-Visit Summary Agent.

Generates a structured, patient-facing pre-visit summary from FHIR data
using deterministic rules (no LLM required).
"""

from __future__ import annotations

import logging
from datetime import datetime
from typing import Annotated, TypedDict

from langchain_core.messages import AIMessage, BaseMessage
from langgraph.graph import END, START, StateGraph
from langgraph.graph.message import add_messages

from agent.tools.fhir_tools_previsit import get_patient_summary

logger = logging.getLogger(__name__)


class PrevisitState(TypedDict):
    messages: Annotated[list[BaseMessage], add_messages]
    patient_id: str
    steps: list[dict]
    sources: list[str]
    summary_data: dict


def _format_summary_text(data: dict) -> str:
    """Format the 11-section summary into patient-facing markdown."""
    lines: list[str] = []
    lines.append("Here is your pre-visit summary from your medical record:\n")

    lines.append("1) Active Conditions")
    conditions = data.get("active_conditions", [])
    lines.append("- " + (", ".join(conditions) if conditions else "None recorded"))

    lines.append("\n2) Latest Biometrics")
    biometrics = data.get("latest_biometrics", [])
    if biometrics:
        for b in biometrics[:5]:
            if b.get("components"):
                comp_txt = ", ".join(
                    f"{c.get('name', 'Reading')}: {c.get('value', '')} {c.get('unit', '')}".strip()
                    for c in b["components"][:3]
                )
                lines.append(f"- {b.get('name', 'Observation')}: {comp_txt}")
            else:
                lines.append(
                    f"- {b.get('name', 'Observation')}: {b.get('value', '')} {b.get('unit', '')}".strip()
                )
    else:
        lines.append("- No recent vitals found")

    lines.append("\n3) Lab Results")
    labs = data.get("lab_results", [])
    if labs:
        for lab in labs[:5]:
            high = " (HIGH)" if lab.get("high") else ""
            lines.append(
                f"- {lab.get('name', 'Lab')}: {lab.get('value', '')} {lab.get('unit', '')}{high}".strip()
            )
    else:
        lines.append("- No recent lab results found")

    lines.append("\n4) Current Medications")
    meds = data.get("current_medications", [])
    if meds:
        for m in meds[:8]:
            dose = f" — {m.get('dosage')}" if m.get("dosage") else ""
            lines.append(f"- {m.get('name', 'Medication')}{dose}")
    else:
        lines.append("- No active medications found")

    lines.append("\n5) Medication Adherence (Last 30 days)")
    adh = data.get("medication_adherence", {})
    if adh.get("adherence_percent") is not None:
        lines.append(
            f"- {adh.get('adherence_percent')}% ({adh.get('taken', 0)} taken, {adh.get('skipped', 0)} skipped)"
        )
    else:
        lines.append("- No adherence records available")

    lines.append("\n6) Allergies")
    allergies = data.get("allergies", [])
    lines.append("- " + (", ".join(allergies) if allergies else "No known allergies recorded"))

    lines.append("\n7) Upcoming Appointments")
    appts = data.get("upcoming_appointments", [])
    if appts:
        for a in appts[:5]:
            when = a.get("start", "")
            try:
                dt = datetime.fromisoformat(when.replace("Z", "+00:00"))
                when = dt.strftime("%d %b %Y %I:%M %p")
            except Exception:
                pass
            doctor = a.get("doctor", "")
            svc = a.get("service", "")
            extra = f" — {doctor}" if doctor else ""
            if svc:
                extra += f" ({svc})"
            lines.append(f"- {when}{extra}")
    else:
        lines.append("- No upcoming booked appointments")

    lines.append("\n8) Recent Encounters")
    encs = data.get("recent_encounters", [])
    if encs:
        for e in encs[:5]:
            lines.append(f"- {e.get('type', 'Encounter')} [{e.get('status', 'unknown')}]")
    else:
        lines.append("- No recent encounters found")

    lines.append("\n9) Health Goals")
    goals = data.get("health_goals", [])
    if goals:
        for g in goals[:5]:
            lines.append(f"- {g.get('description', 'Goal')} ({g.get('lifecycle_status', '')})")
    else:
        lines.append("- No active goals found")

    lines.append("\n10) Active Alerts")
    alerts = data.get("active_alerts", [])
    if alerts:
        for f in alerts[:5]:
            lines.append(f"- {f.get('code', 'Alert')} [{f.get('status', 'active')}]")
    else:
        lines.append("- No active alerts")

    lines.append("\n11) Clinical Summary")
    lines.append(f"- {data.get('clinical_summary', 'No summary available')}")

    lines.append("\nIf you want, I can also explain what to prepare for your next appointment.")
    return "\n".join(lines).strip()


def build_previsit_graph() -> StateGraph:
    def summary_node(state: PrevisitState) -> dict:
        patient_id = state.get("patient_id", "")
        steps = list(state.get("steps", []))
        if not patient_id:
            return {
                "messages": [AIMessage(content="I need your patient ID to generate your pre-visit summary.")],
                "steps": steps + [{"action": "Missing patient ID", "category": "error"}],
                "summary_data": {},
            }

        steps.append({"action": "Collecting your pre-visit records", "category": "fhir"})
        try:
            data = get_patient_summary(patient_id)
            content = _format_summary_text(data)
            steps.append({"action": "Pre-visit summary ready", "category": "result"})
            return {
                "messages": [AIMessage(content=content)],
                "steps": steps,
                "sources": [],
                "summary_data": data,
            }
        except Exception as exc:
            logger.exception("Pre-visit summary failed for %s", patient_id)
            steps.append({"action": "Could not generate pre-visit summary", "category": "error"})
            return {
                "messages": [AIMessage(content="I couldn't generate your pre-visit summary right now. Please try again shortly.")],
                "steps": steps,
                "sources": [],
                "summary_data": {"error": str(exc)},
            }

    g = StateGraph(PrevisitState)
    g.add_node("summary", summary_node)
    g.add_edge(START, "summary")
    g.add_edge("summary", END)
    return g


async def health_check() -> dict:
    """Verify that Medplum FHIR is reachable (previsit uses no LLM)."""
    try:
        from agent.tools.fhir_client import get_medplum
        ok = await get_medplum().ping()
        return {
            "agent": "previsit-summary-agent",
            "status": "ok" if ok else "degraded",
            "medplum": "ok" if ok else "unreachable",
        }
    except Exception as exc:
        return {
            "agent": "previsit-summary-agent",
            "status": "degraded",
            "error": str(exc),
        }

