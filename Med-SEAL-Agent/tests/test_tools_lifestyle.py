"""Integration tests for Lifestyle Agent FHIR tools.

Tests against REAL Medplum FHIR server + local food/drug-food DBs.
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


class TestReadPatientConditions:
    def test_returns_conditions(self):
        from agent.tools.fhir_tools_lifestyle import read_patient_conditions
        result = json.loads(read_patient_conditions.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)
        assert len(result) > 0


class TestReadPatientMedications:
    def test_returns_medications(self):
        from agent.tools.fhir_tools_lifestyle import read_patient_medications
        result = json.loads(read_patient_medications.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)
        assert len(result) > 0


class TestReadLatestBiometrics:
    def test_returns_biometrics(self):
        from agent.tools.fhir_tools_lifestyle import read_latest_biometrics
        result = json.loads(read_latest_biometrics.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, dict)


class TestReadPatientGoals:
    def test_returns_list(self):
        from agent.tools.fhir_tools_lifestyle import read_patient_goals
        result = json.loads(read_patient_goals.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, list)


class TestQueryFoodDatabase:
    def test_nasi_lemak(self):
        from agent.tools.fhir_tools_lifestyle import query_food_database
        result = json.loads(query_food_database.invoke({"query": "nasi lemak"}))
        assert isinstance(result, (dict, list))

    def test_with_dietary_constraints(self):
        from agent.tools.fhir_tools_lifestyle import query_food_database
        result = json.loads(query_food_database.invoke({
            "query": "rice",
            "dietary_constraints": "diabetes, low sodium",
        }))
        assert isinstance(result, (dict, list))


class TestCheckFoodDrugInteractions:
    def test_grapefruit_simvastatin(self):
        from agent.tools.fhir_tools_lifestyle import check_food_drug_interactions
        result = json.loads(check_food_drug_interactions.invoke({
            "food_items": "grapefruit juice",
            "medication_names": "simvastatin",
        }))
        assert isinstance(result, (dict, list))

    def test_no_interaction(self):
        from agent.tools.fhir_tools_lifestyle import check_food_drug_interactions
        result = json.loads(check_food_drug_interactions.invoke({
            "food_items": "plain rice",
            "medication_names": "paracetamol",
        }))
        assert isinstance(result, (dict, list))


class TestWriteGoal:
    def test_creates_goal(self):
        from agent.tools.fhir_tools_lifestyle import write_goal
        result = json.loads(write_goal.invoke({
            "patient_id": PATIENT_ID,
            "description": "Walk 10,000 steps daily",
            "target_value": "10000 steps",
            "due_date": "2026-06-01",
        }))
        assert "id" in result


class TestWriteNutritionOrder:
    def test_creates_order(self):
        from agent.tools.fhir_tools_lifestyle import write_nutrition_order
        result = json.loads(write_nutrition_order.invoke({
            "patient_id": PATIENT_ID,
            "diet_type": "diabetic",
            "instructions": "Low GI meals, limit sugar intake",
        }))
        assert "id" in result
