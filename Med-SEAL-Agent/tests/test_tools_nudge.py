"""Integration tests for Nudge Agent FHIR tools.

Tests against REAL Medplum FHIR server.
"""

import json
import pytest
from agent.tools.fhir_client import init_medplum
from agent.config import settings

PATIENT_ID = "86fb79e8-8b83-46a7-8671-b8b6956d3fdd"


@pytest.fixture(scope="session", autouse=True)
def setup_medplum():
    init_medplum(
        base_url=settings.medplum_url,
        email=settings.medplum_email,
        password=settings.medplum_password,
    )


class TestCheckMedicationAdherence:
    def test_returns_adherence_data(self):
        from agent.tools.fhir_tools_nudge import check_medication_adherence
        result = json.loads(check_medication_adherence.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)

    def test_with_custom_lookback(self):
        from agent.tools.fhir_tools_nudge import check_medication_adherence
        result = json.loads(check_medication_adherence.invoke({
            "patient_id": PATIENT_ID,
            "lookback_hours": 48,
        }))
        assert isinstance(result, dict)


class TestCheckBiometricThresholds:
    def test_returns_alerts(self):
        from agent.tools.fhir_tools_nudge import check_biometric_thresholds
        result = json.loads(check_biometric_thresholds.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)
        assert "alerts" in result


class TestCheckEngagement:
    def test_returns_score(self):
        from agent.tools.fhir_tools_nudge import check_engagement
        result = json.loads(check_engagement.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)
        assert "engagement_score" in result

    def test_with_custom_lookback(self):
        from agent.tools.fhir_tools_nudge import check_engagement
        result = json.loads(check_engagement.invoke({
            "patient_id": PATIENT_ID,
            "lookback_days": 14,
        }))
        assert isinstance(result, dict)


class TestGetUpcomingAppointments:
    def test_returns_list(self):
        from agent.tools.fhir_tools_nudge import get_upcoming_appointments
        result = json.loads(get_upcoming_appointments.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, (dict, list))

    def test_with_custom_lookahead(self):
        from agent.tools.fhir_tools_nudge import get_upcoming_appointments
        result = json.loads(get_upcoming_appointments.invoke({
            "patient_id": PATIENT_ID,
            "lookahead_hours": 168,  # 1 week
        }))
        assert isinstance(result, (dict, list))


class TestSendNudge:
    def test_sends_routine_nudge(self):
        from agent.tools.fhir_tools_nudge import send_nudge
        result = json.loads(send_nudge.invoke({
            "patient_id": PATIENT_ID,
            "message": "Integration test nudge — please ignore",
            "priority": "routine",
        }))
        assert "id" in result

    def test_sends_urgent_nudge(self):
        from agent.tools.fhir_tools_nudge import send_nudge
        result = json.loads(send_nudge.invoke({
            "patient_id": PATIENT_ID,
            "message": "Integration test urgent nudge",
            "priority": "urgent",
        }))
        assert "id" in result


class TestEscalateToClinician:
    def test_creates_escalation(self):
        from agent.tools.fhir_tools_nudge import escalate_to_clinician
        result = json.loads(escalate_to_clinician.invoke({
            "patient_id": PATIENT_ID,
            "severity": "high",
            "reason": "Integration test escalation — not a real alert",
        }))
        assert isinstance(result, dict)


class TestWriteRiskAssessment:
    def test_creates_risk_assessment(self):
        from agent.tools.fhir_tools_nudge import write_risk_assessment
        result = json.loads(write_risk_assessment.invoke({
            "patient_id": PATIENT_ID,
            "risk_type": "medication_non_adherence",
            "probability": 0.35,
        }))
        assert "id" in result
