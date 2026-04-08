"""A5 Insight Synthesis Agent – FHIR tools.

Read tools for aggregating cross-domain patient data: adherence metrics,
biometric trends, PRO scores, engagement, flags, goal progress, risk
assessments, and a writer for the pre-visit brief Composition resource.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
from datetime import datetime, timedelta, timezone

from langchain_core.tools import tool

from agent.tools.fhir_client import get_medplum


def _run(coro):
    """Run an async coroutine from a sync LangChain tool context."""
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


# ------------------------------------------------------------------
# Tools
# ------------------------------------------------------------------

@tool
def read_adherence_data(patient_id: str, period_days: int = 30) -> str:
    """Read medication adherence metrics over a period.

    Compares MedicationRequest count against MedicationAdministration
    records to compute adherence rates.

    Args:
        patient_id: FHIR Patient resource ID.
        period_days: Lookback period in days (default 30).
    """
    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        requests = await medplum.search("MedicationRequest", {
            "patient": patient_id,
            "status": "active",
        })
        admins = await medplum.search("MedicationAdministration", {
            "patient": patient_id,
            "effective-time": f"ge{cutoff}",
        })
        return json.dumps({
            "patient_id": patient_id,
            "period_days": period_days,
            "active_prescriptions": len(requests),
            "administrations_recorded": len(admins),
            "medications": [
                {
                    "medication": r.get("medicationCodeableConcept", {}).get("text", "unknown"),
                    "dosage": r.get("dosageInstruction"),
                }
                for r in requests
            ],
            "administration_log": [
                {
                    "medication": a.get("medicationCodeableConcept", {}).get("text", "unknown"),
                    "effectiveDateTime": a.get("effectiveDateTime") or a.get("effectivePeriod", {}).get("start"),
                    "status": a.get("status"),
                }
                for a in admins
            ],
        }, default=str)
    return _run(_call())


@tool
def read_biometric_trends(patient_id: str, period_days: int = 30) -> str:
    """Read vital sign observations over a period for trend analysis.

    Fetches blood pressure, heart rate, glucose, HbA1c, weight, and SpO2.

    Args:
        patient_id: FHIR Patient resource ID.
        period_days: Lookback period in days (default 30).
    """
    _CODES = {
        "85354-9": "Blood Pressure",
        "8867-4":  "Heart Rate",
        "2339-0":  "Glucose",
        "4548-4":  "HbA1c",
        "29463-7": "Body Weight",
        "2708-6":  "SpO2",
    }

    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        trends: dict = {}
        for loinc, name in _CODES.items():
            observations = await medplum.search("Observation", {
                "patient": patient_id,
                "code": f"http://loinc.org|{loinc}",
                "date": f"ge{cutoff}",
                "_sort": "date",
            })
            readings = []
            for o in observations:
                vq = o.get("valueQuantity", {})
                entry: dict = {
                    "date": o.get("effectiveDateTime"),
                    "value": vq.get("value"),
                    "unit": vq.get("unit"),
                }
                if o.get("component"):
                    entry["components"] = [
                        {
                            "code": comp.get("code", {}).get("coding", [{}])[0].get("display", ""),
                            "value": comp.get("valueQuantity", {}).get("value"),
                            "unit": comp.get("valueQuantity", {}).get("unit"),
                        }
                        for comp in o["component"]
                    ]
                readings.append(entry)
            trends[name] = {"loinc": loinc, "count": len(readings), "readings": readings}
        return json.dumps({"patient_id": patient_id, "period_days": period_days, "trends": trends}, default=str)
    return _run(_call())


@tool
def read_pro_scores(patient_id: str) -> str:
    """Read patient-reported outcome (PRO) questionnaire responses.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        responses = await medplum.search("QuestionnaireResponse", {
            "patient": patient_id,
            "_sort": "-authored",
            "_count": "20",
        })
        return json.dumps([
            {
                "id": r.get("id"),
                "questionnaire": r.get("questionnaire"),
                "status": r.get("status"),
                "authored": r.get("authored"),
                "item": r.get("item"),
            }
            for r in responses
        ], default=str)
    return _run(_call())


@tool
def read_engagement_metrics(patient_id: str, period_days: int = 30) -> str:
    """Read patient app engagement data over a period.

    Counts Communications (total and patient-initiated) and completed
    QuestionnaireResponses.

    Args:
        patient_id: FHIR Patient resource ID.
        period_days: Lookback period in days (default 30).
    """
    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        comms = await medplum.search("Communication", {
            "patient": patient_id,
            "sent": f"ge{cutoff}",
        })
        qrs = await medplum.search("QuestionnaireResponse", {
            "patient": patient_id,
            "authored": f"ge{cutoff}",
        })
        patient_ref = f"Patient/{patient_id}"
        from_patient = sum(
            1 for c in comms
            if c.get("sender", {}).get("reference") == patient_ref
        )
        to_patient = sum(
            1 for c in comms
            if any(
                r.get("reference") == patient_ref
                for r in c.get("recipient", [])
            )
        )
        return json.dumps({
            "patient_id": patient_id,
            "period_days": period_days,
            "total_communications": len(comms),
            "patient_initiated": from_patient,
            "system_to_patient": to_patient,
            "questionnaires_completed": len(qrs),
        }, default=str)
    return _run(_call())


@tool
def read_active_flags(patient_id: str) -> str:
    """Read active clinical flags for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        flags = await medplum.search("Flag", {
            "patient": patient_id,
            "status": "active",
        })
        return json.dumps([
            {
                "id": f.get("id"),
                "status": f.get("status"),
                "category": f.get("category"),
                "code": f.get("code"),
                "period": f.get("period"),
            }
            for f in flags
        ], default=str)
    return _run(_call())


@tool
def read_goal_progress(patient_id: str) -> str:
    """Read goal achievement status for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        goals = await medplum.search("Goal", {
            "patient": patient_id,
        })
        return json.dumps([
            {
                "id": g.get("id"),
                "description": g.get("description"),
                "lifecycleStatus": g.get("lifecycleStatus"),
                "achievementStatus": g.get("achievementStatus"),
                "target": g.get("target"),
                "startDate": g.get("startDate"),
                "statusDate": g.get("statusDate"),
                "note": g.get("note"),
            }
            for g in goals
        ], default=str)
    return _run(_call())


@tool
def read_risk_assessments(patient_id: str) -> str:
    """Read behavioural risk assessments for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        assessments = await medplum.search("RiskAssessment", {
            "patient": patient_id,
            "_sort": "-date",
        })
        return json.dumps([
            {
                "id": a.get("id"),
                "status": a.get("status"),
                "occurrenceDateTime": a.get("occurrenceDateTime"),
                "prediction": a.get("prediction"),
                "note": a.get("note"),
            }
            for a in assessments
        ], default=str)
    return _run(_call())


@tool
def write_insight_composition(patient_id: str, sections_json: str) -> str:
    """Write a pre-visit brief as a FHIR Composition resource.

    The sections_json argument should be a JSON string encoding a list of
    objects, each with 'title' and 'text' keys.

    Args:
        patient_id: FHIR Patient resource ID.
        sections_json: JSON array of {"title": str, "text": str} section
            objects (e.g. Adherence, Biometrics, Engagement, Risks).
    """
    async def _call():
        medplum = get_medplum()
        sections = json.loads(sections_json)
        fhir_sections = [
            {
                "title": s["title"],
                "text": {
                    "status": "generated",
                    "div": f'<div xmlns="http://www.w3.org/1999/xhtml">{s["text"]}</div>',
                },
            }
            for s in sections
        ]
        result = await medplum.create("Composition", {
            "resourceType": "Composition",
            "status": "final",
            "type": {
                "coding": [{
                    "system": "http://loinc.org",
                    "code": "11503-0",
                    "display": "Medical records",
                }],
            },
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": datetime.now(timezone.utc).isoformat(),
            "title": "Med-SEAL Pre-Visit Insight Brief",
            "section": fhir_sections,
        })
        return json.dumps({
            "id": result.get("id"),
            "status": result.get("status"),
            "section_count": len(fhir_sections),
        }, default=str)
    return _run(_call())


INSIGHT_FHIR_TOOLS = [
    read_adherence_data,
    read_biometric_trends,
    read_pro_scores,
    read_engagement_metrics,
    read_active_flags,
    read_goal_progress,
    read_risk_assessments,
    write_insight_composition,
]
