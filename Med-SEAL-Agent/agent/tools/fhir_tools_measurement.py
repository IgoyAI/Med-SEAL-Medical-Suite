"""A6 Measurement Agent – FHIR tools.

Data-extraction tools for computing quality metrics: medication data,
vital observations, PRO questionnaire responses, communications,
encounters, and a writer for FHIR MeasureReport resources.
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
def read_medication_data(patient_id: str, period_days: int = 30) -> str:
    """Read MedicationAdministration and MedicationRequest data for
    adherence metric computation.

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
            "medication_requests": [
                {
                    "id": r.get("id"),
                    "medication": r.get("medicationCodeableConcept"),
                    "dosageInstruction": r.get("dosageInstruction"),
                    "authoredOn": r.get("authoredOn"),
                }
                for r in requests
            ],
            "medication_administrations": [
                {
                    "id": a.get("id"),
                    "medication": a.get("medicationCodeableConcept"),
                    "effectiveDateTime": a.get("effectiveDateTime") or a.get("effectivePeriod", {}).get("start"),
                    "status": a.get("status"),
                    "dosage": a.get("dosage"),
                }
                for a in admins
            ],
        }, default=str)
    return _run(_call())


@tool
def read_vital_observations(
    patient_id: str, loinc_code: str, period_days: int = 30
) -> str:
    """Read vital sign observations by LOINC code for trend computation.

    Args:
        patient_id: FHIR Patient resource ID.
        loinc_code: LOINC code for the vital (e.g. '85354-9' for BP).
        period_days: Lookback period in days (default 30).
    """
    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        observations = await medplum.search("Observation", {
            "patient": patient_id,
            "code": f"http://loinc.org|{loinc_code}",
            "date": f"ge{cutoff}",
            "_sort": "date",
        })
        return json.dumps({
            "patient_id": patient_id,
            "loinc_code": loinc_code,
            "period_days": period_days,
            "count": len(observations),
            "observations": [
                {
                    "id": o.get("id"),
                    "effectiveDateTime": o.get("effectiveDateTime"),
                    "valueQuantity": o.get("valueQuantity"),
                    "component": o.get("component"),
                    "interpretation": o.get("interpretation"),
                }
                for o in observations
            ],
        }, default=str)
    return _run(_call())


@tool
def read_questionnaire_responses(patient_id: str) -> str:
    """Read PRO questionnaire responses for outcome score computation.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        responses = await medplum.search("QuestionnaireResponse", {
            "patient": patient_id,
            "_sort": "-authored",
            "_count": "50",
        })
        return json.dumps([
            {
                "id": r.get("id"),
                "questionnaire": r.get("questionnaire"),
                "status": r.get("status"),
                "authored": r.get("authored"),
                "item": r.get("item"),
                "source": r.get("source"),
            }
            for r in responses
        ], default=str)
    return _run(_call())


@tool
def read_communications(patient_id: str, period_days: int = 30) -> str:
    """Read Communication resources for engagement metric computation.

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
            "_sort": "-sent",
        })
        patient_ref = f"Patient/{patient_id}"
        return json.dumps({
            "patient_id": patient_id,
            "period_days": period_days,
            "total": len(comms),
            "communications": [
                {
                    "id": c.get("id"),
                    "sent": c.get("sent"),
                    "status": c.get("status"),
                    "category": c.get("category"),
                    "is_from_patient": c.get("sender", {}).get("reference") == patient_ref,
                    "payload_preview": (
                        c.get("payload", [{}])[0].get("contentString", "")[:200]
                        if c.get("payload") else ""
                    ),
                }
                for c in comms
            ],
        }, default=str)
    return _run(_call())


@tool
def read_encounters(patient_id: str, period_days: int = 90) -> str:
    """Read encounter records for readmission and utilisation counting.

    Args:
        patient_id: FHIR Patient resource ID.
        period_days: Lookback period in days (default 90).
    """
    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        encounters = await medplum.search("Encounter", {
            "patient": patient_id,
            "date": f"ge{cutoff}",
            "_sort": "-date",
        })
        return json.dumps({
            "patient_id": patient_id,
            "period_days": period_days,
            "total_encounters": len(encounters),
            "encounters": [
                {
                    "id": e.get("id"),
                    "status": e.get("status"),
                    "class": e.get("class"),
                    "type": e.get("type"),
                    "period": e.get("period"),
                    "reasonCode": e.get("reasonCode"),
                    "hospitalization": e.get("hospitalization"),
                }
                for e in encounters
            ],
        }, default=str)
    return _run(_call())


@tool
def write_measure_report(
    patient_id: str,
    metric_id: str,
    score: float,
    period_start: str,
    period_end: str,
) -> str:
    """Write a FHIR MeasureReport with a computed quality metric.

    Args:
        patient_id: FHIR Patient resource ID.
        metric_id: Metric identifier (e.g. 'medication-adherence-pdc',
            'bp-control-rate', 'engagement-score').
        score: Computed metric score (0.0–1.0 for rates, or absolute).
        period_start: Period start date in YYYY-MM-DD format.
        period_end: Period end date in YYYY-MM-DD format.
    """
    async def _call():
        medplum = get_medplum()
        result = await medplum.create("MeasureReport", {
            "resourceType": "MeasureReport",
            "status": "complete",
            "type": "individual",
            "measure": f"http://medseal.ai/fhir/Measure/{metric_id}",
            "subject": {"reference": f"Patient/{patient_id}"},
            "date": datetime.now(timezone.utc).isoformat(),
            "period": {
                "start": period_start,
                "end": period_end,
            },
            "group": [{
                "code": {
                    "coding": [{
                        "system": "http://medseal.ai/fhir/metric",
                        "code": metric_id,
                        "display": metric_id.replace("-", " ").title(),
                    }],
                },
                "measureScore": {
                    "value": round(score, 4),
                },
            }],
        })
        return json.dumps({
            "id": result.get("id"),
            "status": result.get("status"),
            "metric_id": metric_id,
            "score": score,
            "period": f"{period_start} to {period_end}",
        }, default=str)
    return _run(_call())


MEASUREMENT_FHIR_TOOLS = [
    read_medication_data,
    read_vital_observations,
    read_questionnaire_responses,
    read_communications,
    read_encounters,
    write_measure_report,
]
