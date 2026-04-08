# Pre-Visit Summary — Agent Feature Guide

> The patient portal auto-generates a **comprehensive pre-visit summary** from FHIR before each appointment. The agent should leverage this feature and can also query the same data.

---

## What Is It?

A single API call — `getPreVisitSummary(patientId)` — aggregates **all** available patient data from FHIR into 11 structured sections. The portal displays this before appointments so doctors come prepared.

The agent should:
1. **Know this exists** — don't re-invent patient data aggregation
2. **Use the same FHIR queries** — to provide personalized clinical answers
3. **Contribute to it** — by writing proper FHIR data (e.g., appointment descriptions become pre-visit prep notes)

---

## 11 Data Sections

| # | Section | FHIR Resource | Example Output |
|---|---------|--------------|----------------|
| 1 | **Active Conditions** | `Condition` | Type 2 Diabetes Mellitus, Essential Hypertension, Hyperlipidemia |
| 2 | **Latest Biometrics** | `Observation` (vital-signs) | BP: 132/82 mmHg. Glucose: 6.1 mmol/L. HR: 72 bpm. |
| 3 | **Lab Results** | `Observation` (laboratory) | HbA1c: 6.8% (HIGH), LDL Cholesterol: 3.2 mmol/L (HIGH) |
| 4 | **Current Medications** | `MedicationRequest` | • Metformin 500mg — twice daily with meals |
| 5 | **Medication Adherence** | `MedicationAdministration` | 30-day adherence: 87% (26 taken, 4 skipped) |
| 6 | **Allergies** | `AllergyIntolerance` | ⚠️ Penicillin, Shellfish |
| 7 | **Upcoming Appointments** | `Appointment` | 20 Mar 09:00 AM — Dr Mei Ling Wong (Endocrinology) |
| 8 | **Recent Encounters** | `Encounter` | 8 Mar — Routine diabetes follow-up (completed) |
| 9 | **Health Goals** | `Goal` | HbA1c < 6.5% 🔄, Weight loss target: 75 kg |
| 10 | **Active Alerts** | `Flag` | 🔴 Elevated blood glucose trend |
| 11 | **Clinical Summary** | Auto-generated | One paragraph combining everything (see below) |

---

## Clinical Summary Example

> Patient has 3 active condition(s): Type 2 Diabetes Mellitus, Essential Hypertension, Hyperlipidemia. Currently on 4 medication(s). Known allergies: Penicillin, Shellfish. Medication adherence is acceptable (87%). Elevated lab values: HbA1c, LDL Cholesterol.

This summary is auto-generated from the other 10 sections — no LLM required. It flags:
- Low adherence (<80%) with ⚠️ warning
- Excellent adherence (≥95%) with ✅ 
- Any lab values marked HIGH

---

## FHIR Queries (Copy-Paste Ready)

Replace `<PID>` with the patient's FHIR ID.

```bash
# 1. Active Conditions
GET /fhir/R4/Condition?subject=Patient/<PID>&clinical-status=active

# 2. Vital Signs (latest 20)
GET /fhir/R4/Observation?subject=Patient/<PID>&category=vital-signs&_sort=-date&_count=20

# 3. Lab Results (latest 10)
GET /fhir/R4/Observation?subject=Patient/<PID>&category=laboratory&_sort=-date&_count=10

# 4. Active Medications
GET /fhir/R4/MedicationRequest?subject=Patient/<PID>&status=active

# 5. Medication Adherence (last 30 days)
GET /fhir/R4/MedicationAdministration?subject=Patient/<PID>&effective-time=ge<30_DAYS_AGO>&_count=100
# status=completed → taken, status=not-done → skipped

# 6. Allergies
GET /fhir/R4/AllergyIntolerance?patient=Patient/<PID>

# 7. Upcoming Appointments
GET /fhir/R4/Appointment?actor=Patient/<PID>&date=ge<TODAY>&status=booked&_sort=date&_count=5

# 8. Recent Encounters
GET /fhir/R4/Encounter?subject=Patient/<PID>&_sort=-date&_count=5

# 9. Health Goals
GET /fhir/R4/Goal?subject=Patient/<PID>&lifecycle-status=active

# 10. Escalation Flags
GET /fhir/R4/Flag?subject=Patient/<PID>&status=active
```

---

## How the Agent Should Use This

### When answering clinical questions
Query the relevant FHIR resources first. Example: patient asks "How is my blood sugar?" → query Observation for glucose + HbA1c, cross-reference with MedicationRequest for diabetes meds.

### When booking appointments
Use Conditions to recommend the right specialty. Example: patient has diabetes → suggest Endocrinology. Include a useful `description` in the Appointment — this becomes the pre-visit prep note.

### When discussing medications
Check `MedicationAdministration` adherence data. If <80%, gently encourage better adherence. Reference the specific medications from `MedicationRequest`.

### When the patient asks "What should I prepare for my visit?"
The pre-visit summary already covers this! Direct them to check their upcoming appointment details in the app, which shows all 11 sections.

---

## Agent Tool Integration Suggestion

The agent should have a tool like:

```
Tool: get_patient_summary
Input: { patient_id: string }
Output: Pre-visit summary with all 11 sections
```

This tool calls the same FHIR queries listed above and returns a structured JSON. The agent can then use this as context for any patient-related conversation.
