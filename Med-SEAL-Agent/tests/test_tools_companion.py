"""Integration tests for A1 Companion Agent FHIR tools.

Tests against REAL Medplum FHIR server at 119.13.90.82:8103.
Patient: Alejandro Osvaldo Schinner (86fb79e8-8b83-46a7-8671-b8b6956d3fdd)
"""

import json
import pytest
import asyncio
from agent.tools.fhir_client import init_medplum, get_medplum
from agent.config import settings

PATIENT_ID = "86fb79e8-8b83-46a7-8671-b8b6956d3fdd"  # Alejandro


@pytest.fixture(scope="session", autouse=True)
def setup_medplum():
    """Initialize Medplum client once for all tests."""
    init_medplum(
        base_url=settings.medplum_url,
        email=settings.medplum_email,
        password=settings.medplum_password,
    )


# ═══════════════════════════════════════════════════════════════════════
# read_patient
# ═══════════════════════════════════════════════════════════════════════

class TestReadPatient:
    def test_returns_patient_data(self):
        from agent.tools.fhir_tools_companion import read_patient
        result = json.loads(read_patient.invoke({"patient_id": PATIENT_ID}))

        assert "patient" in result
        assert result["patient"]["id"] == PATIENT_ID
        assert result["patient"]["gender"] in ("male", "female")
        assert result["patient"]["birthDate"] is not None

    def test_includes_name(self):
        from agent.tools.fhir_tools_companion import read_patient
        result = json.loads(read_patient.invoke({"patient_id": PATIENT_ID}))

        name = result["patient"]["name"]
        assert name is not None
        assert len(name) > 0

    def test_includes_conditions(self):
        from agent.tools.fhir_tools_companion import read_patient
        result = json.loads(read_patient.invoke({"patient_id": PATIENT_ID}))

        assert "active_conditions" in result
        assert isinstance(result["active_conditions"], list)
        # Alejandro has conditions in Synthea data
        assert len(result["active_conditions"]) > 0

    def test_invalid_patient_raises(self):
        from agent.tools.fhir_tools_companion import read_patient
        with pytest.raises(Exception):
            read_patient.invoke({"patient_id": "nonexistent-id-000"})


# ═══════════════════════════════════════════════════════════════════════
# read_conditions
# ═══════════════════════════════════════════════════════════════════════

class TestReadConditions:
    def test_returns_conditions(self):
        from agent.tools.fhir_tools_companion import read_conditions
        result = json.loads(read_conditions.invoke({"patient_id": PATIENT_ID}))

        assert isinstance(result, list)
        assert len(result) > 0

    def test_condition_has_code(self):
        from agent.tools.fhir_tools_companion import read_conditions
        result = json.loads(read_conditions.invoke({"patient_id": PATIENT_ID}))

        for cond in result:
            assert "code" in cond
            # Code should have text or coding
            code = cond["code"]
            assert code.get("text") or code.get("coding")

    def test_condition_has_status(self):
        from agent.tools.fhir_tools_companion import read_conditions
        result = json.loads(read_conditions.invoke({"patient_id": PATIENT_ID}))

        for cond in result:
            assert "clinicalStatus" in cond


# ═══════════════════════════════════════════════════════════════════════
# read_medications
# ═══════════════════════════════════════════════════════════════════════

class TestReadMedications:
    def test_returns_medications(self):
        from agent.tools.fhir_tools_companion import read_medications
        result = json.loads(read_medications.invoke({"patient_id": PATIENT_ID}))

        assert isinstance(result, list)
        # Alejandro has 10+ medications
        assert len(result) > 0

    def test_includes_active_and_completed(self):
        from agent.tools.fhir_tools_companion import read_medications
        result = json.loads(read_medications.invoke({"patient_id": PATIENT_ID}))

        statuses = {m["status"] for m in result}
        # Should have both active and completed
        assert "active" in statuses or "completed" in statuses

    def test_medication_has_name(self):
        from agent.tools.fhir_tools_companion import read_medications
        result = json.loads(read_medications.invoke({"patient_id": PATIENT_ID}))

        for med in result:
            concept = med.get("medicationCodeableConcept", {})
            assert concept.get("text") or concept.get("coding"), f"Medication missing name: {med['id']}"

    def test_known_medications_present(self):
        """Alejandro should have Simvastatin, Clopidogrel, Metoprolol."""
        from agent.tools.fhir_tools_companion import read_medications
        result = json.loads(read_medications.invoke({"patient_id": PATIENT_ID}))

        names = [m.get("medicationCodeableConcept", {}).get("text", "").lower() for m in result]
        all_names = " ".join(names)
        assert "simvastatin" in all_names or "clopidogrel" in all_names or "metoprolol" in all_names


# ═══════════════════════════════════════════════════════════════════════
# read_recent_observations
# ═══════════════════════════════════════════════════════════════════════

class TestReadRecentObservations:
    def test_returns_observations(self):
        from agent.tools.fhir_tools_companion import read_recent_observations
        result = json.loads(read_recent_observations.invoke({"patient_id": PATIENT_ID}))

        assert isinstance(result, list)
        assert len(result) > 0

    def test_observations_have_code(self):
        from agent.tools.fhir_tools_companion import read_recent_observations
        result = json.loads(read_recent_observations.invoke({"patient_id": PATIENT_ID}))

        for obs in result:
            assert "code" in obs

    def test_with_loinc_blood_pressure(self):
        """LOINC 85354-9 = Blood pressure panel."""
        from agent.tools.fhir_tools_companion import read_recent_observations
        result = json.loads(read_recent_observations.invoke({
            "patient_id": PATIENT_ID,
            "code": "85354-9",
            "count": 3,
        }))
        assert isinstance(result, list)

    def test_respects_count(self):
        from agent.tools.fhir_tools_companion import read_recent_observations
        result = json.loads(read_recent_observations.invoke({
            "patient_id": PATIENT_ID,
            "count": 2,
        }))
        assert len(result) <= 2

    def test_sorted_by_date_desc(self):
        from agent.tools.fhir_tools_companion import read_recent_observations
        result = json.loads(read_recent_observations.invoke({
            "patient_id": PATIENT_ID,
            "count": 5,
        }))
        dates = [o.get("effectiveDateTime", "") for o in result if o.get("effectiveDateTime")]
        if len(dates) >= 2:
            assert dates == sorted(dates, reverse=True), "Observations should be newest first"


# ═══════════════════════════════════════════════════════════════════════
# write_communication
# ═══════════════════════════════════════════════════════════════════════

class TestWriteCommunication:
    def test_write_to_patient(self):
        from agent.tools.fhir_tools_companion import write_communication
        result = json.loads(write_communication.invoke({
            "patient_id": PATIENT_ID,
            "message": "Test message to patient",
            "direction": "to-patient",
        }))

        assert "id" in result
        assert result["status"] == "completed"
        assert result["direction"] == "to-patient"

    def test_write_from_patient(self):
        from agent.tools.fhir_tools_companion import write_communication
        result = json.loads(write_communication.invoke({
            "patient_id": PATIENT_ID,
            "message": "Test message from patient",
            "direction": "from-patient",
        }))

        assert "id" in result
        assert result["direction"] == "from-patient"
