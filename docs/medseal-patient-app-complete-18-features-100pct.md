# Med-SEAL Patient App: Complete Feature Spec for 100% All KQs

## NUS–Synapxe–IMDA AI Innovation Challenge 2026

### Problem Statement 1: Agentic AI for Patient Empowerment

---

## 1. Coverage summary

| Key Question | Baseline | After 10 core | After all 18 | Features |
|---|---|---|---|---|
| KQ1: Proactive patient engagement | 40% | 80% | **100%** | #1, #2, #3, #11, #12, #13 |
| KQ2: Hyper-personalisation of care | 55% | 90% | **100%** | #1, #4, #5, #7, #14, #15 |
| KQ3: Bridging patient and clinician | 75% | 100% | **100%** | #4, #6, #10, #13 |
| KQ4: Measuring real-world impact | 20% | 80% | **100%** | #2, #3, #5, #8, #9, #11, #16, #17, #18 |

---

## 2. Agent architecture

### 2.1 Agent roster

| # | Agent | Model | Surface | Role |
|---|---|---|---|---|
| 1 | **Companion agent** | MERaLiON + SEA-LION | Patient app | Empathetic multilingual conversation, PRO collection, health Q&A |
| 2 | **Clinical reasoning agent** | Qwen3-VL-8B (Med-SEAL) | Both | Medical reasoning, EHR synthesis, drug interaction checks |
| 3 | **Nudge agent** | MERaLiON + rule engine | Patient app | Proactive outreach, reminders, escalation |
| 4 | **Lifestyle agent** | SEA-LION + nutrition KB | Patient app | Diet, exercise, wellness goals, culturally adapted advice |
| 5 | **Insight synthesis agent** | Qwen3-VL-8B (Med-SEAL) | OpenEMR | Clinician pre-visit briefs, patient behavior summaries |
| 6 | **Measurement agent** | Analytics engine (no LLM) | Both | Outcome metrics, KPI computation, dashboard data |
| — | **Orchestrator** | smolagents | System | Task routing, context fusion, agent lifecycle |
| — | **SEA-LION Guard** | SEA-LION Guard | System | Dual-gate safety: input validation + output validation |

### 2.2 Agent interaction patterns

- **Patient asks about food** → Companion agent → delegates to Lifestyle agent → response back through Companion → Guard → patient
- **Patient asks about drug interaction** → Companion agent → delegates to Clinical reasoning agent → response back through Companion → Guard → patient
- **Missed dose detected** → Nudge agent (cron) → reads MedicationAdministration gap → crafts empathetic nudge via MERaLiON → Guard → push to patient app
- **Appointment tomorrow** → Insight synthesis agent (CDS Hook) → reads all patient-side data → writes Composition → appears in OpenEMR pre-visit panel
- **BP dangerously high** → Nudge agent (event) → immediate escalation → writes Flag + CommunicationRequest → OpenEMR alert to clinician
- **Monthly review** → Measurement agent (scheduled) → computes all KPIs → writes MeasureReport → feeds dashboard on both surfaces
- **Patient disengaging** → Behavioral anticipation model → Nudge agent adjusts tone/channel → involves caregiver if consented

### 2.3 Model assignment rationale

- **MERaLiON + SEA-LION** (Companion, Nudge, Lifestyle): Patient-facing agents need empathy, emotion awareness, multilingual capability (EN, ZH, MS, TA), and code-switching. These are the NMLP Special Award targets.
- **Qwen3-VL-8B Med-SEAL** (Clinical reasoning, Insight synthesis): Medical accuracy requires chain-of-thought reasoning over structured EHR data. Never speaks to patient directly — always mediated through Companion agent.
- **Rule-based analytics** (Measurement): Outcome metrics must be deterministic and reproducible. No LLM needed — FHIR aggregation queries and statistical computation.
- **SEA-LION Guard** (all agents): Validates safety of every input and output. Checks for prompt injection, harmful medical advice, hallucination, and FHIR conformance.

---

## 3. Feature specifications

### 3.1 Tier 1 — Core features (must be functional in prototype)

---

#### Feature 1: MERaLiON / SEA-LION chat interface

| | |
|---|---|
| **KQ impact** | KQ1 +15, KQ2 +10 |
| **Agent** | Companion agent |
| **Status** | Build new |

**Description:** Primary conversational interface powered by MERaLiON (empathetic, emotion-aware) and SEA-LION (multilingual SEA). Handles EN, ZH, MS, TA with code-switching. Culturally adapted tone — not just translated, but contextually appropriate (respectful forms in Malay/Tamil, dialect awareness for Mandarin). This is the NMLP Special Award target ($5,000 cash prize).

**App screens:**
- Chat interface with language auto-detection
- Language preference selector (with "follow my phone" option)
- Conversation history with search
- Voice input option (speech-to-text via MERaLiON)

**FHIR resources:** Communication (conversation record)

**Agent behavior:**
- Detects emotional state from message tone and adapts response warmth
- Delegates to Clinical reasoning agent for medical queries
- Delegates to Lifestyle agent for diet/exercise queries
- All outputs pass through SEA-LION Guard before reaching patient

---

#### Feature 2: Medication management + adherence tracking

| | |
|---|---|
| **KQ impact** | KQ1 +10, KQ4 +15 |
| **Agent** | Clinical reasoning agent (logic) + Companion agent (display) |
| **Status** | Build new |

**Description:** Reads MedicationRequest from OpenEMR/Medplum. Shows the patient a clear schedule with dosage, timing, and purpose explained in their language. Tracks acknowledgement of each dose as MedicationAdministration. Detects missed doses and escalates pattern to the nudge engine. Flags potential interactions if patient reports OTC supplements.

**App screens:**
- Daily medication schedule (cards with time, drug name, dosage, purpose)
- "Taken" / "Skipped" / "Delayed" confirmation buttons per dose
- Medication details screen (what it does, side effects, food interactions)
- Adherence calendar (monthly view, green/amber/red per day)
- OTC supplement logger with interaction warnings

**FHIR resources:** MedicationRequest (read), MedicationAdministration (write), MedicationDispense (read), DetectedIssue (interaction flag)

---

#### Feature 3: Smart nudge engine

| | |
|---|---|
| **KQ impact** | KQ1 +15, KQ4 +5 |
| **Agent** | Nudge agent |
| **Status** | Build new |

**Description:** Proactive outreach, not passive reminders. The agent monitors FHIR data streams and triggers context-aware check-ins: missed medication window detected, upcoming lab due date approaching, blood glucose trending upward over 7 days, no activity logged in 3 days. Each nudge is empathetically framed via MERaLiON with cultural sensitivity.

**App screens:**
- Push notifications (native OS) with contextual preview
- In-app nudge cards (expandable, with "tell me more" → opens chat)
- Nudge preferences (frequency, quiet hours, channels)

**Trigger patterns:**
- Cron: daily medication check, weekly wellness check-in
- Event: missed dose (30min past window), high BP reading, abnormal glucose
- Decay: 3 days no app activity, declining engagement score
- Calendar: 48h before appointment, 1 week before lab due date

**FHIR resources:** FHIR Subscription (trigger), Communication (nudge record), CommunicationRequest (scheduled outreach), Flag (escalation to clinician)

**Escalation tiers:**
- Low: patient nudge via app
- Medium: next-day clinician flag in OpenEMR
- High: immediate Flag + CommunicationRequest to clinician

---

#### Feature 4: Patient-reported outcomes (conversational PROs)

| | |
|---|---|
| **KQ impact** | KQ2 +5, KQ3 +5, KQ4 +10 |
| **Agent** | Companion agent |
| **Status** | Build new |

**Description:** Periodic check-in questionnaires adapted by condition (PHQ-9 for depression screening, diabetes distress scale, dietary self-efficacy). Delivered conversationally through the AI companion, not as a cold form. Responses stored as FHIR QuestionnaireResponse and summarised for the clinician.

**App screens:**
- Conversational PRO flow within chat (agent asks questions one at a time)
- Score summary card after completion ("Your diabetes distress score: 2.1/6 — that's in the low range")
- PRO history view (trend over time)

**FHIR resources:** Questionnaire (template), QuestionnaireResponse (patient input), Observation (derived score)

**PRO instruments by condition:**
- Diabetes: Diabetes Distress Scale (DDS-17), dietary self-efficacy
- Hypertension: medication belief questionnaire
- General: PHQ-2/PHQ-9 (depression screen), EQ-5D-5L (quality of life)

---

#### Feature 5: Wearable data ingestion

| | |
|---|---|
| **KQ impact** | KQ2 +10, KQ4 +10 |
| **Agent** | Measurement agent (ingestion) + Nudge agent (alerts) |
| **Status** | Build new |

**Description:** Ingest data from Apple Health / Google Health Connect / Fitbit / glucometers via FHIR Observation. Blood pressure, heart rate, glucose, step count, sleep duration. Agent contextualises trends: "Your average fasting glucose this week is 6.8 — slightly higher than your 3-month average of 6.2."

**App screens:**
- Device connection setup (link Apple Health / Google Health Connect)
- Today's vitals dashboard (BP, glucose, steps, sleep — latest readings)
- Trend charts (7-day, 30-day, 90-day with goal target lines)
- Manual entry fallback (for patients without wearables)

**FHIR resources:** Observation (vitals from device), Device (wearable registration), DeviceMetric

**Supported data types:**

| Metric | LOINC code | Source |
|---|---|---|
| Blood pressure (systolic) | 8480-6 | Wearable / manual |
| Blood pressure (diastolic) | 8462-4 | Wearable / manual |
| Heart rate | 8867-4 | Wearable |
| Blood glucose | 2339-0 | Glucometer / manual |
| HbA1c | 4548-4 | Lab (via OpenEMR sync) |
| Step count | 55423-8 | Wearable |
| Sleep duration | 93832-4 | Wearable |
| Body weight | 29463-7 | Scale / manual |

---

#### Feature 6: Patient insight summary for clinician

| | |
|---|---|
| **KQ impact** | KQ3 +10 |
| **Agent** | Insight synthesis agent |
| **Status** | Enhance existing |

**Description:** Extends the existing FHIR Composition (clinical summary) to include patient-side behavioral data: medication adherence rate, wearable biometric trends, PRO scores, engagement level, flagged concerns from conversation. Appears in OpenEMR as a pre-visit brief. Clinician gets a 30-second read instead of 20 minutes of chart review.

**OpenEMR display:**
- Pre-visit panel auto-generated 24h before appointment
- Sections: adherence summary, biometric trends (sparklines), PRO scores with delta, engagement level, flagged concerns, recommended actions
- One-click "acknowledge" button to mark as reviewed

**FHIR resources:** Composition (enhanced sections), Observation (adherence percentage), RiskAssessment, QuestionnaireResponse (PRO summary)

**Composition sections:**

| Section | LOINC code | Content |
|---|---|---|
| Medication adherence | Custom | PDC rate, missed dose pattern, problem drugs |
| Biometric trends | 85354-9 | BP/glucose/weight trend direction + sparkline data |
| Patient-reported outcomes | Custom | Latest PRO scores, delta from last visit |
| Engagement | Custom | App usage frequency, nudge response rate |
| Flagged concerns | Custom | Conversation keywords, escalation events |
| Goal progress | Custom | Active goals with achievementStatus |
| Recommended actions | Custom | Agent-suggested interventions for clinician review |

---

### 3.2 Tier 2 — Strengthening features (architecture + mock data acceptable)

---

#### Feature 7: Dietary + lifestyle recommendation engine

| | |
|---|---|
| **KQ impact** | KQ2 +10 |
| **Agent** | Lifestyle agent |
| **Status** | Build new |

**Description:** Culturally aware recommendations grounded in the patient's conditions, medications, and goals. Understands Singapore/SEA food context — hawker centre meals, festive foods (CNY, Hari Raya, Deepavali). Not "reduce carbs" but "try switching from white rice to brown rice for your nasi lemak, or reduce the portion by a quarter."

**App screens:**
- Meal log (photo or text description, agent estimates nutritional impact)
- Daily dietary summary with condition-specific guidance
- Recipe suggestions adapted to restrictions
- Festival food guide (seasonal, culturally appropriate alternatives)

**FHIR resources:** NutritionOrder (recommendations), CarePlan (wellness goals), Goal (patient targets)

**Knowledge sources:**
- Singapore Health Promotion Board (HPB) food composition database
- Drug-food interaction database (e.g., grapefruit + statins, vitamin K + warfarin)
- Cultural calendar (CNY, Hari Raya, Deepavali, Thaipusam meal patterns)
- Hawker centre common dish nutritional profiles

---

#### Feature 8: Outcome measurement framework

| | |
|---|---|
| **KQ impact** | KQ4 +10 |
| **Agent** | Measurement agent |
| **Status** | Build new |

**Description:** Define FHIR Measure resources for each KPI. Generate MeasureReport periodically. Support before/after comparison and cohort analysis.

**Defined KPIs:**

| Metric | Measure ID | Computation | Target |
|---|---|---|---|
| Medication adherence (PDC) | med-adherence-pdc | Doses taken / doses prescribed over 30 days | > 80% |
| Biometric improvement (BP) | bp-improvement | Slope of systolic BP over 90 days | Negative slope |
| Biometric improvement (glucose) | glucose-improvement | Slope of fasting glucose over 90 days | Negative slope |
| HbA1c delta | hba1c-delta | Latest HbA1c - baseline HbA1c | < 0 (improving) |
| PRO score change | pro-delta | Latest PRO score - baseline PRO score | Condition-specific |
| Engagement frequency | engagement-freq | App sessions per week | > 3 |
| Nudge response rate | nudge-response | Nudges acted on / nudges sent | > 60% |
| Time to escalation | time-to-escalation | Hours from trigger event to clinician notification | < 24h |
| Readmission rate | readmission-30d | 30-day readmission count / total patients | < baseline |
| Patient satisfaction (NPS) | patient-nps | Net promoter score from in-app surveys | > 50 |

**FHIR resources:** Measure (definition), MeasureReport (results), Library (CQL logic)

---

#### Feature 9: Adherence + biometric analytics dashboard

| | |
|---|---|
| **KQ impact** | KQ4 +10 |
| **Agent** | Measurement agent |
| **Status** | Build new |

**Description:** Visualise BP, glucose, HbA1c, weight, step count trends over time for the patient (in-app) and clinician (in OpenEMR). Flag improvements correlated with intervention periods. Compare against FHIR Goal targets.

**App screens (patient-facing):**
- "My progress" tab with condition-specific charts
- Goal vs actual overlay (target line + actual trend)
- Weekly summary card ("Your BP this week averaged 128/82 — down from 135/88 last month")
- Achievement badges for milestones

**OpenEMR screens (clinician-facing):**
- Population dashboard: adherence rates, biometric trends across patient panel
- Individual patient drilldown from the insight summary
- Export for quality reporting

**FHIR resources:** Observation (time series), Goal (target line), MeasureReport (population statistics)

---

#### Feature 10: Escalation pathways

| | |
|---|---|
| **KQ impact** | KQ3 +10 |
| **Agent** | Nudge agent (detection) + Insight synthesis agent (delivery) |
| **Status** | Build new |

**Description:** When the patient app detects critical signals, the agent escalates to the clinician via FHIR Flag + CommunicationRequest. Tiered escalation based on severity.

**Escalation tiers:**

| Tier | Trigger examples | Timing | Delivery |
|---|---|---|---|
| Low | Declining adherence trend, mild PRO score increase | Batched into next pre-visit summary | Composition section in OpenEMR |
| Medium | 3+ missed doses in a week, BP > 160/100 single reading | Next business day | CommunicationRequest notification in OpenEMR |
| High | BP > 180/120, suicidal ideation keywords, severe symptom report | Immediate | Flag (priority=urgent) + CommunicationRequest + push notification to clinician |

**FHIR resources:** Flag (clinical alert), CommunicationRequest (clinician notification), DetectedIssue

**Safety note:** High-tier escalation for mental health keywords triggers SEA-LION Guard's crisis protocol — the companion agent provides crisis helpline information (SOS: 1-767, IMH: 6389-2222) while simultaneously alerting the clinician.

---

### 3.3 Tier 3 — Enhancement features (100% coverage)

---

#### Feature 11: Behavioral anticipation model

| | |
|---|---|
| **KQ impact** | KQ1 +8, KQ4 +5 |
| **Agent** | Nudge agent (enhanced) |
| **Status** | Build new |

**Description:** Predicts when a patient is about to disengage — before they actually miss a dose or skip a check-in. Uses patterns: declining app open frequency, shorter conversations, ignored nudges, late medication confirmations. Triggers pre-emptive interventions.

**Anticipation signals:**

| Signal | Measurement | Threshold |
|---|---|---|
| App open frequency decline | 7-day rolling average vs 30-day average | > 30% drop |
| Conversation brevity | Average message length trending down | > 40% shorter |
| Nudge ignore rate | Nudges without response in 24h | > 50% over 7 days |
| Medication delay | Average minutes past scheduled time | > 60min and increasing |
| Wearable sync gap | Days since last device data sync | > 3 days |

**Pre-emptive interventions:**
- Switch nudge channel (text → voice message)
- Change nudge tone (informational → motivational story)
- Surface a peer success story ("Auntie Lim got her HbA1c down to 6.5 — she started with the same medication as you")
- Involve caregiver if consented (feature 13)
- Flag to clinician as "engagement risk" in next insight summary

**App screens:**
- Engagement streak counter ("12 days active") — gamification element
- Behind the scenes: RiskAssessment resource with predicted adherence drop probability

**FHIR resources:** RiskAssessment (output), DetectedIssue (adherence flag), Observation (engagement metrics)

---

#### Feature 12: Appointment orchestrator

| | |
|---|---|
| **KQ impact** | KQ1 +7 |
| **Agent** | Companion agent + Clinical reasoning agent |
| **Status** | Build new |

**Description:** Full appointment lifecycle management. Addresses the problem statement's explicit mention of "manage appointments."

**Lifecycle phases:**

| Phase | Timing | Agent action |
|---|---|---|
| Pre-visit prep | 48h before | Companion: "Your appointment with Dr Tan is Thursday at 2pm. She'll probably ask about your glucose readings — want me to prepare a summary?" |
| Pre-visit checklist | 24h before | Companion: generates checklist (bring glucose log, list of questions, fasting if lab ordered) |
| During visit | During appointment | Silent — no nudges or messages |
| Post-visit follow-up | 2h after | Companion: "Dr Tan adjusted your metformin to 1000mg — that's because your HbA1c was 7.2. Here's what to expect in the first week." |
| Action items | Post-visit | Syncs updated CarePlan from OpenEMR, surfaces new goals in app |

**App screens:**
- Upcoming appointments timeline
- Pre-visit checklist (interactive checkboxes)
- Post-visit summary card with medication changes highlighted
- "Questions for my doctor" notepad (patient can add throughout the month)
- Reschedule assistant (natural language: "Can you move it to next week?")

**FHIR resources:** Appointment (read/write), Encounter (post-visit), CarePlan (action items), ServiceRequest (lab orders)

---

#### Feature 13: Caregiver mode

| | |
|---|---|
| **KQ impact** | KQ1 +5, KQ3 +bonus |
| **Agent** | Companion agent + Nudge agent |
| **Status** | Build new |

**Description:** The problem statement explicitly mentions "caregiving responsibilities." A family member (e.g., child of elderly diabetic patient) gets a linked view. Cannot see full medical records — only AI-summarised wellness status. Patient must consent.

**App screens (caregiver view):**
- Simplified wellness dashboard: adherence status (green/amber/red), latest vitals, engagement level
- Alert feed: receives escalation notifications when patient is at medium/high risk
- Shared nudge channel: "Remind Ah Ma to take her evening medicine"
- Cannot see: chat history, full medical records, detailed lab values

**Consent management:**
- Patient explicitly grants caregiver access via in-app consent flow
- Stored as FHIR Consent resource with scope limitations
- Patient can revoke at any time
- Caregiver sees only what the Consent resource permits

**FHIR resources:** Consent (access grant), RelatedPerson (caregiver registration), Communication (shared nudge channel)

---

#### Feature 14: Adaptive health education

| | |
|---|---|
| **KQ impact** | KQ2 +5 |
| **Agent** | Companion agent + Clinical reasoning agent |
| **Status** | Build new |

**Description:** Contextual education triggered at teachable moments — not generic articles pushed randomly.

**Teachable moment triggers:**

| Trigger | Education content |
|---|---|
| High glucose reading logged | What causes glucose spikes, linked to what patient ate |
| Medication change detected | New drug mechanism explained simply, what to expect |
| Lab result arrives | What the numbers mean, comparison to last result |
| Patient asks "why" about anything | Deep-dive explanation adapted to literacy level |
| Festive season approaching | Festival food guide with culturally appropriate swaps |

**Health literacy adaptation:**
- Detects literacy level from conversation complexity (vocabulary range, question depth)
- Low literacy: simple analogies, shorter sentences, visual aids
- Medium literacy: standard explanations with medical terms defined inline
- High literacy: detailed mechanism explanations, links to studies

**App screens:**
- Inline "learn more" expandable cards within chat
- Visual micro-lessons (animated diagrams of how medications work)
- Personal health library (saved education content)

**FHIR resources:** DocumentReference (educational content), Communication (delivery record)

---

#### Feature 15: Multi-source data fusion view

| | |
|---|---|
| **KQ impact** | KQ2 +5 |
| **Agent** | Measurement agent (aggregation) + Companion agent (narration) |
| **Status** | Build new |

**Description:** A single patient timeline that merges EHR data (conditions, labs, meds from OpenEMR), wearable data (BP, glucose, steps), PRO scores, lifestyle logs, and conversation summaries into one chronological view. The agent can reference any point: "Your glucose spiked on March 3rd — that was the day after CNY reunion dinner."

**Data sources merged:**

| Source | Data types | Color coding |
|---|---|---|
| OpenEMR (via Medplum sync) | Conditions, labs, medications, encounters | Blue |
| Wearable devices | BP, glucose, steps, sleep | Teal |
| Patient-reported outcomes | PRO scores, mood check-ins | Purple |
| Lifestyle agent | Meal logs, exercise logs | Green |
| Conversation flags | Flagged concerns from companion chat | Amber |

**App screens:**
- Scrollable health timeline with color-coded event types
- Tap any event for AI explanation in patient's language
- Weekly / monthly auto-generated summary narrative
- Filter by data type

**FHIR resources:** Bundle (aggregation query), Observation (all types), Condition, MedicationRequest, QuestionnaireResponse

---

#### Feature 16: Readmission risk + event tracking

| | |
|---|---|
| **KQ impact** | KQ4 +7 |
| **Agent** | Measurement agent |
| **Status** | Build new |

**Description:** Score readmission risk based on adherence, biometrics, PROs, and engagement patterns. Track actual readmission events (Encounter with type=emergency or type=inpatient) as outcome measures. Compare pre-intervention vs post-intervention rates. This is the metric that matters most to Synapxe and MOH.

**Risk factors:**

| Factor | Weight | Source |
|---|---|---|
| Medication adherence (PDC < 60%) | High | MedicationAdministration |
| Rising BP trend (> 10mmHg increase over 30 days) | High | Observation (BP) |
| HbA1c > 9% | High | Observation (lab) |
| PHQ-9 score > 15 (moderate-severe depression) | Medium | QuestionnaireResponse |
| Engagement score declining | Medium | App usage metrics |
| 2+ ED visits in past 90 days | High | Encounter |
| Age > 65 + multiple comorbidities | Medium | Patient + Condition |

**Not patient-visible.** Clinician sees risk score in insight summary. Measurement agent computes population-level rates for submission report.

**FHIR resources:** RiskAssessment (score), Encounter (readmission event), EpisodeOfCare

---

#### Feature 17: A/B evaluation framework

| | |
|---|---|
| **KQ impact** | KQ4 +7 |
| **Agent** | Measurement agent |
| **Status** | Build new |

**Description:** Methodology to prove impact. With the Synthea synthetic population, create two cohorts: intervention group (uses patient app with all agents) vs control group (standard care, no app). Track identical FHIR metrics across both. Even with synthetic data, this demonstrates the evaluation design.

**Cohort design:**

| | Intervention group | Control group |
|---|---|---|
| Size | 500 synthetic patients | 500 synthetic patients |
| Conditions | Diabetes + hypertension + hyperlipidemia | Same distribution |
| Demographics | Matched age, gender, ethnicity | Same |
| Intervention | All 6 agents active | Standard care (OpenEMR only) |
| Measurement period | 6 months simulated | 6 months simulated |

**Tracked metrics (identical for both cohorts):**
- Medication adherence PDC
- HbA1c change from baseline
- Systolic BP change from baseline
- ED visit frequency
- Time from abnormal reading to clinician action
- 30-day readmission rate

**Not patient-visible.** Research dashboard showing cohort comparison charts, p-values, confidence intervals. Export for submission.

**FHIR resources:** Group (cohort definition), MeasureReport (per-cohort results), ResearchStudy (study metadata)

---

#### Feature 18: Patient satisfaction + NPS tracking

| | |
|---|---|
| **KQ impact** | KQ4 +6 |
| **Agent** | Companion agent (collection) + Measurement agent (aggregation) |
| **Status** | Build new |

**Description:** Periodic in-app micro-surveys for qualitative impact measurement.

**Survey types:**

| Type | Frequency | Method | Questions |
|---|---|---|---|
| Message reaction | Every agent response | Thumbs up/down button | "Was this helpful?" |
| Weekly pulse | Weekly | 1-question in chat | "On a scale of 1-5, how supported did you feel this week?" |
| Monthly NPS | Monthly | 3-question conversational | "Would you recommend this app?", "What helped most?", "What should we improve?" |
| Post-feature | After first use of new feature | In-context | "How was the meal logging experience?" |

**App screens:**
- Inline reaction buttons on every agent message (thumbs up/down)
- Monthly survey delivered conversationally by companion agent
- Patient can view their own satisfaction trend
- Qualitative feedback collected as free text, summarised by MERaLiON

**FHIR resources:** QuestionnaireResponse (survey responses), Observation (NPS score), Communication (qualitative feedback)

---

## 4. Feature-to-agent mapping

| Feature | Companion | Clinical | Nudge | Lifestyle | Insight | Measurement |
|---|---|---|---|---|---|---|
| F1: Chat interface | Primary | — | — | — | — | — |
| F2: Medication mgmt | Display | Logic | — | — | — | — |
| F3: Nudge engine | — | — | Primary | — | — | — |
| F4: PROs | Primary | — | — | — | Reads | Aggregates |
| F5: Wearables | — | — | Alerts | — | — | Ingestion |
| F6: Clinician summary | — | Data | — | — | Primary | — |
| F7: Dietary engine | Delegates | — | — | Primary | — | — |
| F8: Outcome framework | — | — | — | — | — | Primary |
| F9: Analytics dashboard | — | — | — | — | — | Primary |
| F10: Escalation | — | — | Detection | — | Delivery | — |
| F11: Behavioral anticipation | — | — | Primary | — | — | Signals |
| F12: Appointment orchestrator | Primary | Context | — | — | — | — |
| F13: Caregiver mode | Shared channel | — | Alerts | — | — | — |
| F14: Health education | Delivery | Content | — | — | — | — |
| F15: Data fusion view | Narration | — | — | — | — | Aggregation |
| F16: Readmission risk | — | — | — | — | Displays | Primary |
| F17: A/B framework | — | — | — | — | — | Primary |
| F18: Patient satisfaction | Collection | — | — | — | — | Aggregation |

---

## 5. FHIR resource inventory

All resources read/written via Medplum FHIR R4 API.

### 5.1 Resources from existing stack (synced from OpenEMR)

| Resource | Direction | Used by features |
|---|---|---|
| Patient | Read | All |
| Condition | Read | F2, F7, F14, F16 |
| Observation (labs) | Read | F5, F6, F9, F14, F15, F16 |
| MedicationRequest | Read | F2, F7 |
| AllergyIntolerance | Read | F2, F7 |
| Encounter | Read | F12, F16 |
| CarePlan | Read/Write | F7, F12 |
| Appointment | Read/Write | F12 |

### 5.2 Resources created by patient app

| Resource | Direction | Used by features |
|---|---|---|
| MedicationAdministration | Write | F2, F8, F16 |
| Communication | Write | F1, F3, F13, F18 |
| CommunicationRequest | Write | F3, F10 |
| QuestionnaireResponse | Write | F4, F17, F18 |
| Observation (vitals from device) | Write | F5, F9 |
| Observation (adherence rate) | Write | F6, F8 |
| Observation (engagement metrics) | Write | F11 |
| Observation (NPS score) | Write | F18 |
| NutritionOrder | Write | F7 |
| Goal | Write | F7, F9 |
| Device | Write | F5 |
| Consent | Write | F13 |
| RelatedPerson | Write | F13 |
| DocumentReference | Write | F14 |
| Flag | Write | F10 |
| DetectedIssue | Write | F2, F11 |
| RiskAssessment | Write | F6, F11, F16 |

### 5.3 Resources created by measurement/insight agents

| Resource | Direction | Used by features |
|---|---|---|
| Composition (pre-visit brief) | Write | F6 |
| Measure | Write | F8 |
| MeasureReport | Write | F8, F9, F17 |
| Group (cohort) | Write | F17 |
| ResearchStudy | Write | F17 |
| Provenance | Write | All AI-generated resources |
| AuditEvent | Write | All agent actions |

---

## 6. Build priority and timeline

| Tier | Features | Strategy | Estimated effort |
|---|---|---|---|
| **Tier 1** | F1–F6 | Must be functional end-to-end in prototype | 4–5 weeks |
| **Tier 2** | F7–F10 | Architecture + mock/synthetic data acceptable | 2–3 weeks |
| **Tier 3** | F11–F18 | Design + demo with synthetic data, partial implementation | 2–3 weeks |

**Total: 18 features, 6 agents, 2 surfaces, 100% coverage on all 4 KQs.**

---

## 7. NMLP Special Award strategy

The $5,000 NMLP Special Award goes to the team demonstrating the most effective and innovative use of SEA-LION and MERaLiON.

**Features using MERaLiON / SEA-LION:**

| Feature | Model | Usage |
|---|---|---|
| F1: Chat interface | MERaLiON + SEA-LION | Primary patient conversation (empathy + multilingual) |
| F3: Nudge engine | MERaLiON | Empathetically framed proactive outreach |
| F4: PROs | SEA-LION | Conversational questionnaire delivery in patient's language |
| F7: Dietary engine | SEA-LION | Culturally adapted food recommendations |
| F11: Behavioral anticipation | MERaLiON | Tone-adapted re-engagement messages |
| F14: Health education | MERaLiON + SEA-LION | Literacy-adapted multilingual education content |
| F18: Satisfaction surveys | MERaLiON | Conversational survey delivery + qualitative feedback summarisation |

**SEA-LION Guard** (already built) validates all outputs from these features for safety and appropriateness.

**Pitch angle:** "We don't just use SEA-LION/MERaLiON as a chatbot — they power 7 distinct features across 3 agents, handling empathy, multilingual care, cultural food adaptation, health literacy calibration, and proactive wellness coaching. The Guard ensures every output is safe. This is the deepest NMLP integration in the competition."
