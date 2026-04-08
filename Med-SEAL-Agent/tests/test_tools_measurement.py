"""Integration tests for Measurement Agent FHIR tools.

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


class TestReadMedicationData:
    def test_returns_data(self):
        from agent.tools.fhir_tools_measurement import read_medication_data
        result = json.loads(read_medication_data.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)

    def test_with_custom_period(self):
        from agent.tools.fhir_tools_measurement import read_medication_data
        result = json.loads(read_medication_data.invoke({
            "patient_id": PATIENT_ID,
            "period_days": 90,
        }))
        assert isinstance(result, dict)


class TestReadVitalObservations:
    def test_blood_pressure(self):
        from agent.tools.fhir_tools_measurement import read_vital_observations
        result = json.loads(read_vital_observations.invoke({
            "patient_id": PATIENT_ID,
            "loinc_code": "85354-9",
        }))
        assert isinstance(result, dict)
        assert "observations" in result
        assert "count" in result
        assert isinstance(result["observations"], list)

    def test_heart_rate(self):
        from agent.tools.fhir_tools_measurement import read_vital_observations
        result = json.loads(read_vital_observations.invoke({
            "patient_id": PATIENT_ID,
            "loinc_code": "8867-4",
            "period_days": 365,
        }))
        assert isinstance(result, dict)
        assert "observations" in result
        assert isinstance(result["observations"], list)


class TestReadQuestionnaireResponses:
    def test_returns_list(self):
        from agent.tools.fhir_tools_measurement import read_questionnaire_responses
        result = json.loads(read_questionnaire_responses.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)


class TestReadCommunications:
    def test_returns_data(self):
        from agent.tools.fhir_tools_measurement import read_communications
        result = json.loads(read_communications.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)
        assert "communications" in result
        assert "total" in result
        assert isinstance(result["communications"], list)


class TestReadEncounters:
    def test_returns_encounters(self):
        from agent.tools.fhir_tools_measurement import read_encounters
        result = json.loads(read_encounters.invoke({
            "patient_id": PATIENT_ID,
            "period_days": 3650,
        }))
        assert isinstance(result, dict)
        assert "encounters" in result
        assert "total_encounters" in result
        assert isinstance(result["encounters"], list)


class TestWriteMeasureReport:
    def test_creates_report(self):
        from agent.tools.fhir_tools_measurement import write_measure_report
        result = json.loads(write_measure_report.invoke({
            "patient_id": PATIENT_ID,
            "metric_id": "medication-adherence",
            "score": 0.92,
            "period_start": "2026-03-01",
            "period_end": "2026-03-31",
        }))
        assert "id" in result
