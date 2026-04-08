# FHIR Appointment Creation Guide — For AI Agent

## Problem

When the AI agent books an appointment via FHIR, the patient portal shows **"Dr. TBC"** instead of the actual doctor's name. This happens because the Appointment resource is missing proper `participant` entries for the doctor.

## Root Cause

The patient portal resolves the doctor name from `Appointment.participant[]` using this logic:

1. Look for a participant where `actor.reference` starts with `Practitioner/`
2. If found, use `actor.display` — or fetch the Practitioner resource for the name
3. If NO matching participant is found → fallback to **"Dr. TBC"**

If the agent creates an Appointment **without** a Practitioner participant (or without the `actor.reference` field), the doctor name cannot be resolved.

---

## How to Fix: Correct Appointment Structure

When the agent creates a FHIR Appointment, it **MUST** include both the Patient and Practitioner as participants with proper references.

### ✅ Correct Example

```json
POST /fhir/R4/Appointment
{
  "resourceType": "Appointment",
  "status": "booked",
  "serviceType": [
    {
      "coding": [{ "display": "General Practice" }],
      "text": "General Practice"
    }
  ],
  "start": "2026-03-20T09:00:00+08:00",
  "end": "2026-03-20T09:30:00+08:00",
  "participant": [
    {
      "actor": {
        "reference": "Patient/89d893d0-550e-41ed-8670-2774cb5e8f4d",
        "display": "Amir Hassan"
      },
      "status": "accepted"
    },
    {
      "actor": {
        "reference": "Practitioner/<PRACTITIONER_ID>",
        "display": "Dr Sarah Tan"
      },
      "status": "accepted"
    }
  ],
  "description": "Back pain consultation"
}
```

### ❌ Wrong — Missing Practitioner participant

```json
{
  "participant": [
    {
      "actor": {
        "reference": "Patient/89d893d0-...",
        "display": "Amir Hassan"
      },
      "status": "accepted"
    }
  ]
}
```
This results in **"Dr. TBC"** because there is no Practitioner participant.

### ❌ Wrong — Doctor without reference

```json
{
  "participant": [
    {
      "actor": { "reference": "Patient/89d893d0-..." },
      "status": "accepted"
    },
    {
      "actor": { "display": "Dr Sarah Tan" },
      "status": "accepted"
    }
  ]
}
```
This may work but is fragile. Always include the `reference` field.

---

## How to Find the Practitioner ID

Before booking, the agent should search for practitioners by specialty:

```
GET /fhir/R4/PractitionerRole?specialty=General Practice&_include=PractitionerRole:practitioner
```

This returns PractitionerRole resources with linked Practitioner IDs. Use the `practitioner.reference` value.

Alternatively, search Practitioners directly:

```
GET /fhir/R4/Practitioner?_count=20
```

---

## Available Doctors in FHIR

| Practitioner | Specialty |
|-------------|-----------|
| Dr Sarah Tan | General Practice |
| Dr James Lim | Cardiology |
| Dr Mei Ling Wong | Endocrinology |
| Dr Rajesh Kumar | Nephrology |
| Dr Diana Chen | Orthopaedics |
| Dr Wei Lin Chua | Ophthalmology |
| Dr Priya Nair | Neurology |

---

## Available Slots

Each doctor has FHIR `Slot` resources (30-min, weekdays 9AM–5PM SGT, 14-day window).

To find free slots for a doctor:

```
GET /fhir/R4/Schedule?actor=Practitioner/<ID>
→ get Schedule ID

GET /fhir/R4/Slot?schedule=Schedule/<SCHEDULE_ID>&status=free&_sort=start&_count=10
→ returns available time windows
```

After booking, the agent should also mark the Slot as `busy`:

```
PUT /fhir/R4/Slot/<SLOT_ID>
{ ...existing slot, "status": "busy" }
```

---

## Checklist for Agent Appointment Booking

- [ ] Search for available Practitioner by specialty
- [ ] Search for free Slot resources for that Practitioner
- [ ] Create Appointment with **both** Patient and Practitioner participants
- [ ] Include `actor.reference` AND `actor.display` for both participants
- [ ] Set `start` and `end` times matching the selected Slot
- [ ] Mark the booked Slot as `busy`
