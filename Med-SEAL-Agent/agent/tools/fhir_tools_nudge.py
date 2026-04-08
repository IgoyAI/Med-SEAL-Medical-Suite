"""A3 Nudge Agent – FHIR tools.

Proactive monitoring tools: medication adherence checks, biometric
threshold alerts, engagement tracking, appointment reminders, nudge
delivery, clinician escalation, and behavioural risk assessment.
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
def check_medication_adherence(
    patient_id: str, lookback_hours: int = 24
) -> str:
    """Check for missed medication doses within a lookback window.

    Compares active MedicationRequests against MedicationAdministration
    records to identify gaps.

    Args:
        patient_id: FHIR Patient resource ID.
        lookback_hours: Hours to look back for administrations (default 24).
    """
    async def _call():
        medplum = get_medplum()
        requests = await medplum.search("MedicationRequest", {
            "patient": patient_id,
            "status": "active",
        })
        cutoff = (datetime.now(timezone.utc) - timedelta(hours=lookback_hours)).isoformat()
        admins = await medplum.search("MedicationAdministration", {
            "patient": patient_id,
            "effective-time": f"ge{cutoff}",
        })
        admin_med_codes = set()
        for a in admins:
            concept = a.get("medicationCodeableConcept", {})
            for coding in concept.get("coding", []):
                admin_med_codes.add(coding.get("code", ""))

        missed = []
        taken = []
        for req in requests:
            concept = req.get("medicationCodeableConcept", {})
            codings = concept.get("coding", [])
            code = codings[0].get("code", "") if codings else ""
            display = codings[0].get("display", concept.get("text", "unknown")) if codings else concept.get("text", "unknown")
            entry = {"code": code, "display": display, "dosage": req.get("dosageInstruction")}
            if code and code in admin_med_codes:
                taken.append(entry)
            else:
                missed.append(entry)

        return json.dumps({
            "patient_id": patient_id,
            "lookback_hours": lookback_hours,
            "missed": missed,
            "taken": taken,
            "adherence_rate": len(taken) / max(len(taken) + len(missed), 1),
        }, default=str)
    return _run(_call())


_VITAL_THRESHOLDS = {
    "8480-6":  {"name": "Systolic BP",  "low": 90,  "high": 140, "unit": "mmHg"},
    "8462-4":  {"name": "Diastolic BP", "low": 60,  "high": 90,  "unit": "mmHg"},
    "8867-4":  {"name": "Heart Rate",   "low": 50,  "high": 100, "unit": "/min"},
    "2339-0":  {"name": "Glucose",      "low": 3.9, "high": 10,  "unit": "mmol/L"},
    "8310-5":  {"name": "Temperature",  "low": 36,  "high": 37.5,"unit": "°C"},
    "2708-6":  {"name": "SpO2",         "low": 92,  "high": 100, "unit": "%"},
}


@tool
def check_biometric_thresholds(patient_id: str) -> str:
    """Check latest vitals against predefined clinical thresholds.

    Returns breached thresholds with the offending values.

    Args:
        patient_id: FHIR Patient resource ID.
    """
    async def _call():
        medplum = get_medplum()
        alerts = []
        for loinc, info in _VITAL_THRESHOLDS.items():
            observations = await medplum.search("Observation", {
                "patient": patient_id,
                "code": f"http://loinc.org|{loinc}",
                "_sort": "-date",
                "_count": "1",
            })
            if not observations:
                continue
            obs = observations[0]
            vq = obs.get("valueQuantity", {})
            value = vq.get("value")
            if value is None:
                continue
            breach = None
            if value < info["low"]:
                breach = "below_low"
            elif value > info["high"]:
                breach = "above_high"
            if breach:
                alerts.append({
                    "code": loinc,
                    "name": info["name"],
                    "value": value,
                    "unit": info["unit"],
                    "threshold_low": info["low"],
                    "threshold_high": info["high"],
                    "breach": breach,
                    "observed_at": obs.get("effectiveDateTime"),
                })
        return json.dumps({
            "patient_id": patient_id,
            "alert_count": len(alerts),
            "alerts": alerts,
        }, default=str)
    return _run(_call())


@tool
def check_engagement(patient_id: str, lookback_days: int = 7) -> str:
    """Check patient app engagement by counting Communications and
    QuestionnaireResponses in the lookback window.

    Args:
        patient_id: FHIR Patient resource ID.
        lookback_days: Days to look back (default 7).
    """
    async def _call():
        medplum = get_medplum()
        cutoff = (datetime.now(timezone.utc) - timedelta(days=lookback_days)).strftime("%Y-%m-%d")
        comms = await medplum.search("Communication", {
            "patient": patient_id,
            "sent": f"ge{cutoff}",
        })
        qrs = await medplum.search("QuestionnaireResponse", {
            "patient": patient_id,
            "authored": f"ge{cutoff}",
        })
        from_patient = sum(
            1 for c in comms
            if c.get("sender", {}).get("reference", "").endswith(patient_id)
        )
        return json.dumps({
            "patient_id": patient_id,
            "lookback_days": lookback_days,
            "total_communications": len(comms),
            "patient_initiated": from_patient,
            "questionnaires_completed": len(qrs),
            "engagement_score": min((from_patient + len(qrs)) / max(lookback_days, 1), 1.0),
        }, default=str)
    return _run(_call())


@tool
def get_upcoming_appointments(
    patient_id: str, lookahead_hours: int = 72
) -> str:
    """Get upcoming appointments within a lookahead window.

    Args:
        patient_id: FHIR Patient resource ID.
        lookahead_hours: Hours to look ahead (default 72).
    """
    async def _call():
        medplum = get_medplum()
        now = datetime.now(timezone.utc).isoformat()
        end = (datetime.now(timezone.utc) + timedelta(hours=lookahead_hours)).isoformat()
        appointments = await medplum.search("Appointment", {
            "patient": patient_id,
            "date": f"ge{now}",
            "date": f"le{end}",
            "status": "booked,pending",
        })
        return json.dumps([
            {
                "id": a.get("id"),
                "status": a.get("status"),
                "start": a.get("start"),
                "end": a.get("end"),
                "description": a.get("description"),
                "serviceType": a.get("serviceType"),
                "participant": a.get("participant"),
            }
            for a in appointments
        ], default=str)
    return _run(_call())


@tool
def send_nudge(
    patient_id: str, message: str, priority: str = "routine"
) -> str:
    """Send a nudge to the patient as a FHIR Communication resource.

    Args:
        patient_id: FHIR Patient resource ID.
        message: Nudge message content.
        priority: FHIR request priority – 'routine', 'urgent', 'asap', or 'stat'.
    """
    async def _call():
        medplum = get_medplum()
        resource = {
            "resourceType": "Communication",
            "status": "completed",
            "priority": priority,
            "subject": {"reference": f"Patient/{patient_id}"},
            "recipient": [{"reference": f"Patient/{patient_id}"}],
            "payload": [{"contentString": message}],
            "sent": datetime.now(timezone.utc).isoformat(),
            "category": [{
                "coding": [{
                    "system": "http://medseal.ai/fhir/communication-category",
                    "code": "nudge",
                    "display": "Automated Nudge",
                }],
            }],
        }
        result = await medplum.create("Communication", resource)
        return json.dumps({
            "id": result.get("id"),
            "status": result.get("status"),
            "priority": priority,
        }, default=str)
    return _run(_call())


@tool
def escalate_to_clinician(
    patient_id: str, severity: str, reason: str
) -> str:
    """Escalate a concern to the care team by creating a FHIR Flag and
    CommunicationRequest.

    Args:
        patient_id: FHIR Patient resource ID.
        severity: 'low', 'medium', or 'high'.
        reason: Free-text description of the escalation reason.
    """
    async def _call():
        medplum = get_medplum()
        flag = await medplum.create("Flag", {
            "resourceType": "Flag",
            "status": "active",
            "category": [{
                "coding": [{
                    "system": "http://terminology.hl7.org/CodeSystem/flag-category",
                    "code": "clinical",
                    "display": "Clinical",
                }],
            }],
            "code": {
                "coding": [{
                    "system": "http://medseal.ai/fhir/flag-code",
                    "code": f"escalation-{severity}",
                    "display": f"Escalation ({severity})",
                }],
                "text": reason,
            },
            "subject": {"reference": f"Patient/{patient_id}"},
            "period": {"start": datetime.now(timezone.utc).isoformat()},
        })
        comm_req = await medplum.create("CommunicationRequest", {
            "resourceType": "CommunicationRequest",
            "status": "active",
            "priority": "urgent" if severity == "high" else "routine",
            "subject": {"reference": f"Patient/{patient_id}"},
            "payload": [{"contentString": f"[{severity.upper()}] {reason}"}],
            "authoredOn": datetime.now(timezone.utc).isoformat(),
        })
        return json.dumps({
            "flag_id": flag.get("id"),
            "communication_request_id": comm_req.get("id"),
            "severity": severity,
        }, default=str)
    return _run(_call())


@tool
def write_risk_assessment(
    patient_id: str, risk_type: str, probability: float
) -> str:
    """Write a behavioural risk assessment as a FHIR RiskAssessment.

    Args:
        patient_id: FHIR Patient resource ID.
        risk_type: Type of risk (e.g. 'medication-non-adherence',
            'disengagement', 'biometric-deterioration').
        probability: Estimated probability between 0.0 and 1.0.
    """
    async def _call():
        medplum = get_medplum()
        result = await medplum.create("RiskAssessment", {
            "resourceType": "RiskAssessment",
            "status": "final",
            "subject": {"reference": f"Patient/{patient_id}"},
            "occurrenceDateTime": datetime.now(timezone.utc).isoformat(),
            "prediction": [{
                "outcome": {
                    "coding": [{
                        "system": "http://medseal.ai/fhir/risk-type",
                        "code": risk_type,
                        "display": risk_type.replace("-", " ").title(),
                    }],
                },
                "probabilityDecimal": round(probability, 4),
            }],
        })
        return json.dumps({
            "id": result.get("id"),
            "risk_type": risk_type,
            "probability": probability,
        }, default=str)
    return _run(_call())


NUDGE_FHIR_TOOLS = [
    check_medication_adherence,
    check_biometric_thresholds,
    check_engagement,
    get_upcoming_appointments,
    send_nudge,
    escalate_to_clinician,
    write_risk_assessment,
]
