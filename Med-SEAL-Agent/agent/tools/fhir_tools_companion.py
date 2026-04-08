"""A1 Companion Agent – FHIR tools.

Read-heavy tools for patient demographics, conditions, medications,
observations, and recording conversation turns as FHIR Communication
resources.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import json
from datetime import datetime, timezone

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
def read_patient(patient_id: str) -> str:
    """Read patient demographics including name, date of birth, gender,
    contact details, preferred language, and active conditions.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        patient = await medplum.read("Patient", patient_id)
        conditions = await medplum.search("Condition", {
            "patient": patient_id,
            "clinical-status": "active",
        })
        return json.dumps({
            "patient": {
                "id": patient.get("id"),
                "name": patient.get("name"),
                "birthDate": patient.get("birthDate"),
                "gender": patient.get("gender"),
                "telecom": patient.get("telecom"),
                "address": patient.get("address"),
                "communication": patient.get("communication"),
            },
            "active_conditions": [
                {
                    "id": c.get("id"),
                    "code": c.get("code"),
                    "clinicalStatus": c.get("clinicalStatus"),
                    "onsetDateTime": c.get("onsetDateTime"),
                }
                for c in conditions
            ],
        }, default=str)
    return _run(_call())


@tool
def read_conditions(patient_id: str) -> str:
    """Read all active conditions for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        conditions = await medplum.search("Condition", {
            "patient": patient_id,
            "clinical-status": "active",
        })
        return json.dumps([
            {
                "id": c.get("id"),
                "code": c.get("code"),
                "clinicalStatus": c.get("clinicalStatus"),
                "category": c.get("category"),
                "onsetDateTime": c.get("onsetDateTime"),
                "note": c.get("note"),
            }
            for c in conditions
        ], default=str)
    return _run(_call())


@tool
def read_medications(patient_id: str) -> str:
    """Read all medication requests for a patient, including active, completed, and stopped.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        meds = await medplum.search("MedicationRequest", {
            "patient": patient_id,
        })
        return json.dumps([
            {
                "id": m.get("id"),
                "medicationCodeableConcept": m.get("medicationCodeableConcept"),
                "dosageInstruction": m.get("dosageInstruction"),
                "status": m.get("status"),
                "authoredOn": m.get("authoredOn"),
            }
            for m in meds
        ], default=str)
    return _run(_call())


@tool
def read_recent_observations(
    patient_id: str, code: str = "", count: int = 5
) -> str:
    """Read recent vital signs and lab observations for a patient.

    Args:
        patient_id: FHIR Patient resource ID.
        code: Optional LOINC code to filter (e.g. '85354-9' for blood pressure).
        count: Maximum number of results to return.
    """
    async def _call():
        medplum = get_medplum()
        params: dict = {
            "patient": patient_id,
            "_sort": "-date",
            "_count": str(count),
        }
        if code:
            params["code"] = code
        observations = await medplum.search("Observation", params)
        return json.dumps([
            {
                "id": o.get("id"),
                "code": o.get("code"),
                "valueQuantity": o.get("valueQuantity"),
                "valueCodeableConcept": o.get("valueCodeableConcept"),
                "component": o.get("component"),
                "effectiveDateTime": o.get("effectiveDateTime"),
                "status": o.get("status"),
            }
            for o in observations
        ], default=str)
    return _run(_call())


@tool
def write_communication(
    patient_id: str, message: str, direction: str
) -> str:
    """Record a conversation message as a FHIR Communication resource.

    Args:
        patient_id: FHIR Patient resource ID.
        message: The message content.
        direction: 'to-patient' or 'from-patient'.
    """
    async def _call():
        medplum = get_medplum()
        patient_ref = {"reference": f"Patient/{patient_id}"}
        resource: dict = {
            "resourceType": "Communication",
            "status": "completed",
            "subject": patient_ref,
            "payload": [{"contentString": message}],
            "sent": datetime.now(timezone.utc).isoformat(),
        }
        if direction == "to-patient":
            resource["recipient"] = [patient_ref]
        else:
            resource["sender"] = patient_ref
        result = await medplum.create("Communication", resource)
        return json.dumps({
            "id": result.get("id"),
            "status": result.get("status"),
            "direction": direction,
        }, default=str)
    return _run(_call())


COMPANION_FHIR_TOOLS = [
    read_patient,
    read_conditions,
    read_medications,
    read_recent_observations,
    write_communication,
]
