"""Appointment FHIR tools for the Companion Agent.

Follows AGENT_APPOINTMENT_GUIDE.md:
- Slot search resolves Schedule -> Practitioner (name + specialty)
- Booking includes both Patient and Practitioner participants with reference + display
- Slot marked busy after booking, freed after cancellation
- Verification: read-back after create/update to confirm success
"""

from __future__ import annotations

import asyncio
import concurrent.futures
import logging
import re
from datetime import datetime, timedelta, timezone

from langchain_core.tools import tool

from agent.tools.fhir_client import MedplumClient
from agent.config import settings

logger = logging.getLogger(__name__)


def _run_async(coro):
    try:
        asyncio.get_running_loop()
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            return pool.submit(_run_in_new_loop, coro).result(timeout=30)
    except RuntimeError:
        return asyncio.run(coro)


def _run_in_new_loop(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def _make_fhir() -> MedplumClient:
    """Use the singleton MedplumClient (with event-loop-safe _ensure_http)."""
    from agent.tools.fhir_client import get_medplum
    return get_medplum()


def _normalize_pid(pid: str) -> str:
    return pid.replace("Patient/", "").strip()


def _practitioner_display(pract: dict) -> str:
    names = pract.get("name", [{}])
    if not names:
        return "Doctor"
    n = names[0]
    prefix = n.get("prefix", [""])[0]
    given = " ".join(n.get("given", []))
    family = n.get("family", "")
    parts = [p for p in [prefix, given, family] if p]
    return " ".join(parts) or "Doctor"


async def _resolve_schedule_practitioner(fhir: MedplumClient, schedule_ref: str) -> dict:
    result = {"practitioner_id": "", "practitioner_display": "", "specialty": ""}
    if not schedule_ref:
        return result
    sched_id = schedule_ref.replace("Schedule/", "")
    try:
        sched = await fhir.read("Schedule", sched_id)
        for actor in sched.get("actor", []):
            ref = actor.get("reference", "")
            if ref.startswith("Practitioner/"):
                result["practitioner_id"] = ref.replace("Practitioner/", "")
                result["practitioner_display"] = actor.get("display", "")
                break
        specs = sched.get("specialty", [])
        if specs:
            result["specialty"] = specs[0].get("text", "")
            if not result["specialty"]:
                codings = specs[0].get("coding", [])
                result["specialty"] = codings[0].get("display", "") if codings else ""
        if result["practitioner_id"] and not result["practitioner_display"]:
            pract = await fhir.read("Practitioner", result["practitioner_id"])
            result["practitioner_display"] = _practitioner_display(pract)
    except Exception as e:
        logger.debug("Could not resolve schedule %s: %s", schedule_ref, e)
    return result


async def _get_patient_display(fhir: MedplumClient, pid: str) -> str:
    try:
        patient = await fhir.read("Patient", _normalize_pid(pid))
        names = patient.get("name", [{}])
        if names:
            n = names[0]
            given = " ".join(n.get("given", []))
            family = n.get("family", "")
            return f"{given} {family}".strip()
    except Exception:
        pass
    return ""


def _norm_name(text: str) -> str:
    return re.sub(r"\s+", " ", (text or "").strip().lower())


def _patient_display(patient: dict) -> str:
    names = patient.get("name", [{}])
    if not names:
        return ""
    n = names[0]
    given = " ".join(n.get("given", []))
    family = n.get("family", "")
    return f"{given} {family}".strip()


async def _resolve_patient_by_name_async(name: str) -> dict:
    fhir = _make_fhir()
    try:
        q = (name or "").strip()
        if not q:
            return {"patient_id": "", "display": ""}
        patients = await fhir.search("Patient", {"name": q, "_count": "10"})
        if not patients:
            return {"patient_id": "", "display": ""}
        qn = _norm_name(q)
        best = patients[0]
        for p in patients:
            disp = _patient_display(p)
            if _norm_name(disp) == qn or qn in _norm_name(disp):
                best = p
                break
        return {"patient_id": best.get("id", ""), "display": _patient_display(best)}
    finally:
        pass  # singleton — don't close shared client


# ── Slot search ───────────────────────────────────────────────────────────

async def _search_slots_async(
    date_from: str | None = None,
    specialty: str | None = None,
    limit: int = 10,
) -> list[dict]:
    fhir = _make_fhir()
    try:
        now = datetime.now(timezone.utc)
        start = date_from or now.strftime("%Y-%m-%dT%H:%M:%SZ")
        params: dict = {
            "status": "free",
            "start": f"ge{start}",
            "_count": str(limit * 3),
            "_sort": "start",
        }
        slots = await fhir.search("Slot", params)
        seen: set[str] = set()
        results = []
        for s in slots:
            if len(results) >= limit:
                break
            schedule_ref = s.get("schedule", {}).get("reference", "")
            slot_start = s.get("start", "")
            slot_end = s.get("end", "")
            pract_info = await _resolve_schedule_practitioner(fhir, schedule_ref)
            if specialty and pract_info["specialty"]:
                if specialty.lower() not in pract_info["specialty"].lower():
                    continue
            combo = f"{pract_info['practitioner_id']}|{slot_start}"
            if combo in seen:
                continue
            seen.add(combo)
            stype = s.get("serviceType", [{}])
            service = stype[0].get("text", "") if stype else ""
            if not service and stype:
                codings = stype[0].get("coding", [])
                service = codings[0].get("display", "") if codings else ""
            if not service:
                service = pract_info["specialty"]
            results.append({
                "slot_id": s.get("id", ""),
                "start": slot_start,
                "end": slot_end,
                "status": s.get("status", ""),
                "service_type": service,
                "schedule_ref": schedule_ref,
                "practitioner_id": pract_info["practitioner_id"],
                "practitioner_display": pract_info["practitioner_display"],
                "specialty": pract_info["specialty"],
            })
        return results
    finally:
        pass  # singleton — don't close shared client


# ── List appointments ─────────────────────────────────────────────────────

async def _list_appointments_async(
    patient_id: str,
    status: str = "booked",
    limit: int = 10,
) -> list[dict]:
    fhir = _make_fhir()
    try:
        pid = _normalize_pid(patient_id)
        appointments: list[dict] = []

        for search_params in [
            {"actor": f"Patient/{pid}", "_count": str(limit), "_sort": "date"},
            {"patient": f"Patient/{pid}", "_count": str(limit), "_sort": "date"},
            {"patient": pid, "_count": str(limit), "_sort": "date"},
        ]:
            if status:
                search_params["status"] = status
            try:
                logger.info("Appointment search: %s", search_params)
                appointments = await fhir.search("Appointment", search_params)
                logger.info("Appointment search returned %d results", len(appointments))
            except Exception as e:
                logger.warning("Appointment search failed: %s", e)
                continue
            if appointments:
                break

        results = []
        for a in appointments[:limit]:
            participants = []
            for p in a.get("participant", []):
                actor = p.get("actor", {})
                participants.append({
                    "reference": actor.get("reference", ""),
                    "display": actor.get("display", ""),
                    "status": p.get("status", ""),
                })
            stype = a.get("serviceType", [{}])
            service = stype[0].get("text", "") if stype else ""
            if not service and stype:
                codings = stype[0].get("coding", [])
                service = codings[0].get("display", "") if codings else ""
            doctor = ""
            for p in participants:
                if "Practitioner" in p.get("reference", ""):
                    doctor = p.get("display", "")
                    break
            results.append({
                "appointment_id": a.get("id", ""),
                "status": a.get("status", ""),
                "start": a.get("start", ""),
                "end": a.get("end", ""),
                "service_type": service,
                "description": a.get("description", ""),
                "participants": participants,
                "doctor": doctor,
                "reason": a.get("reasonCode", [{}])[0].get("text", "") if a.get("reasonCode") else "",
            })
        return results
    finally:
        pass  # singleton — don't close shared client


# ── Book appointment ──────────────────────────────────────────────────────

async def _book_appointment_async(
    patient_id: str,
    slot_id: str | None = None,
    start: str | None = None,
    end: str | None = None,
    reason: str = "",
    description: str = "",
    practitioner_id: str | None = None,
    practitioner_display: str | None = None,
    service_type: str | None = None,
) -> dict:
    fhir = _make_fhir()
    try:
        pid = _normalize_pid(patient_id)
        patient_ref = f"Patient/{pid}"

        if slot_id and (not practitioner_id or not practitioner_display):
            try:
                slot_resource = await fhir.read("Slot", slot_id)
                sched_ref = slot_resource.get("schedule", {}).get("reference", "")
                pract_info = await _resolve_schedule_practitioner(fhir, sched_ref)
                practitioner_id = practitioner_id or pract_info["practitioner_id"]
                practitioner_display = practitioner_display or pract_info["practitioner_display"]
                service_type = service_type or pract_info["specialty"]
                start = start or slot_resource.get("start", "")
                end = end or slot_resource.get("end", "")
            except Exception as e:
                logger.warning("Could not resolve slot %s: %s", slot_id, e)

        if not start:
            now = datetime.now(timezone.utc) + timedelta(days=1)
            start = now.replace(hour=9, minute=0, second=0).isoformat()
        if not end:
            start_dt = datetime.fromisoformat(start.replace("Z", "+00:00"))
            end = (start_dt + timedelta(minutes=30)).isoformat()

        patient_display = await _get_patient_display(fhir, pid)

        participants = [{
            "actor": {"reference": patient_ref, "display": patient_display or pid},
            "status": "accepted",
        }]
        if practitioner_id:
            if not practitioner_display:
                try:
                    pract = await fhir.read("Practitioner", practitioner_id)
                    practitioner_display = _practitioner_display(pract)
                except Exception:
                    practitioner_display = "Doctor"
            participants.append({
                "actor": {
                    "reference": f"Practitioner/{practitioner_id}",
                    "display": practitioner_display,
                },
                "status": "accepted",
            })

        appointment: dict = {
            "resourceType": "Appointment",
            "status": "booked",
            "start": start,
            "end": end,
            "participant": participants,
            "description": description or "Appointment booked via Med-SEAL",
        }
        if service_type:
            appointment["serviceType"] = [
                {"coding": [{"display": service_type}], "text": service_type}
            ]
        if reason:
            appointment["reasonCode"] = [{"text": reason}]
        if slot_id:
            appointment["slot"] = [{"reference": f"Slot/{slot_id}"}]

        result = await fhir.create("Appointment", appointment)
        appointment_id = result.get("id", "")

        # ── Verification: read-back with retry ──
        verified = False
        if appointment_id:
            for attempt in range(3):
                try:
                    if attempt > 0:
                        await asyncio.sleep(0.5 * attempt)
                    readback = await fhir.read("Appointment", appointment_id)
                    if readback.get("status") == "booked":
                        verified = True
                        break
                except Exception as e:
                    logger.warning("Read-back attempt %d failed for %s: %s", attempt + 1, appointment_id, e)
            if not verified:
                logger.warning("Appointment %s created but verification failed after 3 attempts", appointment_id)

        # ── Mark slot busy ──
        if slot_id:
            try:
                existing_slot = await fhir.read("Slot", slot_id)
                existing_slot["status"] = "busy"
                await fhir.update("Slot", slot_id, existing_slot)
            except Exception as e:
                logger.warning("Could not mark slot %s as busy: %s", slot_id, e)

        return {
            "appointment_id": appointment_id,
            "status": result.get("status", ""),
            "start": result.get("start", start),
            "end": result.get("end", end),
            "practitioner": practitioner_display or "",
            "service_type": service_type or "",
            "booked": bool(appointment_id and verified),
        }
    finally:
        pass  # singleton — don't close shared client


# ── Cancel appointment ────────────────────────────────────────────────────

async def _cancel_appointment_async(
    appointment_id: str,
    reason: str = "Cancelled by patient via Med-SEAL",
) -> dict:
    fhir = _make_fhir()
    try:
        existing = await fhir.read("Appointment", appointment_id)
        existing["status"] = "cancelled"
        existing["cancelationReason"] = {"text": reason}

        for sr in existing.get("slot", []):
            slot_ref = sr.get("reference", "")
            if slot_ref.startswith("Slot/"):
                slot_id = slot_ref.replace("Slot/", "")
                try:
                    slot_resource = await fhir.read("Slot", slot_id)
                    slot_resource["status"] = "free"
                    await fhir.update("Slot", slot_id, slot_resource)
                except Exception:
                    pass

        await fhir.update("Appointment", appointment_id, existing)

        verified = False
        for attempt in range(3):
            try:
                if attempt > 0:
                    await asyncio.sleep(0.5 * attempt)
                readback = await fhir.read("Appointment", appointment_id)
                if readback.get("status") == "cancelled":
                    verified = True
                    break
            except Exception as e:
                logger.warning("Cancel verify attempt %d failed for %s: %s", attempt + 1, appointment_id, e)

        return {
            "appointment_id": appointment_id,
            "status": "cancelled",
            "cancelled": verified,
        }
    finally:
        pass  # singleton — don't close shared client


# ── Sync wrappers (used internally) ──────────────────────────────────────

def search_available_slots(**kwargs) -> list[dict]:
    return _run_async(_search_slots_async(**kwargs))


def list_patient_appointments(patient_id: str, **kwargs) -> list[dict]:
    return _run_async(_list_appointments_async(patient_id, **kwargs))


def book_appointment(patient_id: str, **kwargs) -> dict:
    return _run_async(_book_appointment_async(patient_id, **kwargs))


def cancel_appointment(appointment_id: str, **kwargs) -> dict:
    return _run_async(_cancel_appointment_async(appointment_id, **kwargs))


def resolve_patient_by_name(name: str) -> dict:
    return _run_async(_resolve_patient_by_name_async(name))


# ── LLM-callable tools (bound to Companion agent) ───────────────────────

@tool
def search_slots(specialty: str = "", date_from: str = "", limit: int = 5) -> str:
    """Search for available appointment slots.

    Args:
        specialty: Optional specialty filter (e.g. "Cardiology", "Endocrinology", "General Practice")
        date_from: Optional start date in ISO format (YYYY-MM-DD). Defaults to now.
        limit: Maximum number of slots to return (default 5)

    Returns: JSON list of available slots with doctor name, specialty, date/time, and slot_id.
    """
    import json
    kwargs: dict = {"limit": limit}
    if specialty:
        kwargs["specialty"] = specialty
    if date_from:
        kwargs["date_from"] = f"{date_from}T00:00:00Z" if "T" not in date_from else date_from
    slots = search_available_slots(**kwargs)
    # Format for LLM readability
    results = []
    for i, s in enumerate(slots[:limit], 1):
        results.append({
            "option": i,
            "slot_id": s.get("slot_id", ""),
            "doctor": s.get("practitioner_display", ""),
            "specialty": s.get("specialty", "") or s.get("service_type", ""),
            "start": s.get("start", ""),
            "end": s.get("end", ""),
        })
    return json.dumps({"slots": results, "count": len(results)})


@tool
def book_slot(slot_id: str, patient_id: str, reason: str = "") -> str:
    """Book a specific appointment slot for the patient.

    Args:
        slot_id: The slot ID from search_slots results
        patient_id: The patient's FHIR ID
        reason: Optional reason for the appointment

    Returns: JSON with booking confirmation including appointment_id, doctor, and time.
    """
    import json
    result = book_appointment(patient_id, slot_id=slot_id, reason=reason)
    return json.dumps({
        "booked": result.get("booked", False),
        "appointment_id": result.get("appointment_id", ""),
        "doctor": result.get("practitioner", ""),
        "start": result.get("start", ""),
        "service_type": result.get("service_type", ""),
    })


@tool
def cancel_booking(appointment_id: str) -> str:
    """Cancel an existing appointment.

    Args:
        appointment_id: The appointment ID to cancel

    Returns: JSON with cancellation confirmation.
    """
    import json
    result = cancel_appointment(appointment_id)
    return json.dumps({
        "cancelled": result.get("cancelled", False),
        "appointment_id": result.get("appointment_id", ""),
    })


@tool
def list_appointments(patient_id: str, status: str = "booked") -> str:
    """List the patient's appointments.

    Args:
        patient_id: The patient's FHIR ID
        status: Filter by status (default "booked"). Use "" for all.

    Returns: JSON list of appointments with doctor, date/time, service type.
    """
    import json
    appts = list_patient_appointments(patient_id, status=status, limit=10)
    results = []
    for i, a in enumerate(appts, 1):
        results.append({
            "number": i,
            "appointment_id": a.get("appointment_id", ""),
            "doctor": a.get("doctor", ""),
            "start": a.get("start", ""),
            "service_type": a.get("service_type", ""),
            "status": a.get("status", ""),
            "reason": a.get("reason", ""),
        })
    return json.dumps({"appointments": results, "count": len(results)})


APPOINTMENT_TOOLS = [search_slots, book_slot, cancel_booking, list_appointments]
