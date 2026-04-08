"""Integration tests for Clinical Reasoning FHIR tools.

Tests against REAL Medplum FHIR server.
Patient: Alejandro (86fb79e8-8b83-46a7-8671-b8b6956d3fdd)
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


class TestPatientEverything:
    def test_returns_grouped_data(self):
        from agent.tools.fhir_tools_clinical import patient_everything
        result = json.loads(patient_everything.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)
        # Should have at least some resource types
        assert len(result) > 0


class TestSearchConditions:
    def test_returns_conditions(self):
        from agent.tools.fhir_tools_clinical import search_conditions
        result = json.loads(search_conditions.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)
        assert len(result) > 0

    def test_with_snomed_filter(self):
        from agent.tools.fhir_tools_clinical import search_conditions
        # 38341003 = Hypertension
        result = json.loads(search_conditions.invoke({
            "patient_id": PATIENT_ID,
            "snomed_code": "38341003",
        }))
        assert isinstance(result, list)


class TestSearchObservations:
    def test_blood_pressure(self):
        from agent.tools.fhir_tools_clinical import search_observations
        # 85354-9 = Blood pressure panel
        result = json.loads(search_observations.invoke({
            "patient_id": PATIENT_ID,
            "loinc_code": "85354-9",
            "period_days": 365,
        }))
        assert isinstance(result, list)

    def test_body_weight(self):
        from agent.tools.fhir_tools_clinical import search_observations
        # 29463-7 = Body weight
        result = json.loads(search_observations.invoke({
            "patient_id": PATIENT_ID,
            "loinc_code": "29463-7",
        }))
        assert isinstance(result, list)


class TestSearchMedications:
    def test_returns_medications(self):
        from agent.tools.fhir_tools_clinical import search_medications
        result = json.loads(search_medications.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)
        assert len(result) > 0


class TestSearchAllergies:
    def test_returns_list(self):
        from agent.tools.fhir_tools_clinical import search_allergies
        result = json.loads(search_allergies.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)


class TestCheckDrugInteraction:
    def test_returns_response(self):
        from agent.tools.fhir_tools_clinical import check_drug_interaction
        result = json.loads(check_drug_interaction.invoke({"medication_codes": "simvastatin,clopidogrel"}))
        assert isinstance(result, (dict, list, str))


class TestSearchEncounters:
    def test_returns_encounters(self):
        from agent.tools.fhir_tools_clinical import search_encounters
        result = json.loads(search_encounters.invoke({
            "patient_id": PATIENT_ID,
            "period_days": 3650,  # 10 years for Synthea data
        }))
        assert isinstance(result, list)
        assert len(result) > 0
