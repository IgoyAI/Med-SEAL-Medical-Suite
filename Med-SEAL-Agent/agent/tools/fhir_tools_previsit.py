"""Pre-visit summary FHIR tools.

Builds the 11-section pre-visit summary from FHIR resources without LLM.
"""

from __future__ import annotations

import asyncio
import concurrent.futures
from datetime import datetime, timedelta, timezone

from agent.tools.fhir_client import get_medplum


def _run(coro):
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return asyncio.run(coro)
    with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
        return pool.submit(asyncio.run, coro).result()


def _patient_ref(patient_id: str) -> str:
    return patient_id if patient_id.startswith("Patient/") else f"Patient/{patient_id}"


def _pick_text(codeable: dict) -> str:
    if not isinstance(codeable, dict):
        return ""
    txt = codeable.get("text", "")
    if txt:
        return txt
    coding = codeable.get("coding", [])
    if coding:
        return coding[0].get("display", "") or coding[0].get("code", "")
    return ""


def _fmt_when(iso_text: str) -> str:
    if not iso_text:
        return ""
    try:
        dt = datetime.fromisoformat(iso_text.replace("Z", "+00:00"))
        return dt.strftime("%d %b %Y %I:%M %p")
    except Exception:
        return iso_text


async def _get_patient_summary_async(patient_id: str) -> dict:
    fhir = get_medplum()
    pref = _patient_ref(patient_id)
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    days30 = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")

    # 1) Active Conditions
    conditions = await fhir.search("Condition", {"subject": pref, "clinical-status": "active"})
    active_conditions = []
    for c in conditions:
        name = _pick_text(c.get("code", {}))
        if name:
            active_conditions.append(name)

    # 2) Latest Biometrics
    vitals = await fhir.search(
        "Observation",
        {"subject": pref, "category": "vital-signs", "_sort": "-date", "_count": "20"},
    )
    latest_biometrics = []
    for o in vitals[:20]:
        code_name = _pick_text(o.get("code", {})) or "Observation"
        vq = o.get("valueQuantity", {})
        if vq.get("value") is not None:
            latest_biometrics.append({
                "name": code_name,
                "value": vq.get("value"),
                "unit": vq.get("unit", ""),
                "when": o.get("effectiveDateTime", ""),
            })
            continue
        # blood pressure panel style
        if o.get("component"):
            comps = []
            for comp in o.get("component", []):
                cvq = comp.get("valueQuantity", {})
                if cvq.get("value") is None:
                    continue
                comps.append({
                    "name": _pick_text(comp.get("code", {})) or "Component",
                    "value": cvq.get("value"),
                    "unit": cvq.get("unit", ""),
                })
            if comps:
                latest_biometrics.append({
                    "name": code_name,
                    "components": comps,
                    "when": o.get("effectiveDateTime", ""),
                })

    # 3) Lab Results
    labs = await fhir.search(
        "Observation",
        {"subject": pref, "category": "laboratory", "_sort": "-date", "_count": "10"},
    )
    lab_results = []
    high_labels = {"H", "HH", "HIGH", "CRIT"}
    high_labs = []
    for o in labs[:10]:
        name = _pick_text(o.get("code", {})) or "Lab"
        vq = o.get("valueQuantity", {})
        val = vq.get("value")
        unit = vq.get("unit", "")
        interp = ""
        if o.get("interpretation"):
            interp = _pick_text(o.get("interpretation", [{}])[0])
        is_high = str(interp).upper() in high_labels
        if is_high:
            high_labs.append(name)
        lab_results.append({
            "name": name,
            "value": val,
            "unit": unit,
            "interpretation": interp,
            "when": o.get("effectiveDateTime", ""),
            "high": is_high,
        })

    # 4) Current Medications
    meds = await fhir.search("MedicationRequest", {"subject": pref, "status": "active"})
    current_medications = []
    for m in meds:
        med_name = _pick_text(m.get("medicationCodeableConcept", {})) or "Medication"
        dosage = ""
        if m.get("dosageInstruction"):
            dosage = m["dosageInstruction"][0].get("text", "")
        current_medications.append({"name": med_name, "dosage": dosage})

    # 5) Medication Adherence
    med_admins = await fhir.search(
        "MedicationAdministration",
        {"subject": pref, "effective-time": f"ge{days30}", "_count": "100"},
    )
    taken = sum(1 for a in med_admins if a.get("status") == "completed")
    skipped = sum(1 for a in med_admins if a.get("status") == "not-done")
    total = taken + skipped
    adherence_percent = round((taken / total) * 100, 1) if total else None
    medication_adherence = {
        "period_days": 30,
        "taken": taken,
        "skipped": skipped,
        "adherence_percent": adherence_percent,
    }

    # 6) Allergies
    allergies_raw = await fhir.search("AllergyIntolerance", {"patient": pref})
    allergies = []
    for a in allergies_raw:
        allergies.append(_pick_text(a.get("code", {})) or "Allergy")

    # 7) Upcoming Appointments
    appointments = await fhir.search(
        "Appointment",
        {"actor": pref, "date": f"ge{today}", "status": "booked", "_sort": "date", "_count": "5"},
    )
    upcoming_appointments = []
    for a in appointments:
        doctor = ""
        for p in a.get("participant", []):
            actor = p.get("actor", {})
            ref = actor.get("reference", "")
            if ref.startswith("Practitioner/"):
                doctor = actor.get("display", "") or ref
                break
        service = ""
        if a.get("serviceType"):
            service = _pick_text(a["serviceType"][0])
        upcoming_appointments.append({
            "id": a.get("id", ""),
            "start": a.get("start", ""),
            "end": a.get("end", ""),
            "doctor": doctor,
            "service": service,
            "description": a.get("description", ""),
            "status": a.get("status", ""),
        })

    # 8) Recent Encounters
    encounters = await fhir.search("Encounter", {"subject": pref, "_sort": "-date", "_count": "5"})
    recent_encounters = []
    for e in encounters:
        etype = _pick_text(e.get("type", [{}])[0]) if e.get("type") else ""
        recent_encounters.append({
            "id": e.get("id", ""),
            "status": e.get("status", ""),
            "type": etype,
            "start": e.get("period", {}).get("start", ""),
        })

    # 9) Health Goals
    goals = await fhir.search("Goal", {"subject": pref, "lifecycle-status": "active"})
    health_goals = []
    for g in goals:
        health_goals.append({
            "id": g.get("id", ""),
            "description": _pick_text(g.get("description", {})),
            "lifecycle_status": g.get("lifecycleStatus", ""),
            "achievement_status": _pick_text(g.get("achievementStatus", {})),
        })

    # 10) Active Alerts
    flags = await fhir.search("Flag", {"subject": pref, "status": "active"})
    active_alerts = []
    for f in flags:
        active_alerts.append({
            "id": f.get("id", ""),
            "status": f.get("status", ""),
            "code": _pick_text(f.get("code", {})),
        })

    # 11) Clinical Summary (rules-only, no LLM)
    summary_parts = [
        f"Patient has {len(active_conditions)} active condition(s).",
        f"Currently on {len(current_medications)} medication(s).",
    ]
    if allergies:
        summary_parts.append(f"Known allergies: {', '.join(allergies[:5])}.")
    if adherence_percent is not None:
        if adherence_percent < 80:
            summary_parts.append(f"Medication adherence is low ({adherence_percent}%).")
        elif adherence_percent >= 95:
            summary_parts.append(f"Medication adherence is excellent ({adherence_percent}%).")
        else:
            summary_parts.append(f"Medication adherence is acceptable ({adherence_percent}%).")
    if high_labs:
        summary_parts.append(f"Elevated lab values: {', '.join(high_labs[:5])}.")

    clinical_summary = " ".join(summary_parts).strip()

    return {
        "patient_id": patient_id.replace("Patient/", ""),
        "active_conditions": active_conditions,
        "latest_biometrics": latest_biometrics,
        "lab_results": lab_results,
        "current_medications": current_medications,
        "medication_adherence": medication_adherence,
        "allergies": allergies,
        "upcoming_appointments": upcoming_appointments,
        "recent_encounters": recent_encounters,
        "health_goals": health_goals,
        "active_alerts": active_alerts,
        "clinical_summary": clinical_summary,
        "generated_at": datetime.now(timezone.utc).isoformat(),
    }


def get_patient_summary(patient_id: str) -> dict:
    return _run(_get_patient_summary_async(patient_id))

