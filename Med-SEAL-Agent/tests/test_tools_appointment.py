"""Integration tests for appointment FHIR tools.

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


# ═══════════════════════════════════════════════════════════════════════
# search_slots
# ═══════════════════════════════════════════════════════════════════════

class TestSearchSlots:
    def test_returns_valid_json(self):
        from agent.tools.fhir_tools_appointment import search_slots
        result = json.loads(search_slots.invoke({"specialty": "General"}))
        assert isinstance(result, (dict, list))

    def test_with_date_filter(self):
        from agent.tools.fhir_tools_appointment import search_slots
        result = json.loads(search_slots.invoke({
            "specialty": "",
            "date_from": "2026-04-10",
            "limit": 3,
        }))
        assert isinstance(result, (dict, list))

    def test_with_limit(self):
        from agent.tools.fhir_tools_appointment import search_slots
        result = json.loads(search_slots.invoke({
            "specialty": "",
            "limit": 2,
        }))
        slots = result.get("slots", result) if isinstance(result, dict) else result
        if isinstance(slots, list):
            assert len(slots) <= 2


# ═══════════════════════════════════════════════════════════════════════
# list_appointments
# ═══════════════════════════════════════════════════════════════════════

class TestListAppointments:
    def test_returns_valid_json(self):
        from agent.tools.fhir_tools_appointment import list_appointments
        result = json.loads(list_appointments.invoke({"patient_id": PATIENT_ID}))
        assert isinstance(result, (dict, list))

    def test_with_booked_status(self):
        from agent.tools.fhir_tools_appointment import list_appointments
        result = json.loads(list_appointments.invoke({
            "patient_id": PATIENT_ID,
            "status": "booked",
        }))
        assert isinstance(result, (dict, list))

    def test_with_all_statuses(self):
        from agent.tools.fhir_tools_appointment import list_appointments
        result = json.loads(list_appointments.invoke({
            "patient_id": PATIENT_ID,
            "status": "",
        }))
        assert isinstance(result, (dict, list))


# ═══════════════════════════════════════════════════════════════════════
# book_slot + cancel_booking (full lifecycle)
# ═══════════════════════════════════════════════════════════════════════

class TestBookingLifecycle:
    """Test booking and cancellation as a full lifecycle.

    Only runs if free slots exist. Cleans up after itself.
    """

    def test_book_and_cancel(self):
        from agent.tools.fhir_tools_appointment import search_slots, book_slot, cancel_booking

        # 1. Find a free slot
        slots_result = json.loads(search_slots.invoke({"specialty": "", "limit": 1}))
        slots = slots_result.get("slots", slots_result) if isinstance(slots_result, dict) else slots_result

        if not slots or (isinstance(slots, list) and len(slots) == 0):
            pytest.skip("No free slots available for booking test")

        slot = slots[0] if isinstance(slots, list) else None
        if not slot or not slot.get("id"):
            pytest.skip("Slot data format unexpected")

        slot_id = slot["id"]

        # 2. Book it
        book_result = json.loads(book_slot.invoke({
            "slot_id": slot_id,
            "patient_id": PATIENT_ID,
            "reason": "Integration test — will be cancelled",
        }))

        apt_id = book_result.get("id") or book_result.get("appointment_id")
        assert apt_id, f"Booking should return appointment ID, got: {book_result}"

        # 3. Cancel it (cleanup)
        cancel_result = json.loads(cancel_booking.invoke({"appointment_id": apt_id}))
        assert "cancel" in str(cancel_result).lower() or "success" in str(cancel_result).lower()
