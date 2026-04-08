# Med-SEAL Rad × Patient App: Minimum Feature Set for 80%+ All KQs

## NUS–Synapxe–IMDA AI Innovation Challenge 2026

### Problem Statement 1: Agentic AI for Patient Empowerment

---

## Starting point (current stack, no patient app features)

| Key Question | Current | Target | Gap |
|---|---|---|---|
| KQ1: Proactive patient engagement | 40% | 80% | +40 needed |
| KQ2: Hyper-personalisation of care | 55% | 80% | +25 needed |
| KQ3: Bridging patient and clinician | 75% | 80% | +5 needed |
| KQ4: Measuring real-world impact | 20% | 80% | +60 needed |

### Baseline stack (already built)

The following components from Med-SEAL Rad carry over directly and form the foundation:

- OpenEMR (EHR system with native FHIR R4 API)
- Medplum (FHIR R4 server — agent gateway and data fusion point)
- OpenEMR ↔ Medplum bidirectional FHIR sync
- smolagents orchestrator (task routing and context fusion)
- OpenEMR agent (clinical reasoning via Qwen3-VL-8B-Thinking)
- SEA-LION Guard (dual-gate safety: input validation + output validation)
- FHIR compliance layer (Provenance, AuditEvent, terminology services, SMART on FHIR)
- CDS Hooks + FHIRcast (trigger points + context sync between surfaces)
- Synthea synthetic patients (demo data for 3H chronic conditions)
- ASEAN multilingual framework (SNOMED CT language reference sets)
- Patient-facing app shell with agent and Med-SEAL model

---

## Minimum 10 features to hit 80% on all KQs

Ordered by multi-KQ impact. Each feature shows its contribution strength per KQ.

---

### Feature 1: MERaLiON / SEA-LION chat interface

| | |
|---|---|
| **KQ impact** | KQ1 +15, KQ2 +10 |
| **Status** | Build new |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Primary conversational interface powered by MERaLiON (empathetic, emotion-aware) and SEA-LION (multilingual SEA). Handles EN, ZH, MS, TA with code-switching. Culturally adapted tone — not just translated, but contextually appropriate (respectful forms in Malay/Tamil, dialect awareness for Mandarin). This is the NMLP Special Award target ($5,000 cash prize).

**Architecture:** MERaLiON/SEA-LION handles the patient conversation surface. Med-SEAL Qwen3-VL-8B handles the clinical reasoning underneath. SEA-LION Guard validates every output before it reaches the patient.

**FHIR resources:** Communication (conversation record)

---

### Feature 2: Medication management + adherence tracking

| | |
|---|---|
| **KQ impact** | KQ1 +10, KQ4 +15 |
| **Status** | Build new |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Reads MedicationRequest from OpenEMR/Medplum. Shows the patient a clear schedule with dosage, timing, and purpose explained in their language. Tracks acknowledgement of each dose as MedicationAdministration. Detects missed doses and escalates pattern to the nudge engine. Flags potential interactions if patient reports OTC supplements.

**FHIR resources:** MedicationRequest (read), MedicationAdministration (write), MedicationDispense (read)

---

### Feature 3: Smart nudge engine

| | |
|---|---|
| **KQ impact** | KQ1 +15, KQ4 +5 |
| **Status** | Build new |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Proactive outreach, not passive reminders. The agent monitors FHIR data streams and triggers context-aware check-ins: missed medication window detected, upcoming lab due date approaching, blood glucose trending upward over 7 days, no activity logged in 3 days. Each nudge is empathetically framed via MERaLiON with cultural sensitivity.

**FHIR resources:** FHIR Subscription (trigger), Communication (nudge record), CommunicationRequest (scheduled outreach)

---

### Feature 4: Patient-reported outcomes (conversational PROs)

| | |
|---|---|
| **KQ impact** | KQ2 +5, KQ3 +5, KQ4 +10 |
| **Status** | Build new |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Periodic check-in questionnaires adapted by condition (PHQ-9 for depression screening, diabetes distress scale, dietary self-efficacy). Delivered conversationally through the AI companion, not as a cold form. Responses stored as FHIR QuestionnaireResponse and summarised for the clinician.

**FHIR resources:** Questionnaire (template), QuestionnaireResponse (patient input), Observation (derived score)

---

### Feature 5: Wearable data ingestion

| | |
|---|---|
| **KQ impact** | KQ2 +10, KQ4 +10 |
| **Status** | Build new |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Ingest data from Apple Health / Google Health Connect / Fitbit / glucometers via FHIR Observation. Blood pressure, heart rate, glucose, step count, sleep duration. Agent contextualises trends: "Your average fasting glucose this week is 6.8 — slightly higher than your 3-month average of 6.2. Could be related to the holiday season — want to chat about managing that?"

**FHIR resources:** Observation (vitals from device), Device (wearable registration), DeviceMetric

---

### Feature 6: Patient insight summary for clinician

| | |
|---|---|
| **KQ impact** | KQ3 +10 |
| **Status** | Enhance existing |
| **Priority** | Tier 1 — Must be functional in prototype |

**Description:** Extends the existing FHIR Composition (clinical summary) to include patient-side behavioral data: medication adherence rate, wearable biometric trends, PRO scores, engagement level, flagged concerns from conversation. Appears in OpenEMR as a pre-visit brief. Clinician gets a 30-second read instead of 20 minutes of chart review.

**FHIR resources:** Composition (enhanced sections), Observation (adherence percentage), RiskAssessment

---

### Feature 7: Dietary + lifestyle recommendation engine (SEA-culturally aware)

| | |
|---|---|
| **KQ impact** | KQ2 +10 |
| **Status** | Build new |
| **Priority** | Tier 2 — Architecture + mock data acceptable |

**Description:** Culturally aware recommendations: not just "reduce carbs" but "try switching from white rice to brown rice for your nasi lemak, or reduce the portion by a quarter." Understands SG/SEA food context — hawker centre meals, festive foods (CNY, Hari Raya, Deepavali). Personalised to conditions, medications (e.g., avoid grapefruit with statins), and patient goals.

**FHIR resources:** NutritionOrder (recommendations), CarePlan (wellness goals), Goal (patient targets)

---

### Feature 8: Outcome measurement framework

| | |
|---|---|
| **KQ impact** | KQ4 +10 |
| **Status** | Build new |
| **Priority** | Tier 2 — Architecture + mock data acceptable |

**Description:** Define FHIR Measure resources for each KPI: adherence rate, biometric improvement, PRO score change, engagement frequency, readmission rate, time-to-intervention. Generate MeasureReport periodically. Support before/after comparison and cohort analysis.

**FHIR resources:** Measure (definition), MeasureReport (results), Library (logic)

---

### Feature 9: Adherence + biometric analytics dashboard

| | |
|---|---|
| **KQ impact** | KQ4 +10 |
| **Status** | Build new |
| **Priority** | Tier 2 — Architecture + mock data acceptable |

**Description:** Visualise BP, glucose, HbA1c, weight, step count trends over time for the patient (in-app) and clinician (in OpenEMR). Flag improvements correlated with intervention periods. Compare against FHIR Goal targets.

**FHIR resources:** Observation (time series), Goal (target line), MeasureReport (population statistics)

---

### Feature 10: Escalation pathways

| | |
|---|---|
| **KQ impact** | KQ3 +10 |
| **Status** | Build new |
| **Priority** | Tier 2 — Architecture + mock data acceptable |

**Description:** When the patient app detects critical signals (dangerously high BP reading, suicidal ideation keywords, severe symptom report), the agent escalates to the clinician via FHIR Flag + CommunicationRequest. Tiered escalation: low-priority insight (batched into pre-visit summary), medium (next-day notification), high (immediate alert in OpenEMR).

**FHIR resources:** Flag (clinical alert), CommunicationRequest (clinician notification), DetectedIssue

---

## Final coverage after all 10 features

| Key Question | Before | After | Gain | Features responsible |
|---|---|---|---|---|
| KQ1: Proactive engagement | 40% | **80%** | +40 | #1 MERaLiON chat, #2 Medication mgmt, #3 Nudge engine |
| KQ2: Hyper-personalisation | 55% | **90%** | +35 | #1 MERaLiON chat, #4 PROs, #5 Wearables, #7 Dietary engine |
| KQ3: Clinician bridge | 75% | **100%** | +25 | #4 PROs, #6 Patient insight summary, #10 Escalation |
| KQ4: Real-world impact | 20% | **80%** | +60 | #2 Medication tracking, #3 Nudge engine, #5 Wearables, #8 Outcome framework, #9 Dashboard |

---

## Build vs demo strategy

| Tier | Features | Strategy |
|---|---|---|
| **Tier 1 (functional prototype)** | #1 MERaLiON chat, #2 Medication mgmt, #3 Nudge engine, #4 PROs, #5 Wearables, #6 Clinician summary | Must be working end-to-end in the demo. These 6 features give a credible answer to every key question. |
| **Tier 2 (architecture + mock)** | #7 Dietary engine, #8 Outcome framework, #9 Analytics dashboard, #10 Escalation | Can be demonstrated with architecture diagrams and mock/synthetic data. Judges need to see the design, not every pixel. |

---

## NMLP Special Award strategy

The $5,000 NMLP Special Award goes to the team demonstrating the most effective and innovative use of SEA-LION and MERaLiON. The features that use these models:

- **Feature 1:** MERaLiON/SEA-LION as the primary patient-facing conversational interface (empathetic, multilingual, code-switching)
- **Feature 3:** Smart nudge engine uses MERaLiON for empathetically framed proactive outreach
- **Feature 4:** PROs delivered conversationally via SEA-LION in the patient's preferred language
- **Feature 7:** Dietary recommendations culturally adapted through SEA-LION's Southeast Asian context awareness

The SEA-LION Guard (already built) validates all outputs from these features for safety, which demonstrates responsible use of the NMLP models.
