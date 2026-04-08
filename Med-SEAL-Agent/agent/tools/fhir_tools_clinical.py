"""A2 Clinical Reasoning Agent – FHIR tools.

Deep clinical query tools: patient $everything, condition/observation/
medication/allergy searches with SNOMED CT and LOINC filtering, encounter
history, and a drug-interaction placeholder.
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
def patient_everything(patient_id: str) -> str:
    """Retrieve the full patient record via the FHIR $everything operation.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        result = await medplum.operation(f"Patient/{patient_id}/$everything")
        entries = result.get("entry", [])
        summary = {}
        for entry in entries:
            res = entry.get("resource", entry)
            rt = res.get("resourceType", "Unknown")
            summary.setdefault(rt, []).append(res)
        overview = {rt: len(items) for rt, items in summary.items()}
        return json.dumps({
            "patient_id": patient_id,
            "resource_counts": overview,
            "resources": summary,
        }, default=str)
    return _run(_call())


@tool
def search_conditions(patient_id: str, snomed_code: str = "") -> str:
    """Search patient conditions, optionally filtered by SNOMED CT code.

    Args:
        patient_id: FHIR Patient resource ID.
        snomed_code: Optional SNOMED CT code to filter conditions.
    """
    async def _call():
        medplum = get_medplum()
        params: dict = {"patient": patient_id, "clinical-status": "active"}
        if snomed_code:
            params["code"] = f"http://snomed.info/sct|{snomed_code}"
        conditions = await medplum.search("Condition", params)
        return json.dumps([
            {
                "id": c.get("id"),
                "code": c.get("code"),
                "clinicalStatus": c.get("clinicalStatus"),
                "verificationStatus": c.get("verificationStatus"),
                "severity": c.get("severity"),
                "onsetDateTime": c.get("onsetDateTime"),
                "category": c.get("category"),
                "note": c.get("note"),
            }
            for c in conditions
        ], default=str)
    return _run(_call())


@tool
def search_observations(
    patient_id: str, loinc_code: str, period_days: int = 90
) -> str:
    """Search patient observations by LOINC code within a time window.

    Args:
        patient_id: FHIR Patient resource ID.
        loinc_code: LOINC code (e.g. '4548-4' for HbA1c).
        period_days: Lookback window in days (default 90).
    """
    async def _call():
        medplum = get_medplum()
        start = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        observations = await medplum.search("Observation", {
            "patient": patient_id,
            "code": f"http://loinc.org|{loinc_code}",
            "date": f"ge{start}",
            "_sort": "-date",
        })
        return json.dumps([
            {
                "id": o.get("id"),
                "code": o.get("code"),
                "valueQuantity": o.get("valueQuantity"),
                "valueCodeableConcept": o.get("valueCodeableConcept"),
                "component": o.get("component"),
                "effectiveDateTime": o.get("effectiveDateTime"),
                "interpretation": o.get("interpretation"),
                "referenceRange": o.get("referenceRange"),
            }
            for o in observations
        ], default=str)
    return _run(_call())


@tool
def search_medications(patient_id: str) -> str:
    """Search active medication requests with dosage information.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        meds = await medplum.search("MedicationRequest", {
            "patient": patient_id,
            "status": "active",
        })
        return json.dumps([
            {
                "id": m.get("id"),
                "medicationCodeableConcept": m.get("medicationCodeableConcept"),
                "dosageInstruction": m.get("dosageInstruction"),
                "status": m.get("status"),
                "intent": m.get("intent"),
                "authoredOn": m.get("authoredOn"),
                "requester": m.get("requester"),
                "reasonCode": m.get("reasonCode"),
            }
            for m in meds
        ], default=str)
    return _run(_call())


@tool
def search_allergies(patient_id: str) -> str:
    """Search allergy and intolerance records for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        allergies = await medplum.search("AllergyIntolerance", {
            "patient": patient_id,
            "clinical-status": "active",
        })
        return json.dumps([
            {
                "id": a.get("id"),
                "code": a.get("code"),
                "clinicalStatus": a.get("clinicalStatus"),
                "type": a.get("type"),
                "category": a.get("category"),
                "criticality": a.get("criticality"),
                "reaction": a.get("reaction"),
                "onsetDateTime": a.get("onsetDateTime"),
            }
            for a in allergies
        ], default=str)
    return _run(_call())


@tool
def check_drug_interaction(medication_codes: str) -> str:
    """Check for drug–drug interactions (V1 placeholder).

    Returns a recommendation to consult a pharmacist along with the
    submitted codes.  A future version will call a terminology service.

    Args:
        medication_codes: Comma-separated medication codes (RxNorm or
            display names) to check.
    """
    codes = [c.strip() for c in medication_codes.split(",") if c.strip()]
    return json.dumps({
        "status": "placeholder_v1",
        "medications_checked": codes,
        "recommendation": (
            "Automated drug interaction checking is not yet available. "
            "Please consult a pharmacist or refer to a drug interaction "
            "database for the following medications: "
            + ", ".join(codes)
        ),
    })


@tool
def search_encounters(patient_id: str, period_days: int = 365) -> str:
    """Search patient encounter history within a time window.

    Args:
        patient_id: FHIR Patient resource ID.
        period_days: Lookback window in days (default 365).
    """
    async def _call():
        medplum = get_medplum()
        start = (datetime.now(timezone.utc) - timedelta(days=period_days)).strftime("%Y-%m-%d")
        encounters = await medplum.search("Encounter", {
            "patient": patient_id,
            "date": f"ge{start}",
            "_sort": "-date",
        })
        return json.dumps([
            {
                "id": e.get("id"),
                "status": e.get("status"),
                "class": e.get("class"),
                "type": e.get("type"),
                "period": e.get("period"),
                "reasonCode": e.get("reasonCode"),
                "serviceProvider": e.get("serviceProvider"),
                "hospitalization": e.get("hospitalization"),
            }
            for e in encounters
        ], default=str)
    return _run(_call())


CLINICAL_FHIR_TOOLS = [
    patient_everything,
    search_conditions,
    search_observations,
    search_medications,
    search_allergies,
    check_drug_interaction,
    search_encounters,
]
