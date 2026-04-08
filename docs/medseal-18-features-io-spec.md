# Med-SEAL Patient Empowerment: 18 Features End-to-End I/O Specification

## Agent Instruction Document

This document defines every feature's input, processing, output, FHIR resources, agent assignment, and trigger conditions. Use this as the contract between the smolagents orchestrator and each agent.

---

## System agents

| ID | Agent | Model | Surface |
|---|---|---|---|
| A1 | Companion Agent | MERaLiON + SEA-LION | Patient app |
| A2 | Clinical Reasoning Agent | Qwen3-VL-8B (Med-SEAL) | Both |
| A3 | Nudge Agent | MERaLiON + rule engine | Patient app |
| A4 | Lifestyle Agent | SEA-LION + nutrition KB | Patient app |
| A5 | Insight Synthesis Agent | Qwen3-VL-8B (Med-SEAL) | OpenEMR |
| A6 | Measurement Agent | Analytics engine (no LLM) | Both |
| SYS | SEA-LION Guard | SEA-LION Guard | System-wide |
| SYS | smolagents Orchestrator | Rule-based router | System-wide |

---

## Tier 1: Must be functional in prototype

---

### F01: MERaLiON / SEA-LION Chat Interface

**Agent:** A1 (Companion Agent)
**KQ impact:** KQ1 +15, KQ2 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Patient | Free-text message (EN, ZH, MS, TA) | UTF-8 string via app WebSocket |
| Patient | Preferred language setting | ISO 639-1 code from user profile |
| Patient | Conversation history (last 20 turns) | Array of {role, content, timestamp} |
| Medplum | Patient demographics | FHIR Patient (name, age, gender, language) |
| Medplum | Active conditions | FHIR Condition (code, clinicalStatus) |
| Medplum | Current medications | FHIR MedicationRequest (medication, dosage) |
| SEA-LION Guard | Input validation result | PASS / BLOCK / MODIFY + reason |

#### Processing

1. SEA-LION Guard validates patient input (prompt injection, toxicity, PII check).
2. Orchestrator classifies intent: casual / medical / dietary / PRO / escalation.
3. If casual or general health: Companion Agent (A1) responds directly using MERaLiON for empathetic tone + SEA-LION for language.
4. If medical query requiring EHR synthesis: A1 delegates to Clinical Reasoning Agent (A2), receives structured answer, then rephrases in patient-friendly language via MERaLiON.
5. If dietary/lifestyle question: A1 delegates to Lifestyle Agent (A4).
6. SEA-LION Guard validates output before delivery.

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | AI response text | UTF-8 string (patient's language) |
| Patient app | Suggested follow-up actions (optional) | Array of {label, action_type} |
| Medplum | Conversation record | FHIR Communication (sender=Device/companion-agent, recipient=Patient/{id}, payload=text, sent=timestamp) |
| Medplum | Audit log | FHIR AuditEvent (agent=Device/companion-agent, entity=Patient/{id}, action=E) |

#### Example flow

```
Patient (ZH): "我今天早上血压有点高，要不要吃药？"
  --> Guard: PASS
  --> Orchestrator: medical query, delegate to A2
  --> A2: reads MedicationRequest for antihypertensives, reads latest Observation (BP)
  --> A2 returns: "Patient is on amlodipine 5mg daily. Latest BP 148/92. Medication taken today: unknown."
  --> A1 rephrases via MERaLiON (ZH, empathetic):
      "您今天的血压确实偏高一些。您今天早上的降压药（氨氯地平5毫克）吃了吗？
       如果还没有的话，建议现在服用。如果已经吃了还是高，可以先休息一下，
       明天跟医生提一下。"
  --> Guard: PASS
  --> Deliver to patient
```

---

### F02: Medication Management + Adherence Tracking

**Agent:** A2 (Clinical Reasoning) + A3 (Nudge) + A1 (Companion)
**KQ impact:** KQ1 +10, KQ4 +15

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | Active prescriptions | FHIR MedicationRequest (medication[x], dosageInstruction, authoredOn, requester) |
| Medplum | Dispensed medications | FHIR MedicationDispense (whenHandedOver, quantity) |
| Patient app | Dose confirmation tap | {medicationRequestId, timestamp, status: taken/skipped/delayed} |
| Patient app | OTC supplement report (free text) | String via chat interface |
| Medplum | Drug interaction database | Terminology lookup (RxNorm + NDF-RT) |

#### Processing

1. A2 reads all active MedicationRequests for Patient/{id} from Medplum.
2. A2 parses dosageInstruction (timing, route, dose) into a daily schedule.
3. Patient app displays schedule with medication name, dose, timing, and purpose (A1 explains in patient language).
4. On dose confirmation: write MedicationAdministration to Medplum.
5. On skipped dose: A3 (Nudge Agent) activates a gentle reminder after configurable delay.
6. On OTC supplement report: A2 checks drug-drug and drug-food interactions via RxNorm/$translate.
7. Weekly: A6 (Measurement Agent) computes PDC (proportion of days covered) per medication.

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Daily medication schedule | JSON array: [{med_name, dose, time, purpose_text, status}] |
| Patient app | Interaction warning (if any) | {severity: low/medium/high, message, conflicting_items[]} |
| Medplum | Dose event | FHIR MedicationAdministration (status=completed/not-done, effectiveDateTime, medicationReference, dosage) |
| Medplum | Adherence metric | FHIR Observation (code=medseal:adherence-pdc, valueQuantity={value, unit="%"}, effectivePeriod) |
| A3 | Missed dose signal | {patient_id, medication_id, expected_time, current_time, gap_minutes} |

---

### F03: Smart Nudge Engine

**Agent:** A3 (Nudge Agent)
**KQ impact:** KQ1 +15, KQ4 +5

#### Input

| Source | Data | Format |
|---|---|---|
| FHIR Subscription | Missed dose event | Triggered when MedicationAdministration not written within dosage window |
| FHIR Subscription | High biometric reading | Triggered when Observation (BP/glucose) exceeds threshold |
| Cron scheduler | Daily engagement check | Runs at configurable time (e.g., 9:00 AM patient timezone) |
| Cron scheduler | Upcoming appointment reminder | 72h, 24h, 2h before Appointment.start |
| Medplum | Patient engagement history | Last 7 days of Communication resources (sent by system) |
| Medplum | Patient preferences | FHIR Patient.communication (preferred language), notification opt-in |
| A6 | Engagement decay signal | {patient_id, days_since_last_interaction, trend: declining/stable} |

#### Processing

1. Rule engine evaluates trigger conditions against thresholds (configurable per condition).
2. If trigger fires: construct nudge context (what happened, severity, patient history).
3. MERaLiON generates empathetic, culturally appropriate nudge message in patient's language.
4. SEA-LION Guard validates nudge content.
5. Tiered escalation decision:
   - Low: patient nudge only (e.g., gentle medication reminder).
   - Medium: patient nudge + next-day clinician flag (e.g., 3 consecutive missed doses).
   - High: immediate clinician alert (e.g., BP > 180/120 or suicidal ideation keywords).

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Push notification + in-app message | {title, body, action_type, priority} |
| Medplum | Nudge delivery record | FHIR Communication (category=notification, payload=nudge_text, sent=timestamp, status=completed) |
| Medplum | Scheduled follow-up | FHIR CommunicationRequest (status=active, occurrenceDateTime, payload=planned_nudge) |
| Medplum (if escalation) | Clinical alert | FHIR Flag (status=active, code=medseal:escalation-{level}, subject=Patient/{id}, period.start) |
| Medplum (if escalation) | Clinician notification | FHIR CommunicationRequest (recipient=Practitioner/{id}, priority=urgent/routine) |

---

### F04: Conversational PROs (Patient-Reported Outcomes)

**Agent:** A1 (Companion Agent)
**KQ impact:** KQ2 +5, KQ3 +5, KQ4 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | PRO questionnaire template | FHIR Questionnaire (item[], subjectType=Patient, code=LOINC) |
| Medplum | Patient active conditions | FHIR Condition (to select appropriate questionnaire: PHQ-9 for depression, DDS-17 for diabetes distress, etc.) |
| Medplum | Previous PRO responses | FHIR QuestionnaireResponse (authored, item[].answer) for trend comparison |
| A3 | PRO schedule trigger | {patient_id, questionnaire_id, reason: "bi-weekly diabetes distress check"} |
| Patient | Conversational responses | Free text answers during chat (not form fields) |

#### Processing

1. A3 triggers PRO collection per schedule (e.g., bi-weekly for diabetes distress, monthly for PHQ-9).
2. A1 (Companion) delivers questions conversationally: instead of "Rate your distress 1-5", the agent asks "How have you been feeling about managing your diabetes this past week? Has it been weighing on you?"
3. A1 maps patient's free-text responses to structured Questionnaire item answers using MERaLiON's emotion recognition.
4. A1 computes derived scores (e.g., PHQ-9 total, DDS-17 domain scores).
5. Scores stored as FHIR Observation for trending.
6. If score exceeds clinical threshold (e.g., PHQ-9 >= 10): trigger A3 escalation pathway.

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Conversational PRO interaction | Chat messages (questions + empathetic responses to answers) |
| Medplum | Structured PRO response | FHIR QuestionnaireResponse (questionnaire=Questionnaire/{id}, item[].answer, authored) |
| Medplum | Derived PRO score | FHIR Observation (code=LOINC for specific instrument, valueQuantity=total_score, component[]=domain_scores) |
| A3 | Threshold breach alert | {patient_id, instrument, score, threshold, severity} |
| A5 | PRO summary for clinician | {patient_id, instrument, current_score, previous_score, delta, trend_direction} |

---

### F05: Wearable Data Ingestion

**Agent:** A6 (Measurement Agent) + A3 (Nudge Agent)
**KQ impact:** KQ2 +10, KQ4 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Apple Health / Google Health Connect | Vitals data | HealthKit/Health Connect API: heart_rate, blood_pressure_systolic, blood_pressure_diastolic, blood_glucose, step_count, sleep_duration, weight, SpO2 |
| Bluetooth glucometer | Blood glucose reading | Device-specific BLE GATT profile, parsed by app |
| Patient app | Manual entry | {type: "blood_pressure", systolic: 142, diastolic: 88, timestamp, device: "manual"} |
| Medplum | Device registration | FHIR Device (manufacturer, model, type, patient) |
| Medplum | Patient condition context | FHIR Condition (for threshold configuration: diabetic patients get glucose thresholds) |

#### Processing

1. Patient app reads from HealthKit / Health Connect at configurable intervals (default: every 30 minutes for passive data, immediate for manual entry).
2. App maps readings to FHIR Observation resources with appropriate LOINC codes:
   - Blood pressure systolic: LOINC 8480-6
   - Blood pressure diastolic: LOINC 8462-4
   - Blood glucose: LOINC 2345-7
   - Heart rate: LOINC 8867-4
   - Step count: LOINC 55423-8
   - Body weight: LOINC 29463-7
3. Batch upload to Medplum via FHIR transaction Bundle (max 50 observations per bundle).
4. A6 computes rolling averages (7-day, 30-day) and trend direction.
5. A3 monitors for threshold breaches and triggers nudges/escalation.
6. A1 contextualises trends when patient asks: "Your average fasting glucose this week is 6.8, slightly higher than your 3-month average of 6.2."

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Vital sign observations | FHIR Observation (code=LOINC, valueQuantity, effectiveDateTime, device=Device/{id}, subject=Patient/{id}) |
| Medplum | Device metadata | FHIR Device (status=active, type, manufacturer, serialNumber, patient) |
| Medplum | Computed averages | FHIR Observation (code=medseal:7day-avg-{vital}, valueQuantity, method=computed) |
| A3 | Threshold breach event | {patient_id, vital_type, value, threshold, direction: above/below, timestamp} |
| A1 | Trend context for chat | {vital_type, current_value, 7day_avg, 30day_avg, trend: rising/stable/falling} |
| Patient app | Trend visualization data | JSON array for chart rendering: [{date, value, avg_line, goal_line}] |

---

### F06: Patient Insight Summary for Clinician

**Agent:** A5 (Insight Synthesis Agent)
**KQ impact:** KQ3 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | Medication adherence data | FHIR Observation (code=medseal:adherence-pdc, per medication, last 30 days) |
| Medplum | Wearable biometric trends | FHIR Observation (BP, glucose, weight, steps: last 30 days) |
| Medplum | PRO scores | FHIR Observation (PHQ-9, DDS-17, etc.: current + previous) |
| Medplum | Engagement metrics | FHIR Communication (count of patient-initiated interactions, nudge response rate) |
| Medplum | Flagged concerns | FHIR Flag (active flags from nudge agent) |
| Medplum | Goal progress | FHIR Goal (target, achievementStatus, statusDate) |
| Medplum | Conversation flags | FHIR Communication (tagged with concern keywords by A1) |
| CDS Hooks | Trigger event | patient-view hook fired when clinician opens chart, or scheduled 24h before Appointment |

#### Processing

1. CDS Hooks patient-view fires when clinician opens Patient/{id} in OpenEMR.
2. A5 queries Medplum for all patient-side data from the last 30 days.
3. A5 (Qwen3-VL-8B) synthesises into a structured FHIR Composition with sections:
   - Adherence summary: per-medication PDC, missed dose patterns, overall rate.
   - Biometric trends: BP/glucose/weight direction with sparkline data, anomalies.
   - PRO scores: current score, delta from last collection, clinical interpretation.
   - Engagement level: app usage frequency, nudge response rate, conversation topics.
   - Flagged concerns: any active Flags or escalated issues.
   - Goal progress: each Goal with % completion and trajectory.
   - Recommended actions: suggested clinician follow-ups based on data patterns.
4. SEA-LION Guard validates clinical content.
5. Write Composition to Medplum with status=preliminary.
6. Sync to OpenEMR via write-back service (appears in patient chart as pre-visit brief).

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Pre-visit brief | FHIR Composition (type=LOINC:11488-4 "Consult note", status=preliminary, section[]=7 sections above, author=Device/insight-agent) |
| Medplum | Provenance | FHIR Provenance (target=Composition/{id}, agent=Device/insight-agent, entity=source observations) |
| OpenEMR | Synced summary | FHIR Composition (pushed via write-back after guard validation) |
| CDS Hooks response | Card for clinician | {summary: "AI pre-visit brief available", indicator: info, source: "Med-SEAL Insight Agent"} |

---

## Tier 2: Strengthens personalisation + impact

---

### F07: Dietary + Lifestyle Engine (SEA-Culturally Aware)

**Agent:** A4 (Lifestyle Agent)
**KQ impact:** KQ2 +10

#### Input

| Source | Data | Format |
|---|---|---|
| A1 | Patient dietary question or context | {query: "What should I eat for lunch?", language, patient_id} |
| Medplum | Active conditions | FHIR Condition (diabetes type, hypertension, hyperlipidemia severity) |
| Medplum | Current medications | FHIR MedicationRequest (for drug-food interactions: e.g., grapefruit + statins, potassium-rich foods + ACE inhibitors) |
| Medplum | Latest biometrics | FHIR Observation (recent glucose, HbA1c, BP, weight, BMI) |
| Medplum | Active goals | FHIR Goal (weight target, glucose target, dietary goals) |
| Knowledge base | SG/SEA food database | HPB food composition data, hawker dish calorie/carb/sodium profiles |
| Knowledge base | Cultural calendar | CNY, Hari Raya, Deepavali, Pongal food patterns and healthier alternatives |
| Knowledge base | Drug-food interaction DB | NDF-RT mappings + curated clinical rules |

#### Processing

1. A4 receives delegation from A1 with patient context.
2. A4 reads patient conditions, medications, and goals from Medplum.
3. A4 queries food KB for culturally appropriate options matching patient constraints.
4. A4 generates recommendations grounded in local food context:
   - Not "reduce carbohydrates" but "switch from white rice to brown rice for your nasi lemak, or take a smaller portion."
   - Not "eat more vegetables" but "try adding kangkong belacan or steamed broccoli as a side at the hawker centre."
5. A4 checks drug-food interactions (e.g., "Avoid grapefruit juice because of your simvastatin.").
6. Response returned to A1 for delivery in patient's language.

#### Output

| Destination | Data | Format |
|---|---|---|
| A1 | Dietary recommendation text | Structured response for A1 to rephrase: {recommendations[], warnings[], alternatives[]} |
| Medplum | Nutrition plan | FHIR NutritionOrder (oralDiet.type, nutrient[].amount, instruction) |
| Medplum | Updated care plan | FHIR CarePlan (activity[].detail = dietary goals with specific targets) |
| Medplum | Patient goals | FHIR Goal (description="Reduce rice portion by 25%", target.measure, target.detailQuantity, lifecycleStatus=active) |

---

### F08: Outcome Measurement Framework

**Agent:** A6 (Measurement Agent)
**KQ impact:** KQ4 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | All MedicationAdministration for cohort | FHIR search: MedicationAdministration?patient=Patient/{id}&_lastUpdated=gt{period_start} |
| Medplum | All vitals Observations for cohort | FHIR search: Observation?category=vital-signs&patient=Patient/{id}&date=ge{period_start} |
| Medplum | All QuestionnaireResponse for cohort | FHIR search with date filter |
| Medplum | All Encounters (for readmission tracking) | FHIR Encounter (class=inpatient/emergency) |
| Medplum | All Communication resources (engagement) | Count of patient-initiated and system-initiated communications |
| Medplum | Measure definitions | FHIR Measure (scoring, group[].population[], supplementalData) |
| Cron | Period trigger | Weekly and monthly computation schedule |

#### Processing

1. A6 loads FHIR Measure definitions (pre-configured):
   - medication-adherence-pdc: PDC per medication per patient.
   - biometric-improvement: delta of average BP/glucose over measurement period vs baseline.
   - pro-score-change: delta of PRO instrument scores.
   - engagement-frequency: interactions per week (patient-initiated + nudge-responded).
   - readmission-rate: inpatient/ED encounters per patient-month.
   - time-to-intervention: median time from threshold breach to nudge delivery.
2. A6 queries Medplum for all relevant resources within the measurement period.
3. A6 computes each metric using FHIR Measure logic (numerator/denominator populations).
4. A6 generates FHIR MeasureReport (individual and summary types).

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Individual patient report | FHIR MeasureReport (type=individual, subject=Patient/{id}, period, group[].measureScore) |
| Medplum | Population summary | FHIR MeasureReport (type=summary, period, group[].measureScore, group[].stratifier) |
| Patient app | Personal progress data | JSON via API: {metrics: [{name, value, unit, trend, goal}]} |
| OpenEMR dashboard | Population analytics | JSON via CDS Hooks or embedded widget |
| A5 | Metrics for clinician summary | Structured data included in pre-visit Composition |

---

### F09: Adherence + Biometric Analytics Dashboard

**Agent:** A6 (Measurement Agent)
**KQ impact:** KQ4 +10

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | MeasureReport (individual) | Per-patient metric time series |
| Medplum | Observation time series | BP, glucose, HbA1c, weight, step count with effectiveDateTime |
| Medplum | Goal targets | FHIR Goal (target.detailQuantity for each biometric) |
| Medplum | Intervention events | FHIR Communication (nudges sent), Flag (escalations), CarePlan changes |
| User context | View mode | patient (sees own data) or clinician (sees patient panel or population) |

#### Processing

1. For patient view: A6 prepares time-series data for the last 90 days per vital sign, overlaid with goal target lines and intervention markers.
2. For clinician view: A6 prepares per-patient adherence rates + biometric summaries, sortable by risk level.
3. For population view: A6 aggregates across all patients for cohort-level trends.
4. Correlation analysis: flag periods where biometric improvement coincides with increased adherence or nudge engagement.

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Personal dashboard data | JSON: {charts: [{type: "line", vital: "blood_glucose", data: [{date, value}], goal_line, intervention_markers[]}]} |
| OpenEMR | Per-patient panel | JSON: {patients: [{id, name, adherence_pdc, bp_trend, glucose_trend, risk_level, last_interaction}]} |
| OpenEMR | Population dashboard | JSON: {cohort_size, avg_adherence, avg_bp_change, avg_glucose_change, readmission_rate, engagement_rate} |

---

### F10: Escalation Pathways (Tiered Clinician Alerts)

**Agent:** A3 (Nudge Agent) + A5 (Insight Synthesis Agent)
**KQ impact:** KQ3 +10

#### Input

| Source | Data | Format |
|---|---|---|
| A3 | Escalation trigger | {patient_id, trigger_type, severity: low/medium/high, data_context} |
| Medplum | Patient care team | FHIR CareTeam (participant[].member = Practitioner references) |
| Medplum | Practitioner notification preferences | Custom extension on Practitioner: preferred channel, quiet hours |
| A1 | Conversation safety flag | {patient_id, keyword_category: "suicidal_ideation"/"severe_symptom", excerpt_redacted} |

#### Processing

1. Trigger evaluation (A3):
   - Low: batched insight (e.g., adherence dropped below 70% this week). Added to next pre-visit Composition.
   - Medium: next-day notification (e.g., 3+ consecutive missed doses, PRO score above threshold). FHIR Flag + CommunicationRequest with priority=routine.
   - High: immediate alert (e.g., BP >180/120, suicidal ideation, severe adverse reaction report). FHIR Flag (status=active) + CommunicationRequest (priority=urgent).
2. A5 enriches the alert with clinical context (recent conditions, medications, biometric trend).
3. Clinician receives in OpenEMR as a structured alert with one-click actions: "Review patient", "Call patient", "Adjust medication", "Dismiss with note".

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Clinical flag | FHIR Flag (status=active, category=safety/clinical, code=medseal:escalation-{level}, subject=Patient/{id}, author=Device/nudge-agent) |
| Medplum | Clinician notification | FHIR CommunicationRequest (status=active, recipient=Practitioner/{id}, priority=urgent/routine, payload=alert_text + context_summary) |
| Medplum | Detected issue | FHIR DetectedIssue (status=preliminary, code, patient, evidence[]=triggering Observations) |
| OpenEMR | Alert in EHR | Rendered via CDS Hooks response card or write-back of Flag resource |

---

### F11: Behavioral Anticipation Model

**Agent:** A3 (Nudge Agent)
**KQ impact:** KQ1 +5, KQ4 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | 30-day adherence pattern | FHIR MedicationAdministration time series (dose events + gaps) |
| Medplum | App engagement pattern | Communication count per day over 30 days |
| Medplum | Biometric trend | FHIR Observation series (direction + variability) |
| Medplum | PRO score trajectory | Last 3 PRO scores per instrument |
| Medplum | Nudge response history | CommunicationRequest.status (completed vs not-responded) |

#### Processing

1. A3 computes risk features: adherence decay rate, engagement drop-off slope, biometric variability, PRO worsening trend, nudge non-response rate.
2. Simple logistic model (or rule-based thresholds) predicts:
   - Disengagement risk (probability of 7+ days of inactivity in next 14 days).
   - Non-adherence risk (probability of PDC dropping below 60% next month).
   - Clinical deterioration risk (probability of biometric threshold breach).
3. If risk exceeds threshold: preemptive intervention (switch from text nudge to motivational conversation, increase check-in frequency, flag clinician).

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Risk assessment | FHIR RiskAssessment (method=medseal:behavioral-anticipation, prediction[].outcome, prediction[].probabilityDecimal, basis[]=source Observations) |
| A3 | Intervention adjustment | {patient_id, recommended_action: "increase_frequency"/"escalate"/"motivational_conversation", risk_scores} |
| A5 | Risk data for clinician summary | Included in pre-visit Composition risk section |

---

## Tier 3: Polish + differentiation to reach 100%

---

### F12: Appointment Orchestrator (Pre/Post Visit)

**Agent:** A1 (Companion) + A5 (Insight Synthesis)
**KQ impact:** KQ1 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | Upcoming appointments | FHIR Appointment (status=booked, start, participant[].actor) |
| Medplum | Post-visit encounter | FHIR Encounter (status=finished, period.end within last 24h) |
| Medplum | Post-visit medication changes | FHIR MedicationRequest (authoredOn within last 24h, status=active) |
| Medplum | Post-visit care plan updates | FHIR CarePlan (lastUpdated within last 24h) |

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app (pre-visit) | Preparation message | Chat message: what to bring (glucose log, BP readings), questions to ask, what doctor will likely discuss |
| Patient app (post-visit) | Follow-up summary | Chat message: "Dr Tan adjusted your metformin from 500mg to 850mg. Here's what that means..." |
| Medplum | Pre-visit reminder | FHIR CommunicationRequest (occurrenceDateTime=72h/24h before) |
| Medplum | Post-visit task | FHIR Task (intent=plan, description=follow-up actions from encounter) |

---

### F13: Caregiver Mode (Linked Family View with Consent)

**Agent:** A1 (Companion) + A6 (Measurement)
**KQ impact:** KQ1 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Patient app | Consent grant | {patient_id, caregiver_id, scope: ["view_vitals", "view_adherence", "receive_alerts"], expires} |
| Medplum | Consent resource | FHIR Consent (status=active, scope=patient-privacy, provision.actor=RelatedPerson/{caregiver_id}) |
| Medplum | Patient data (filtered by consent scope) | Same as patient view but filtered to consented categories |

#### Output

| Destination | Data | Format |
|---|---|---|
| Caregiver app view | Filtered dashboard | Same dashboard data as patient but read-only, filtered by Consent.provision |
| Caregiver app | Alert forwarding | Push notifications for medium/high escalation events (if consented) |
| Medplum | Consent record | FHIR Consent (patient, performer=caregiver, dateTime, provision.type=permit, provision.data[]) |
| Medplum | Access audit | FHIR AuditEvent (agent=RelatedPerson/{caregiver_id}, entity=Patient/{patient_id}) |

---

### F14: Adaptive Health Education (Teachable Moments)

**Agent:** A1 (Companion) + A4 (Lifestyle)
**KQ impact:** KQ2 +5

#### Input

| Source | Data | Format |
|---|---|---|
| A3 | Teachable moment trigger | {patient_id, event: "high_glucose_reading"/"medication_change"/"new_diagnosis", context_data} |
| Medplum | Patient health literacy estimate | Derived from conversation complexity analysis (stored as custom Observation) |
| Medplum | Patient language preference | ISO 639-1 code |
| Medplum | Condition-specific education library | FHIR DocumentReference (category=education, subject=Condition type) |

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Educational content | Chat message: bite-sized explanation triggered by relevant event, adapted to literacy level and language |
| Medplum | Content delivery record | FHIR Communication (category=education, payload=content_reference, subject=Patient/{id}) |
| Medplum | Education document | FHIR DocumentReference (type=education, content[].attachment, context.related=triggering Observation) |

---

### F15: Multi-Source Data Fusion Timeline

**Agent:** A6 (Measurement)
**KQ impact:** KQ2 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | All patient Observations (vitals, labs, PROs) | FHIR Observation with effectiveDateTime |
| Medplum | MedicationAdministration events | Dose confirmations with timestamps |
| Medplum | Communication events | Nudges, conversations, escalations |
| Medplum | Encounter events | Clinic visits, ED visits |
| Medplum | CarePlan changes | Activity modifications with dates |
| Medplum | Flag events | Escalation history |

#### Output

| Destination | Data | Format |
|---|---|---|
| Patient app | Unified timeline | JSON: [{date, type: "vital"/"medication"/"visit"/"nudge"/"goal", data, display_text}] |
| OpenEMR | Clinical timeline | Same data rendered in clinician context with clinical interpretation |

---

### F16: Readmission Risk + Event Tracking

**Agent:** A6 (Measurement) + A3 (Nudge)
**KQ impact:** KQ4 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Medplum | Encounter history | FHIR Encounter (class=inpatient/emergency, period, reasonCode) |
| Medplum | Current risk features | Adherence PDC, biometric trends, PRO scores, engagement rate |
| Medplum | Condition complexity | Number of active FHIR Conditions, medication count |

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Readmission risk score | FHIR RiskAssessment (method=medseal:readmission-risk, prediction.probabilityDecimal, basis[]) |
| Medplum | Readmission event log | FHIR Encounter tagged with medseal:readmission-event extension |
| A5 | Risk for clinician summary | Included in Composition |
| A3 | High-risk patient flag | Trigger increased monitoring frequency |

---

### F17: A/B Evaluation Framework (Synthetic Cohorts)

**Agent:** A6 (Measurement)
**KQ impact:** KQ4 +5

#### Input

| Source | Data | Format |
|---|---|---|
| Synthea | Synthetic control cohort | FHIR Patient Bundles with simulated chronic disease progression (no intervention) |
| Medplum | Intervention cohort | Real (synthetic demo) patients using the Med-SEAL system |
| A6 | MeasureReport for both cohorts | Adherence, biometric, PRO, readmission metrics |

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Comparative MeasureReport | FHIR MeasureReport (type=summary, group[].stratifier = intervention vs control) |
| Dashboard | Before/after visualization | JSON: {intervention_cohort: {metrics}, control_cohort: {metrics}, p_values, effect_sizes} |
| Submission report | Impact evidence | Formatted comparison table for challenge judges |

---

### F18: Patient Satisfaction + NPS Tracking

**Agent:** A1 (Companion) + A6 (Measurement)
**KQ impact:** KQ4 +5

#### Input

| Source | Data | Format |
|---|---|---|
| A3 | Satisfaction survey trigger | Scheduled monthly or post-interaction |
| Patient | NPS score (0-10) + free text feedback | Collected via conversational PRO mechanism (F04 pattern) |
| Medplum | Satisfaction questionnaire | FHIR Questionnaire (NPS + CSAT items) |

#### Output

| Destination | Data | Format |
|---|---|---|
| Medplum | Survey response | FHIR QuestionnaireResponse (questionnaire=Questionnaire/nps, item[].answer) |
| Medplum | NPS score observation | FHIR Observation (code=medseal:nps-score, valueInteger=0-10) |
| A6 | Satisfaction metrics | NPS computed (promoters - detractors), CSAT average, free text sentiment summary |
| Dashboard | Satisfaction trend | Time series of NPS and CSAT scores |

---

## Cross-cutting: SEA-LION Guard (applies to all features)

#### Input to Guard (every agent interaction)

| Source | Data | Format |
|---|---|---|
| Any agent | Raw output before delivery | Text string or FHIR resource JSON |
| Context | Patient reference | Patient/{id} for compartment enforcement |
| Context | Agent identity | Device/{agent-id} for scope validation |

#### Guard processing

1. Input gate: prompt injection detection, multilingual toxicity filter (EN/ZH/MS/TA), PII redaction, FHIR reference validation.
2. Output gate: FHIR $validate (profile conformance), $validate-code (terminology binding), hallucination check (findings vs source data), clinical harm filter.
3. Decision: PASS / FLAG (add warning annotation) / ESCALATE (require clinician review) / BLOCK (reject entirely).

#### Guard output

| Destination | Data | Format |
|---|---|---|
| Requesting agent | Decision + modified content | {decision: PASS/FLAG/ESCALATE/BLOCK, content: validated_output, warnings[]} |
| Medplum | Audit trail | FHIR AuditEvent (subtype=guard-decision, outcome, agent=Device/sealion-guard) |
| Medplum | Provenance | FHIR Provenance (agent[].who=Device/sealion-guard, agent[].type=verifier) |

---

## Feature-to-Agent mapping matrix

| Feature | A1 Companion | A2 Clinical | A3 Nudge | A4 Lifestyle | A5 Insight | A6 Measurement |
|---|---|---|---|---|---|---|
| F01 Chat | PRIMARY | delegate | | | | |
| F02 Medication | display | PRIMARY | alert | | | compute |
| F03 Nudge | | | PRIMARY | | | |
| F04 PROs | PRIMARY | | trigger | | consume | |
| F05 Wearables | context | | alert | | | PRIMARY |
| F06 Clinician summary | | | | | PRIMARY | data |
| F07 Dietary | relay | | | PRIMARY | | |
| F08 Outcome framework | | | | | | PRIMARY |
| F09 Dashboard | | | | | | PRIMARY |
| F10 Escalation | | | PRIMARY | | enrich | |
| F11 Anticipation | | | PRIMARY | | | data |
| F12 Appointments | PRIMARY | | trigger | | pre-visit | |
| F13 Caregiver | PRIMARY | | forward | | | data |
| F14 Education | PRIMARY | | trigger | assist | | |
| F15 Timeline | | | | | | PRIMARY |
| F16 Readmission | | | flag | | consume | PRIMARY |
| F17 A/B framework | | | | | | PRIMARY |
| F18 Satisfaction | PRIMARY | | trigger | | | compute |

---

## FHIR Resource Inventory (all features combined)

| Category | FHIR Resources |
|---|---|
| Patient identity | Patient, RelatedPerson, Consent |
| Clinical data (read from OpenEMR) | Condition, Observation, MedicationRequest, AllergyIntolerance, Encounter, Procedure, CarePlan, CareTeam, Immunization |
| Medication tracking (write) | MedicationAdministration, MedicationDispense |
| Communication | Communication, CommunicationRequest |
| Assessments (write) | QuestionnaireResponse, Questionnaire, RiskAssessment, DetectedIssue |
| Clinical output (write) | Composition, DiagnosticReport, Flag, NutritionOrder |
| Goals and planning | Goal, CarePlan, Task |
| Measurement | Measure, MeasureReport, Library |
| Devices and wearables | Device, DeviceMetric |
| Appointments | Appointment |
| Audit and provenance | AuditEvent, Provenance |
| Education | DocumentReference |
| Agent registration | Device (one per agent) |
| Authorization | SMART on FHIR scopes per agent |

Total: 32 distinct FHIR resource types across 18 features.
