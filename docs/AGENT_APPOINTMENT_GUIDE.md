# FHIR Agent Integration Guide

> Complete reference for the AI agent to interact with the Med-SEAL FHIR server.
> All endpoints use the Medplum FHIR R4 base: `https://medseal-fhir.ngrok-free.dev/fhir/R4`

---

## 1. Appointment Booking

### Problem to Avoid: "Dr. TBC"

The patient portal shows **"Dr. TBC"** if the Appointment is missing a Practitioner participant. The portal resolves doctor names from `Appointment.participant[]`:

1. Look for participant where `actor.reference` starts with `Practitioner/`
2. Use `actor.display` — or fetch the Practitioner resource
3. If not found → **"Dr. TBC"**

### ✅ Correct Appointment Structure

```json
POST /fhir/R4/Appointment
{
  "resourceType": "Appointment",
  "status": "booked",
  "serviceType": [
    { "coding": [{ "display": "General Practice" }], "text": "General Practice" }
  ],
  "start": "2026-03-20T09:00:00+08:00",
  "end": "2026-03-20T09:30:00+08:00",
  "description": "Back pain consultation",
  "participant": [
    {
      "actor": {
        "reference": "Patient/<PATIENT_ID>",
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
  ]
}
```

> **IMPORTANT:** Always include BOTH `reference` AND `display` for both Patient and Practitioner participants. Missing either causes display issues in the portal.

### Finding Practitioners

```
GET /fhir/R4/PractitionerRole?specialty=General Practice&_include=PractitionerRole:practitioner
GET /fhir/R4/Practitioner?_count=20
```

### Finding Free Slots

```
GET /fhir/R4/Schedule?actor=Practitioner/<ID>
→ get Schedule ID

GET /fhir/R4/Slot?schedule=Schedule/<SCHEDULE_ID>&status=free&_sort=start&_count=10
→ returns available 30-min windows
```

### After Booking

Mark the Slot as `busy` to prevent double-booking:

```
PUT /fhir/R4/Slot/<SLOT_ID>
{ ...existing slot, "status": "busy" }
```

### Available Doctors

| Practitioner | Specialty | Schedule |
|-------------|-----------|----------|
| Dr Sarah Tan | General Practice | Mon–Fri 9AM–5PM |
| Dr James Lim | Cardiology | Mon–Fri 9AM–5PM |
| Dr Mei Ling Wong | Endocrinology | Mon–Fri 9AM–5PM |
| Dr Rajesh Kumar | Nephrology | Mon–Fri 9AM–5PM |
| Dr Diana Chen | Orthopaedics | Mon–Fri 9AM–5PM |
| Dr Wei Lin Chua | Ophthalmology | Mon–Fri 9AM–5PM |
| Dr Priya Nair | Neurology | Mon–Fri 9AM–5PM |

All slots are 30-minute windows, weekdays only, SGT timezone, rolling 14-day availability.

---

## 2. Pre-Visit Summary

The patient portal generates a **comprehensive pre-visit summary** that aggregates ALL patient data from FHIR. The agent should be aware of this feature to provide accurate clinical context.

### What the Pre-Visit Summary Contains

The `getPreVisitSummary(patientId)` function pulls **11 data sections** from FHIR:

| # | Section | FHIR Resource | Description |
|---|---------|--------------|-------------|
| 1 | Active Conditions | `Condition` | Diabetes, Hypertension, etc. |
| 2 | Latest Biometrics | `Observation` (vital-signs) | BP, glucose, heart rate |
| 3 | Lab Results | `Observation` (laboratory) | HbA1c, cholesterol, creatinine + HIGH/LOW flags |
| 4 | Current Medications | `MedicationRequest` | Active prescriptions + dosages |
| 5 | Medication Adherence | `MedicationAdministration` | 30-day % rate (taken vs skipped) |
| 6 | Allergies | `AllergyIntolerance` | Known drug/food allergies |
| 7 | Upcoming Appointments | `Appointment` | Scheduled visits with doctor names |
| 8 | Recent Encounters | `Encounter` | Past visit history |
| 9 | Health Goals | `Goal` | Active health goals + progress |
| 10 | Active Alerts | `Flag` | Escalation flags (🔴 high / 🟡 medium / 🟢 low) |
| 11 | Clinical Summary | Auto-generated | One paragraph combining conditions, meds, allergies, adherence, lab highlights |

### FHIR Queries the Agent Can Use

The agent can use the same FHIR queries to build clinical context:

```bash
# Conditions
GET /fhir/R4/Condition?subject=Patient/<ID>&clinical-status=active

# Vitals (latest)
GET /fhir/R4/Observation?subject=Patient/<ID>&category=vital-signs&_sort=-date&_count=20

# Lab Results
GET /fhir/R4/Observation?subject=Patient/<ID>&category=laboratory&_sort=-date&_count=10

# Active Medications
GET /fhir/R4/MedicationRequest?subject=Patient/<ID>&status=active

# Medication Adherence (last 30 days)
GET /fhir/R4/MedicationAdministration?subject=Patient/<ID>&effective-time=ge2026-02-15&_count=100

# Allergies
GET /fhir/R4/AllergyIntolerance?patient=Patient/<ID>

# Upcoming Appointments
GET /fhir/R4/Appointment?actor=Patient/<ID>&date=ge2026-03-17&status=booked&_sort=date

# Encounter History
GET /fhir/R4/Encounter?subject=Patient/<ID>&_sort=-date&_count=5

# Health Goals
GET /fhir/R4/Goal?subject=Patient/<ID>&lifecycle-status=active

# Escalation Flags
GET /fhir/R4/Flag?subject=Patient/<ID>&status=active
```

### How the Agent Should Use This

1. **Before answering clinical questions:** Query relevant FHIR data to give personalized answers
2. **When booking appointments:** Use patient conditions to recommend the right specialty
3. **When discussing medications:** Check adherence data and active prescriptions
4. **When reporting vitals:** Use latest Observations for accurate numbers
5. **When creating appointments:** Include `description` field with a relevant reason (shown as pre-visit prep)

---

## 3. Medication Tracking

### Recording Dose Taken (MedicationAdministration)

```json
POST /fhir/R4/MedicationAdministration
{
  "resourceType": "MedicationAdministration",
  "status": "completed",
  "medicationReference": { "reference": "MedicationRequest/<MED_REQUEST_ID>" },
  "subject": { "reference": "Patient/<PATIENT_ID>" },
  "effectiveDateTime": "2026-03-17T08:00:00+08:00"
}
```

### Recording Dose Skipped

```json
{
  "resourceType": "MedicationAdministration",
  "status": "not-done",
  "statusReason": [{ "coding": [{ "code": "forgot", "display": "Forgot to take" }] }],
  "medicationReference": { "reference": "MedicationRequest/<MED_REQUEST_ID>" },
  "subject": { "reference": "Patient/<PATIENT_ID>" },
  "effectiveDateTime": "2026-03-17T08:00:00+08:00"
}
```

### Getting Active Prescriptions

```
GET /fhir/R4/MedicationRequest?subject=Patient/<ID>&status=active
```

---

## 4. Appointment Cancellation & Rescheduling

### Cancel

```json
PUT /fhir/R4/Appointment/<APPOINTMENT_ID>
{ ...existing appointment, "status": "cancelled", "cancelationReason": { "text": "Patient requested" } }
```

### Reschedule

1. Cancel the old appointment (set status to `cancelled`)
2. Free the old Slot (set status back to `free`)
3. Create a new Appointment with new time
4. Mark the new Slot as `busy`

---

## 5. Checklist for Complete Agent Implementation

### Appointment Booking
- [ ] Search for Practitioner by specialty (`PractitionerRole`)
- [ ] Search for free Slot resources for that Practitioner
- [ ] Create Appointment with **both** Patient and Practitioner participants
- [ ] Include `actor.reference` AND `actor.display` for both participants
- [ ] Include `serviceType` with the specialty name
- [ ] Set `start` and `end` times matching the selected Slot
- [ ] Include `description` for pre-visit context
- [ ] Mark the booked Slot as `busy`

### Clinical Context
- [ ] Query patient Conditions before recommending specialties
- [ ] Query MedicationRequest for active medications
- [ ] Query MedicationAdministration for adherence data
- [ ] Query Observations for latest vitals and lab results
- [ ] Query AllergyIntolerance before any drug recommendations

### Data Integrity
- [ ] Always use proper FHIR references (e.g., `Patient/<ID>`, `Practitioner/<ID>`)
- [ ] Always include `display` alongside `reference` for human readability
- [ ] Use SGT timezone (`+08:00`) for all timestamps
- [ ] Use 30-minute slot windows matching the Schedule
