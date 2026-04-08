# Med-SEAL Patient Empowerment: AI Agent Specification

## Agent Implementation Guide

This document is the engineering contract for every AI agent in the Med-SEAL system. Each agent section contains everything needed to implement, test, and deploy that agent: identity, model configuration, smolagents tool registry, FHIR scopes, system prompt, delegation rules, error handling, and health checks.

---

## Architecture overview

```
Patient App / OpenEMR / ClinOS
          |
    SEA-LION Guard (input gate)
          |
    smolagents Orchestrator
     /    |    |    \     \
   A1    A2   A3   A4   A5   A6
   |      |    |    |    |    |
    SEA-LION Guard (output gate)
          |
    Medplum FHIR R4 --> OpenEMR sync
```

### Agent registry

| ID | Name | Model | Surface | LLM required | FHIR access |
|---|---|---|---|---|---|
| A1 | Companion Agent | MERaLiON + SEA-LION | Patient app | Yes | Read + limited write |
| A2 | Clinical Reasoning Agent | Qwen3-VL-8B-Thinking (Med-SEAL) | Both | Yes | Read + write |
| A3 | Nudge Agent | MERaLiON + rule engine | Patient app | Yes (message gen) | Read + write |
| A4 | Lifestyle Agent | SEA-LION + nutrition KB | Patient app | Yes | Read + write |
| A5 | Insight Synthesis Agent | Qwen3-VL-8B-Thinking (Med-SEAL) | OpenEMR | Yes | Read + write |
| A6 | Measurement Agent | No LLM (analytics engine) | Both | No | Read + write |
| G1 | SEA-LION Guard | SEA-LION Guard v1.0 | System | Yes | Read (all) + write (audit) |
| O1 | smolagents Orchestrator | No LLM (rule-based router) | System | No | Write (Task) + read (context) |

### Model serving

| Model | Serving | Endpoint | GPU |
|---|---|---|---|
| MERaLiON | vLLM | http://meralion.medseal.internal:8000/v1 | 1x H200 |
| SEA-LION (chat) | vLLM | http://sealion.medseal.internal:8000/v1 | 1x H200 |
| SEA-LION Guard | vLLM | http://guard.medseal.internal:8000/v1 | 1x H200 |
| Qwen3-VL-8B-Thinking | vLLM | http://medseal-vlm.medseal.internal:8000/v1 | 2x H200 |

---

## A1: Companion Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `companion-agent` |
| FHIR Device ID | `Device/medseal-companion-agent` |
| Surface | Patient app |
| Primary model | MERaLiON (empathy + emotion recognition) |
| Secondary model | SEA-LION (multilingual: EN, ZH, MS, TA) |
| Fallback model | SEA-LION only (if MERaLiON unavailable) |
| Max response tokens | 512 |
| Temperature | 0.7 (conversational warmth) |
| Response language | Matches patient's `Patient.communication.preferred` |

### Role

The Companion Agent is the patient's primary conversational interface. It is the only agent that speaks directly to the patient. All other agents communicate through it. It handles casual conversation, health questions, PRO collection, medication explanations, and emotional support. It delegates complex medical queries to A2, dietary questions to A4, and never fabricates clinical information.

### FHIR scopes (SMART on FHIR)

```
patient/Patient.read
patient/Condition.read
patient/Observation.read
patient/MedicationRequest.read
patient/Communication.write
patient/Communication.read
patient/QuestionnaireResponse.write
patient/Questionnaire.read
```

### smolagents tool registry

```python
@tool
def read_patient(patient_id: str) -> dict:
    """Read patient demographics, language preference, and active conditions.
    Returns: FHIR Patient resource with included Condition references."""
    return medplum.read(f"Patient/{patient_id}", params={"_include": "Patient:general-practitioner"})

@tool
def read_conditions(patient_id: str) -> list[dict]:
    """Read all active conditions for the patient.
    Returns: List of FHIR Condition resources (clinicalStatus=active)."""
    return medplum.search("Condition", {"patient": patient_id, "clinical-status": "active"})

@tool
def read_medications(patient_id: str) -> list[dict]:
    """Read current medication prescriptions.
    Returns: List of FHIR MedicationRequest resources (status=active)."""
    return medplum.search("MedicationRequest", {"patient": patient_id, "status": "active"})

@tool
def read_recent_observations(patient_id: str, code: str = None, count: int = 5) -> list[dict]:
    """Read recent observations (vitals, labs).
    Args: code = LOINC code to filter (optional), count = max results.
    Returns: List of FHIR Observation resources, sorted by date descending."""
    params = {"patient": patient_id, "_sort": "-date", "_count": count}
    if code:
        params["code"] = f"http://loinc.org|{code}"
    return medplum.search("Observation", params)

@tool
def write_communication(patient_id: str, message: str, direction: str) -> dict:
    """Record a conversation message.
    Args: direction = 'to-patient' or 'from-patient'.
    Returns: Created FHIR Communication resource."""
    return medplum.create("Communication", {
        "resourceType": "Communication",
        "status": "completed",
        "subject": {"reference": f"Patient/{patient_id}"},
        "sender": {"reference": "Device/medseal-companion-agent"} if direction == "to-patient" else {"reference": f"Patient/{patient_id}"},
        "recipient": [{"reference": f"Patient/{patient_id}"}] if direction == "to-patient" else [{"reference": "Device/medseal-companion-agent"}],
        "payload": [{"contentString": message}],
        "sent": datetime.utcnow().isoformat()
    })

@tool
def write_questionnaire_response(patient_id: str, questionnaire_id: str, answers: list[dict]) -> dict:
    """Store a completed PRO questionnaire response.
    Args: answers = [{linkId, answer: [{valueInteger or valueString or valueCoding}]}].
    Returns: Created FHIR QuestionnaireResponse resource."""
    return medplum.create("QuestionnaireResponse", {
        "resourceType": "QuestionnaireResponse",
        "status": "completed",
        "questionnaire": f"Questionnaire/{questionnaire_id}",
        "subject": {"reference": f"Patient/{patient_id}"},
        "authored": datetime.utcnow().isoformat(),
        "source": {"reference": f"Patient/{patient_id}"},
        "item": answers
    })

@tool
def delegate_to_clinical(query: str, patient_id: str) -> str:
    """Delegate a medical question to the Clinical Reasoning Agent (A2).
    Use when the patient asks about drug interactions, lab interpretation,
    condition progression, or anything requiring EHR synthesis.
    Returns: Structured clinical answer (not patient-facing; rephrase before delivery)."""
    return orchestrator.call_agent("clinical-reasoning-agent", query=query, patient_id=patient_id)

@tool
def delegate_to_lifestyle(query: str, patient_id: str) -> str:
    """Delegate a dietary or exercise question to the Lifestyle Agent (A4).
    Use when the patient asks about food, meals, exercise, weight, or lifestyle changes.
    Returns: Structured lifestyle recommendation (rephrase before delivery)."""
    return orchestrator.call_agent("lifestyle-agent", query=query, patient_id=patient_id)
```

### System prompt

```
You are the Med-SEAL Companion, a caring and knowledgeable health assistant for patients
managing chronic conditions (diabetes, hypertension, hyperlipidemia) in Singapore and
Southeast Asia.

IDENTITY:
- You speak the patient's preferred language: English, Mandarin (简体中文), Malay, or Tamil.
- You use culturally appropriate tone: respectful forms in Malay/Tamil, dialect awareness
  for Mandarin, warm but professional in English.
- You are empathetic first, informative second. Acknowledge feelings before giving advice.
- You never claim to be a doctor. You are a health companion.

CAPABILITIES:
- Answer general health questions using your training knowledge.
- Read the patient's EHR data (conditions, medications, vitals) using your tools.
- Explain lab results and medication purposes in plain, jargon-free language.
- Collect patient-reported outcomes (PROs) conversationally, not as rigid forms.
- Provide emotional support and motivation for self-management.

DELEGATION RULES:
- If the patient asks about drug interactions, medication changes, or complex clinical
  questions: call delegate_to_clinical(). Rephrase the answer in patient-friendly language.
- If the patient asks about food, diet, exercise, or lifestyle: call delegate_to_lifestyle().
  Rephrase the answer with cultural context.
- NEVER fabricate clinical data. If you don't have the information, say so and suggest
  the patient ask their doctor.
- NEVER provide a diagnosis. You may explain what conditions the patient already has
  on record, but never suggest new diagnoses.

CONVERSATION STYLE:
- Keep responses concise: 2-4 sentences for simple questions, up to 6 for complex topics.
- Use analogies the patient would understand (e.g., "Think of insulin like a key that
  unlocks your cells to let sugar in").
- After delivering clinical information, always check: "Does that make sense?" or
  "Would you like me to explain further?"
- When collecting PROs, weave questions naturally into conversation. Instead of
  "Rate your diabetes distress 1-5", ask "How have you been feeling about managing
  your diabetes this past week?"

SAFETY:
- If the patient expresses suicidal thoughts, self-harm intent, or severe distress:
  respond with empathy, do NOT attempt to handle clinically, and immediately trigger
  escalation via the nudge agent (high severity).
- If the patient reports a medical emergency (chest pain, difficulty breathing, stroke
  symptoms): instruct them to call 995 (Singapore) or go to the nearest A&E immediately.
  Do not attempt to triage.
- Never recommend stopping or changing prescribed medications.

CONTEXT (injected per conversation):
Patient ID: {patient_id}
Patient name: {patient_name}
Language: {preferred_language}
Active conditions: {conditions_summary}
Current medications: {medications_summary}
Recent vitals: {recent_vitals_summary}
```

### Delegation patterns

```
Patient message
  |
  v
A1 classifies intent
  |
  +-- casual/greeting --> A1 responds directly
  +-- general health question --> A1 responds from training knowledge
  +-- EHR-specific question ("what's my latest HbA1c?") --> A1 calls read_recent_observations
  +-- complex medical question --> A1 calls delegate_to_clinical (A2)
  |                                  --> A2 returns structured answer
  |                                  --> A1 rephrases in patient language
  +-- diet/exercise question --> A1 calls delegate_to_lifestyle (A4)
  |                              --> A4 returns structured recommendation
  |                              --> A1 rephrases with cultural context
  +-- PRO collection trigger --> A1 enters PRO conversation mode
  |                              --> A1 maps free-text to QuestionnaireResponse
  +-- emergency/crisis keywords --> A1 delivers safety response
                                    --> A1 signals A3 for high-severity escalation
```

### Error handling

| Error | Action |
|---|---|
| MERaLiON timeout (>5s) | Fall back to SEA-LION only; log degraded mode |
| A2 delegation failure | Respond: "I'm having trouble looking that up right now. Could you ask your doctor at your next visit?" |
| A4 delegation failure | Respond with general dietary advice from training knowledge; note limitation |
| FHIR read failure | Respond conversationally without EHR data; log error |
| Guard BLOCK on output | Regenerate response with higher safety constraints; if blocked twice, respond with generic safe message |
| Patient sends image | Acknowledge receipt; if medical image, note limitation ("I can't analyze images, but your doctor can review this at your next visit") |

### Health check

```python
async def health_check() -> dict:
    return {
        "agent": "companion-agent",
        "meralion_available": await ping("http://meralion.medseal.internal:8000/health"),
        "sealion_available": await ping("http://sealion.medseal.internal:8000/health"),
        "medplum_available": await medplum.ping(),
        "guard_available": await ping("http://guard.medseal.internal:8000/health"),
        "status": "ok" if all_above else "degraded"
    }
```

---

## A2: Clinical Reasoning Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `clinical-reasoning-agent` |
| FHIR Device ID | `Device/medseal-clinical-agent` |
| Surface | Both (called by A1 for patients, by A5 for clinicians) |
| Model | Qwen3-VL-8B-Thinking (Med-SEAL fine-tuned) |
| Max response tokens | 1024 |
| Temperature | 0.3 (precise clinical reasoning) |
| Thinking mode | Enabled (chain-of-thought before answer) |

### Role

The Clinical Reasoning Agent is the medical brain of the system. It synthesises EHR data to answer clinical questions: drug interactions, lab interpretation, condition progression, risk assessment, and treatment context. It never speaks directly to the patient. It returns structured clinical responses to A1 (for patient rephrasing) or A5 (for clinician summaries). This is the existing OpenEMR agent from Med-SEAL Rad, now serving additional callers.

### FHIR scopes

```
patient/Patient.read
patient/Patient.$everything
patient/Condition.read
patient/Observation.read
patient/MedicationRequest.read
patient/AllergyIntolerance.read
patient/Encounter.read
patient/CarePlan.read
patient/Procedure.read
patient/Immunization.read
patient/DocumentReference.read
patient/Composition.write
patient/ServiceRequest.write
```

### smolagents tool registry

```python
@tool
def patient_everything(patient_id: str) -> dict:
    """Retrieve comprehensive patient record as FHIR Bundle.
    Returns: FHIR Bundle containing all resources in patient compartment."""
    return medplum.operation(f"Patient/{patient_id}/$everything")

@tool
def search_conditions(patient_id: str, snomed_code: str = None) -> list[dict]:
    """Search conditions by SNOMED CT code.
    Args: snomed_code = SNOMED CT code (optional, returns all if omitted).
    Returns: List of FHIR Condition resources."""
    params = {"patient": patient_id, "clinical-status": "active"}
    if snomed_code:
        params["code"] = f"http://snomed.info/sct|{snomed_code}"
    return medplum.search("Condition", params)

@tool
def search_observations(patient_id: str, loinc_code: str, period_days: int = 90) -> list[dict]:
    """Search observations by LOINC code within time period.
    Args: loinc_code = LOINC code (e.g., '4548-4' for HbA1c), period_days = lookback.
    Returns: List of FHIR Observation resources sorted by date."""
    start = (datetime.utcnow() - timedelta(days=period_days)).strftime("%Y-%m-%d")
    return medplum.search("Observation", {
        "patient": patient_id,
        "code": f"http://loinc.org|{loinc_code}",
        "date": f"ge{start}",
        "_sort": "-date"
    })

@tool
def search_medications(patient_id: str) -> list[dict]:
    """Get all active medications with dosage instructions.
    Returns: List of FHIR MedicationRequest resources."""
    return medplum.search("MedicationRequest", {"patient": patient_id, "status": "active"})

@tool
def search_allergies(patient_id: str) -> list[dict]:
    """Get allergy and intolerance records.
    Returns: List of FHIR AllergyIntolerance resources."""
    return medplum.search("AllergyIntolerance", {"patient": patient_id, "clinical-status": "active"})

@tool
def check_drug_interaction(medication_codes: list[str]) -> dict:
    """Check for drug-drug interactions using RxNorm codes.
    Args: medication_codes = list of RxNorm codes.
    Returns: {interactions: [{severity, description, drug_pair}], safe: bool}."""
    return terminology_service.check_interactions(medication_codes)

@tool
def write_composition(patient_id: str, title: str, sections: list[dict]) -> dict:
    """Write a clinical summary as FHIR Composition.
    Args: sections = [{title, code_loinc, text_html, entry_refs[]}].
    Returns: Created FHIR Composition resource."""
    return medplum.create("Composition", build_composition(patient_id, title, sections))

@tool
def search_encounters(patient_id: str, status: str = None, period_days: int = 365) -> list[dict]:
    """Search patient encounters (visits, admissions).
    Returns: List of FHIR Encounter resources."""
    params = {"patient": patient_id, "_sort": "-date"}
    if status:
        params["status"] = status
    return medplum.search("Encounter", params)
```

### System prompt

```
You are the Med-SEAL Clinical Reasoning Agent, a medical AI assistant for clinical
decision support in chronic disease management (diabetes, hypertension, hyperlipidemia).

ROLE:
- You synthesise electronic health record (EHR) data to answer clinical questions.
- You are called by other agents (Companion, Insight Synthesis, Nudge) -- you never
  interact directly with patients or clinicians.
- Your responses are structured clinical assessments, not patient-friendly text.

CLINICAL REASONING:
- Always cite specific EHR data points: "HbA1c 7.2% (2026-02-15, LOINC:4548-4)".
- Use SNOMED CT codes for diagnoses, LOINC for lab results, RxNorm for medications.
- When assessing drug interactions, check AllergyIntolerance first.
- For trend analysis, compare at least 3 data points over 90+ days.
- State confidence level: high (clear EHR evidence), medium (partial data), low (insufficient data).

OUTPUT FORMAT:
Return structured JSON:
{
  "assessment": "plain text clinical summary",
  "evidence": [{"resource_type", "resource_id", "key_value", "date"}],
  "confidence": "high/medium/low",
  "warnings": ["any safety concerns"],
  "suggested_actions": ["optional clinician follow-ups"]
}

SAFETY:
- NEVER fabricate data not present in the EHR.
- If data is missing, state explicitly: "No HbA1c on record in the last 6 months."
- NEVER recommend starting, stopping, or changing medications. You may flag interactions
  or contraindications for clinician review.
- All outputs pass through SEA-LION Guard before reaching any surface.

CONTEXT (injected per call):
Patient ID: {patient_id}
Caller: {calling_agent_id}
Query: {query}
```

### Delegation patterns

```
A1 calls A2: "Patient asks about metformin side effects"
  --> A2 reads MedicationRequest for metformin
  --> A2 reads AllergyIntolerance
  --> A2 returns structured assessment
  --> A1 rephrases for patient

A5 calls A2: "Generate clinical context for pre-visit summary"
  --> A2 calls patient_everything
  --> A2 synthesises into Composition sections
  --> A5 enriches with patient-side data

A3 calls A2: "Provide clinical context for escalation"
  --> A2 reads relevant Conditions + Observations
  --> A2 returns risk context for the Flag resource
```

### Error handling

| Error | Action |
|---|---|
| Qwen3-VL timeout (>10s) | Return partial answer with confidence=low; log timeout |
| FHIR search returns empty | Include in response: "No {resource} records found for this patient" |
| Drug interaction check failure | Proceed without interaction data; add warning: "Drug interaction check unavailable" |
| Guard BLOCK on output | Regenerate with explicit instruction to avoid the flagged content; log for review |

---

## A3: Nudge Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `nudge-agent` |
| FHIR Device ID | `Device/medseal-nudge-agent` |
| Surface | Patient app (nudges) + OpenEMR (escalation) |
| Model | MERaLiON (message generation) + rule engine (triggers) |
| Max response tokens | 256 (nudges are brief) |
| Temperature | 0.6 |

### Role

The Nudge Agent is the proactive engine. It does not wait for the patient to start a conversation. It runs on schedules and event triggers, monitoring FHIR data streams for actionable signals. When a trigger fires, it generates empathetic, culturally appropriate nudge messages via MERaLiON and delivers them to the patient app. For severe signals, it escalates to the clinician via FHIR Flag and CommunicationRequest. It also manages the behavioral anticipation model (F11) and PRO scheduling (F04 triggers).

### FHIR scopes

```
patient/MedicationAdministration.read
patient/Observation.read
patient/Communication.write
patient/Communication.read
patient/CommunicationRequest.write
patient/Flag.write
patient/Flag.read
patient/RiskAssessment.write
patient/Appointment.read
patient/DetectedIssue.write
system/Subscription.read
```

### smolagents tool registry

```python
@tool
def check_medication_adherence(patient_id: str, lookback_hours: int = 24) -> dict:
    """Check for missed medication doses in the lookback window.
    Returns: {missed_doses: [{medication_name, expected_time, gap_hours}], adherence_today: bool}."""
    requests = medplum.search("MedicationRequest", {"patient": patient_id, "status": "active"})
    administrations = medplum.search("MedicationAdministration", {
        "patient": patient_id,
        "effective-time": f"ge{(datetime.utcnow() - timedelta(hours=lookback_hours)).isoformat()}"
    })
    return compute_gaps(requests, administrations)

@tool
def check_biometric_thresholds(patient_id: str) -> dict:
    """Check latest vitals against configured thresholds.
    Returns: {breaches: [{vital, value, threshold, direction, observation_id}], all_normal: bool}."""
    thresholds = get_patient_thresholds(patient_id)  # condition-specific
    latest = medplum.search("Observation", {
        "patient": patient_id, "category": "vital-signs", "_sort": "-date", "_count": 10
    })
    return evaluate_thresholds(latest, thresholds)

@tool
def check_engagement(patient_id: str, lookback_days: int = 7) -> dict:
    """Check patient app engagement over the lookback period.
    Returns: {days_active, days_inactive, last_interaction, trend: rising/stable/declining, decay_risk: bool}."""
    comms = medplum.search("Communication", {
        "patient": patient_id,
        "sent": f"ge{(datetime.utcnow() - timedelta(days=lookback_days)).isoformat()}"
    })
    return compute_engagement(comms, lookback_days)

@tool
def get_upcoming_appointments(patient_id: str, lookahead_hours: int = 72) -> list[dict]:
    """Get appointments in the next N hours.
    Returns: List of FHIR Appointment resources."""
    return medplum.search("Appointment", {
        "patient": patient_id,
        "date": f"le{(datetime.utcnow() + timedelta(hours=lookahead_hours)).isoformat()}",
        "status": "booked"
    })

@tool
def send_nudge(patient_id: str, message: str, priority: str = "routine") -> dict:
    """Deliver a nudge message to the patient app and record it.
    Args: priority = routine/urgent.
    Returns: Created FHIR Communication resource."""
    comm = medplum.create("Communication", {
        "resourceType": "Communication",
        "status": "completed",
        "category": [{"coding": [{"system": "http://medseal.ai/fhir/CodeSystem/comm-type", "code": "nudge"}]}],
        "subject": {"reference": f"Patient/{patient_id}"},
        "sender": {"reference": "Device/medseal-nudge-agent"},
        "payload": [{"contentString": message}],
        "sent": datetime.utcnow().isoformat(),
        "priority": priority
    })
    push_notification(patient_id, title="Med-SEAL", body=message[:100])
    return comm

@tool
def escalate_to_clinician(patient_id: str, severity: str, reason: str, evidence_refs: list[str]) -> dict:
    """Create a clinical escalation (Flag + CommunicationRequest).
    Args: severity = low/medium/high, evidence_refs = FHIR resource references.
    Returns: {flag_id, communication_request_id}."""
    flag = medplum.create("Flag", {
        "resourceType": "Flag",
        "status": "active",
        "category": [{"coding": [{"system": "http://medseal.ai/fhir/CodeSystem/flag-type", "code": f"escalation-{severity}"}]}],
        "code": {"text": reason},
        "subject": {"reference": f"Patient/{patient_id}"},
        "author": {"reference": "Device/medseal-nudge-agent"}
    })
    care_team = medplum.search("CareTeam", {"patient": patient_id, "status": "active"})
    practitioner_ref = extract_primary_practitioner(care_team)
    comm_req = medplum.create("CommunicationRequest", {
        "resourceType": "CommunicationRequest",
        "status": "active",
        "priority": "urgent" if severity == "high" else "routine",
        "subject": {"reference": f"Patient/{patient_id}"},
        "recipient": [{"reference": practitioner_ref}],
        "payload": [{"contentString": f"[{severity.upper()}] {reason}"}],
        "reasonReference": [{"reference": f"Flag/{flag['id']}"}]
    })
    return {"flag_id": flag["id"], "communication_request_id": comm_req["id"]}

@tool
def write_risk_assessment(patient_id: str, risk_type: str, probability: float, basis_refs: list[str]) -> dict:
    """Write a behavioral risk assessment (F11).
    Args: risk_type = disengagement/non-adherence/clinical-deterioration, probability = 0.0-1.0.
    Returns: Created FHIR RiskAssessment resource."""
    return medplum.create("RiskAssessment", {
        "resourceType": "RiskAssessment",
        "status": "final",
        "subject": {"reference": f"Patient/{patient_id}"},
        "method": {"coding": [{"system": "http://medseal.ai/fhir/CodeSystem/risk-method", "code": "behavioral-anticipation"}]},
        "prediction": [{"outcome": {"text": risk_type}, "probabilityDecimal": probability}],
        "basis": [{"reference": ref} for ref in basis_refs],
        "performer": {"reference": "Device/medseal-nudge-agent"}
    })
```

### Trigger configuration

```yaml
triggers:
  missed_dose:
    type: event
    source: FHIR Subscription on MedicationAdministration
    condition: "No MedicationAdministration written within dosageInstruction.timing window + 60min grace"
    action: generate_medication_nudge
    escalation_threshold: 3 consecutive misses --> medium escalation

  high_biometric:
    type: event
    source: FHIR Subscription on Observation (category=vital-signs)
    conditions:
      bp_systolic_high: "valueQuantity.value > 180"
      bp_systolic_elevated: "valueQuantity.value > 140"
      glucose_high: "valueQuantity.value > 13.9 mmol/L"
      glucose_low: "valueQuantity.value < 3.9 mmol/L"
    action:
      critical (>180 or <3.9): immediate high escalation + patient safety message
      elevated (>140 or >13.9): patient nudge + log

  daily_checkin:
    type: cron
    schedule: "0 9 * * *"  # 9:00 AM patient timezone
    condition: "No patient-initiated Communication in last 24h"
    action: generate_engagement_nudge

  appointment_reminder:
    type: cron
    schedule: "0 * * * *"  # hourly check
    conditions:
      72h_before: generate_preparation_nudge
      24h_before: generate_reminder_nudge
      2h_before: generate_final_reminder

  pro_schedule:
    type: cron
    schedule: "0 10 1,15 * *"  # 1st and 15th of month
    condition: "Active Condition includes diabetes or hypertension"
    action: signal A1 to initiate PRO conversation

  engagement_decay:
    type: cron
    schedule: "0 20 * * *"  # daily evening check
    condition: "check_engagement returns decay_risk=true"
    action: generate_reengagement_nudge (tone-adapted, motivational)

  behavioral_anticipation:
    type: cron
    schedule: "0 6 * * 1"  # weekly Monday morning
    action: compute_risk_scores, write_risk_assessment, adjust_nudge_frequency
```

### System prompt (for message generation)

```
You are generating a brief, empathetic health nudge message for a patient managing
chronic conditions in Singapore/Southeast Asia.

RULES:
- Maximum 2 sentences.
- Warm, encouraging tone. Never guilt-tripping or commanding.
- Use the patient's language: {preferred_language}.
- Reference the specific context: {trigger_context}.
- End with an invitation, not a demand: "Would you like to chat about it?" not "You must take your medication."
- For Malay/Tamil: use respectful forms appropriate for elderly patients.
- For Mandarin: use standard simplified Chinese, warm register.

CONTEXT:
Patient name: {patient_name}
Trigger: {trigger_type}
Details: {trigger_details}
```

### Error handling

| Error | Action |
|---|---|
| MERaLiON timeout | Use template-based nudge (pre-written per trigger type per language); log degradation |
| FHIR Subscription missed | Cron fallback runs same checks every 15 minutes |
| Push notification failure | Store nudge in Communication; patient sees on next app open |
| Escalation target practitioner not found | Escalate to all CareTeam members; log missing assignment |

---

## A4: Lifestyle Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `lifestyle-agent` |
| FHIR Device ID | `Device/medseal-lifestyle-agent` |
| Surface | Patient app (via A1 delegation) |
| Model | SEA-LION (multilingual + SEA cultural context) |
| Knowledge bases | HPB food database, drug-food interaction DB, cultural calendar |
| Max response tokens | 512 |
| Temperature | 0.5 |

### Role

The Lifestyle Agent handles dietary recommendations, exercise guidance, and wellness goal tracking. It is the only agent with access to the nutrition knowledge base. It understands Singapore and Southeast Asian food context including hawker centre meals, festive foods, and local ingredients. It never speaks directly to the patient; it returns structured recommendations to A1 for delivery.

### FHIR scopes

```
patient/Condition.read
patient/MedicationRequest.read
patient/Observation.read
patient/Goal.read
patient/Goal.write
patient/CarePlan.read
patient/CarePlan.write
patient/NutritionOrder.write
```

### smolagents tool registry

```python
@tool
def read_patient_conditions(patient_id: str) -> list[dict]:
    """Read active conditions to determine dietary constraints.
    Returns: List of conditions with SNOMED codes."""
    return medplum.search("Condition", {"patient": patient_id, "clinical-status": "active"})

@tool
def read_patient_medications(patient_id: str) -> list[dict]:
    """Read medications for drug-food interaction checking.
    Returns: List of MedicationRequest with RxNorm codes."""
    return medplum.search("MedicationRequest", {"patient": patient_id, "status": "active"})

@tool
def read_latest_biometrics(patient_id: str) -> dict:
    """Read latest weight, BMI, glucose, HbA1c for dietary context.
    Returns: {weight, bmi, glucose, hba1c, bp} with dates."""
    vitals = {}
    for code, name in [("29463-7", "weight"), ("39156-5", "bmi"), ("2345-7", "glucose"), ("4548-4", "hba1c")]:
        obs = medplum.search("Observation", {"patient": patient_id, "code": f"http://loinc.org|{code}", "_sort": "-date", "_count": 1})
        if obs:
            vitals[name] = {"value": obs[0]["valueQuantity"]["value"], "unit": obs[0]["valueQuantity"]["unit"], "date": obs[0]["effectiveDateTime"]}
    return vitals

@tool
def read_patient_goals(patient_id: str) -> list[dict]:
    """Read active wellness goals.
    Returns: List of FHIR Goal resources."""
    return medplum.search("Goal", {"patient": patient_id, "lifecycle-status": "active"})

@tool
def query_food_database(query: str, dietary_constraints: list[str]) -> list[dict]:
    """Search the HPB/SEA food database for suitable options.
    Args: query = food type or meal context, dietary_constraints = [low-sodium, low-gi, etc].
    Returns: List of food items with nutritional data and healthier alternatives."""
    return food_kb.search(query, constraints=dietary_constraints)

@tool
def check_food_drug_interactions(food_items: list[str], medication_codes: list[str]) -> list[dict]:
    """Check for food-drug interactions.
    Returns: List of {food, drug, severity, recommendation}."""
    return interaction_db.check(food_items, medication_codes)

@tool
def write_goal(patient_id: str, description: str, target_value: float, target_unit: str, due_date: str) -> dict:
    """Create a wellness goal for the patient.
    Returns: Created FHIR Goal resource."""
    return medplum.create("Goal", {
        "resourceType": "Goal",
        "lifecycleStatus": "active",
        "subject": {"reference": f"Patient/{patient_id}"},
        "description": {"text": description},
        "target": [{"measure": {"text": description}, "detailQuantity": {"value": target_value, "unit": target_unit}, "dueDate": due_date}],
        "expressedBy": {"reference": f"Patient/{patient_id}"}
    })

@tool
def update_goal_status(goal_id: str, status: str, progress_note: str = None) -> dict:
    """Update goal achievement status.
    Args: status = in-progress/improving/worsening/achieved/no-change.
    Returns: Updated FHIR Goal resource."""
    updates = {"achievementStatus": {"coding": [{"system": "http://terminology.hl7.org/CodeSystem/goal-achievement", "code": status}]}}
    if progress_note:
        updates["note"] = [{"text": progress_note, "time": datetime.utcnow().isoformat()}]
    return medplum.update(f"Goal/{goal_id}", updates)

@tool
def write_nutrition_order(patient_id: str, diet_type: str, instructions: str, nutrients: list[dict]) -> dict:
    """Write a nutrition recommendation.
    Args: nutrients = [{name, amount, unit}].
    Returns: Created FHIR NutritionOrder resource."""
    return medplum.create("NutritionOrder", {
        "resourceType": "NutritionOrder",
        "status": "active",
        "patient": {"reference": f"Patient/{patient_id}"},
        "dateTime": datetime.utcnow().isoformat(),
        "orderer": {"reference": "Device/medseal-lifestyle-agent"},
        "oralDiet": {
            "type": [{"text": diet_type}],
            "instruction": instructions,
            "nutrient": [{"modifier": {"text": n["name"]}, "amount": {"value": n["amount"], "unit": n["unit"]}} for n in nutrients]
        }
    })
```

### System prompt

```
You are the Med-SEAL Lifestyle Agent, a dietary and wellness coach specializing in
chronic disease management for patients in Singapore and Southeast Asia.

EXPERTISE:
- Singapore and SEA food context: hawker centre meals, local dishes (nasi lemak, mee siam,
  roti prata, thosai, char kway teow, ban mian), festive foods (CNY reunion dinner,
  Hari Raya rendang, Deepavali murukku, Pongal sweet rice).
- Practical substitutions: brown rice for white rice, less coconut milk in curry,
  grilled instead of fried, smaller nasi lemak portion.
- Drug-food interactions: grapefruit with statins, high-potassium foods with ACE inhibitors,
  consistent vitamin K intake with warfarin.
- Exercise for chronic conditions: walking, tai chi, swimming adapted to the patient's
  mobility and climate (Singapore heat and humidity).

OUTPUT FORMAT:
Return structured JSON (A1 will rephrase for the patient):
{
  "recommendations": [{"category": "diet/exercise/goal", "text": "specific recommendation", "reason": "why"}],
  "warnings": [{"food": "grapefruit", "drug": "simvastatin", "severity": "high", "message": "avoid"}],
  "alternatives": [{"instead_of": "white rice nasi lemak", "try": "brown rice, 3/4 portion", "benefit": "lower GI, fewer calories"}],
  "goal_suggestions": [{"description": "target", "value": 0, "unit": "string", "timeframe": "string"}]
}

RULES:
- Never recommend extreme diets or fasting without clinician guidance.
- Always respect cultural and religious dietary requirements (halal, vegetarian for Hindu patients, etc.).
- Frame recommendations positively: "try this" not "don't eat that".
- Base recommendations on the patient's actual conditions, medications, and latest biometrics.

CONTEXT (injected per call):
Patient ID: {patient_id}
Active conditions: {conditions}
Current medications: {medications}
Latest biometrics: {biometrics}
Active goals: {goals}
Patient query: {query}
```

---

## A5: Insight Synthesis Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `insight-synthesis-agent` |
| FHIR Device ID | `Device/medseal-insight-agent` |
| Surface | OpenEMR (clinician-facing) |
| Model | Qwen3-VL-8B-Thinking (Med-SEAL) |
| Max response tokens | 2048 (summaries are detailed) |
| Temperature | 0.2 (factual, structured output) |

### Role

The Insight Synthesis Agent aggregates all patient-side data (adherence, biometrics, PROs, engagement, goals, flags) and synthesises a concise FHIR Composition that appears in the clinician's OpenEMR chart as a pre-visit brief. It replaces 20 minutes of chart review with a 30-second read. It is triggered by CDS Hooks (patient-view) or scheduled 24 hours before appointments.

### FHIR scopes

```
patient/Observation.read
patient/MedicationAdministration.read
patient/QuestionnaireResponse.read
patient/Communication.read
patient/Flag.read
patient/Goal.read
patient/RiskAssessment.read
patient/Composition.write
patient/Provenance.write
system/AuditEvent.write
```

### smolagents tool registry

```python
@tool
def read_adherence_data(patient_id: str, period_days: int = 30) -> dict:
    """Read medication adherence metrics for the period.
    Returns: {overall_pdc, per_medication: [{name, pdc, missed_count}], trend}."""

@tool
def read_biometric_trends(patient_id: str, period_days: int = 30) -> dict:
    """Read vital sign trends with 7-day and 30-day averages.
    Returns: {vitals: [{type, latest, avg_7d, avg_30d, trend, anomalies[]}]}."""

@tool
def read_pro_scores(patient_id: str) -> dict:
    """Read latest PRO scores and deltas from previous collection.
    Returns: {instruments: [{name, current_score, previous_score, delta, clinical_interpretation}]}."""

@tool
def read_engagement_metrics(patient_id: str, period_days: int = 30) -> dict:
    """Read app engagement and nudge response data.
    Returns: {interactions_per_week, nudge_response_rate, last_active, topics_discussed[]}."""

@tool
def read_active_flags(patient_id: str) -> list[dict]:
    """Read active clinical flags (escalations from nudge agent).
    Returns: List of FHIR Flag resources with context."""

@tool
def read_goal_progress(patient_id: str) -> list[dict]:
    """Read all active goals with achievement status.
    Returns: List of {description, target, current, achievement_status, trajectory}."""

@tool
def read_risk_assessments(patient_id: str) -> list[dict]:
    """Read behavioral risk assessments from the anticipation model.
    Returns: List of FHIR RiskAssessment resources."""

@tool
def delegate_clinical_context(patient_id: str) -> dict:
    """Get clinical summary from the Clinical Reasoning Agent (A2).
    Returns: Structured clinical assessment."""
    return orchestrator.call_agent("clinical-reasoning-agent",
        query="Provide clinical context summary for pre-visit brief", patient_id=patient_id)

@tool
def write_composition(patient_id: str, sections: list[dict]) -> dict:
    """Write the pre-visit brief as FHIR Composition.
    Returns: Created Composition with Provenance."""

@tool
def write_provenance(target_ref: str, sources: list[str]) -> dict:
    """Write provenance chain for the generated Composition.
    Returns: Created FHIR Provenance resource."""
```

### System prompt

```
You are the Med-SEAL Insight Synthesis Agent. You generate structured pre-visit briefs
for clinicians by aggregating patient-side data from the Med-SEAL patient app.

OUTPUT:
A FHIR Composition with exactly 7 sections:
1. Adherence summary: per-medication PDC %, missed dose patterns, overall trend.
2. Biometric trends: BP/glucose/weight direction, anomalies flagged, sparkline data points.
3. PRO scores: current instrument scores, delta from last collection, clinical interpretation.
4. Engagement level: app usage frequency, nudge response rate, conversation topics.
5. Flagged concerns: active Flags from nudge agent, conversation safety flags.
6. Goal progress: each Goal with % completion and trajectory (on-track/at-risk/off-track).
7. Recommended actions: suggested clinician follow-ups based on all data patterns.

RULES:
- Be concise. Each section = 2-3 sentences maximum.
- Cite specific numbers: "PDC 78% for metformin (target 80%), declining from 85% last month."
- Flag actionable items clearly: "[ACTION] Consider adjusting amlodipine -- BP averaging 148/92 despite adherence."
- Do not include raw data dumps. Synthesise and interpret.
- Status = preliminary. Clinician reviews and finalizes.
```

---

## A6: Measurement Agent

### Identity

| Field | Value |
|---|---|
| Agent ID | `measurement-agent` |
| FHIR Device ID | `Device/medseal-measurement-agent` |
| Surface | Both (patient dashboard + OpenEMR analytics) |
| Model | None (rule-based analytics engine, no LLM) |
| Implementation | Python analytics service with FHIR client |

### Role

The Measurement Agent is the evaluator. It computes outcome metrics across the patient population: medication adherence rates, biometric improvement trends, PRO score changes, engagement frequency, readmission events, and satisfaction scores. It generates FHIR MeasureReport resources for individual patients and cohort-level analysis. It powers the analytics dashboard (F09) and provides data to all other agents. It also manages the A/B evaluation framework (F17) and data fusion timeline (F15).

### FHIR scopes

```
patient/Observation.read
patient/MedicationAdministration.read
patient/QuestionnaireResponse.read
patient/Encounter.read
patient/Communication.read
patient/Goal.read
system/Measure.read
system/MeasureReport.write
system/MeasureReport.read
```

### Metrics computed

| Metric ID | Name | Formula | FHIR resources used | Schedule |
|---|---|---|---|---|
| `adherence-pdc` | Proportion of days covered | days_with_dose / days_in_period | MedicationAdministration, MedicationRequest | Weekly |
| `bp-trend` | Blood pressure trend slope | Linear regression on systolic over 30 days | Observation (LOINC:8480-6) | Weekly |
| `glucose-trend` | Glucose trend slope | Linear regression on fasting glucose over 30 days | Observation (LOINC:2345-7) | Weekly |
| `hba1c-delta` | HbA1c change from baseline | latest_hba1c - baseline_hba1c | Observation (LOINC:4548-4) | On new result |
| `pro-change` | PRO score delta | current_score - previous_score per instrument | Observation (derived from QuestionnaireResponse) | On new PRO |
| `engagement-rate` | Weekly interaction frequency | patient_initiated_comms / 7 | Communication | Weekly |
| `nudge-response` | Nudge response rate | responded_nudges / sent_nudges | Communication, CommunicationRequest | Weekly |
| `readmission-count` | Readmission events | Count of Encounter (class=inpatient/emergency) in period | Encounter | Monthly |
| `time-to-intervention` | Median trigger-to-nudge latency | median(nudge_sent - trigger_fired) | Communication, FHIR Subscription logs | Weekly |
| `nps-score` | Net Promoter Score | (promoters - detractors) / total * 100 | Observation (medseal:nps-score) | Monthly |

### Error handling

| Error | Action |
|---|---|
| Insufficient data for metric | Set MeasureReport.group.measureScore = null; add note: "Insufficient data (N < minimum)" |
| FHIR query timeout | Retry with smaller date range; if still failing, skip metric and log |
| Division by zero (no denominator) | Return 0 with note explaining empty denominator |

---

## G1: SEA-LION Guard

### Identity

| Field | Value |
|---|---|
| Agent ID | `sealion-guard` |
| FHIR Device ID | `Device/sealion-guard` |
| Surface | System-wide (every agent interaction) |
| Model | SEA-LION Guard v1.0 (AI Singapore) |
| Max latency target | <100ms for input gate, <200ms for output gate |

### Role

The SEA-LION Guard is the dual-gate safety layer. Every input from patients/clinicians passes through the input gate before reaching any agent. Every output from any agent passes through the output gate before reaching any surface. It validates content safety, FHIR conformance, terminology binding, hallucination risk, and patient compartment access.

### Input gate checks

| Check | Method | Decision |
|---|---|---|
| Prompt injection | Classifier on input text | BLOCK if detected |
| Multilingual toxicity | SEA-LION Guard toxicity head (EN/ZH/MS/TA/ID) | BLOCK if toxic |
| PII in query | Regex + NER for NRIC, phone, address | MODIFY (redact) |
| Patient reference valid | FHIR read Patient/{id} | BLOCK if not found |
| ImagingStudy ownership | FHIR search ImagingStudy?patient={id} | BLOCK if mismatch |
| Patient compartment | Verify all requested resources belong to patient | BLOCK if outside |

### Output gate checks

| Check | Method | Decision |
|---|---|---|
| FHIR profile validation | Medplum $validate operation | FLAG if invalid |
| Terminology binding | Medplum $validate-code per coding | FLAG if invalid code |
| Hallucination (DiagnosticReport) | Cross-reference findings vs source data | ESCALATE if unsupported |
| Clinical harm | Classifier for dangerous recommendations | BLOCK if harmful |
| Provenance required | Check Provenance exists for AI outputs | FLAG if missing |
| Response language safety | Toxicity check on generated text | BLOCK if toxic |

### FHIR scopes

```
system/*.read
system/AuditEvent.write
system/Provenance.write
```

---

## O1: smolagents Orchestrator

### Identity

| Field | Value |
|---|---|
| Agent ID | `orchestrator` |
| FHIR Device ID | `Device/medseal-orchestrator` |
| Surface | System-wide (routes all requests) |
| Model | None (rule-based routing) |
| Framework | smolagents (HuggingFace) |

### Role

The Orchestrator is the central router. It receives validated inputs from the Guard, classifies intent, creates FHIR Task resources, routes to the appropriate agent(s), collects responses, packages into atomic FHIR transaction Bundles, and coordinates the output guard validation before persistence.

### Routing rules

```python
class IntentClassifier:
    def classify(self, query: str, context: dict) -> Route:
        # Patient app surface
        if context["surface"] == "patient_app":
            if is_emergency(query):
                return Route(agent="companion-agent", priority="immediate", bypass_delegation=True)
            if is_dietary(query):
                return Route(agent="companion-agent", delegation="lifestyle-agent")
            if is_clinical(query):
                return Route(agent="companion-agent", delegation="clinical-reasoning-agent")
            return Route(agent="companion-agent")

        # OpenEMR surface (clinician)
        if context["surface"] == "openemr":
            if context["trigger"] == "patient-view":
                return Route(agent="insight-synthesis-agent")
            if context["trigger"] == "order-sign":
                return Route(agent="clinical-reasoning-agent")
            return Route(agent="clinical-reasoning-agent")

        # System triggers (cron, subscription)
        if context["surface"] == "system":
            if context["trigger_type"] in ["missed_dose", "high_biometric", "engagement_decay"]:
                return Route(agent="nudge-agent")
            if context["trigger_type"] == "measurement_schedule":
                return Route(agent="measurement-agent")
            if context["trigger_type"] == "pro_schedule":
                return Route(agent="nudge-agent", signal_to="companion-agent")
```

### FHIR Task lifecycle

```
1. Request received --> Guard input gate --> PASS
2. Orchestrator creates Task (status=in-progress)
3. Orchestrator routes to agent(s)
4. Agent(s) return response + FHIR resources
5. Guard output gate validates all resources
6. Orchestrator builds FHIR transaction Bundle
7. POST Bundle to Medplum (atomic)
8. Update Task (status=completed)
```

### FHIR scopes

```
system/Task.write
system/Task.read
patient/*.read
system/Bundle.write
```

### Error handling

| Error | Action |
|---|---|
| Agent timeout (>30s) | Cancel Task (status=failed), notify caller with timeout message |
| Agent crash | Retry once; if still fails, mark Task as failed, log error |
| Guard BLOCK on output | Return guard message to caller; Task status=rejected |
| Medplum Bundle POST failure | Retry with exponential backoff (3 attempts); if all fail, Task=failed, log for manual review |
| Multiple agent delegation | Run in parallel with asyncio.gather; merge results |

---

## Deployment configuration

### Docker Compose service map

```yaml
services:
  orchestrator:
    image: medseal/orchestrator:latest
    depends_on: [medplum, guard, meralion, sealion, medseal-vlm]
    environment:
      MEDPLUM_BASE_URL: http://medplum:8103/fhir
      GUARD_URL: http://guard:8000/v1
    ports: ["8080:8080"]

  companion-agent:
    image: medseal/companion-agent:latest
    depends_on: [orchestrator]
    environment:
      MERALION_URL: http://meralion:8000/v1
      SEALION_URL: http://sealion:8000/v1

  clinical-reasoning-agent:
    image: medseal/clinical-agent:latest
    depends_on: [orchestrator]
    environment:
      MEDSEAL_VLM_URL: http://medseal-vlm:8000/v1

  nudge-agent:
    image: medseal/nudge-agent:latest
    depends_on: [orchestrator]
    environment:
      MERALION_URL: http://meralion:8000/v1
      CRON_TIMEZONE: Asia/Singapore

  lifestyle-agent:
    image: medseal/lifestyle-agent:latest
    depends_on: [orchestrator]
    environment:
      SEALION_URL: http://sealion:8000/v1
      FOOD_KB_PATH: /data/hpb-food-db.json

  insight-synthesis-agent:
    image: medseal/insight-agent:latest
    depends_on: [orchestrator]
    environment:
      MEDSEAL_VLM_URL: http://medseal-vlm:8000/v1

  measurement-agent:
    image: medseal/measurement-agent:latest
    depends_on: [orchestrator]
    environment:
      CRON_TIMEZONE: Asia/Singapore

  guard:
    image: medseal/sealion-guard:latest
    environment:
      GUARD_MODEL_PATH: /models/sea-lion-guard-v1.0
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]

  meralion:
    image: vllm/vllm-openai:latest
    command: --model aisingapore/MERaLiON --max-model-len 4096
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]

  sealion:
    image: vllm/vllm-openai:latest
    command: --model aisingapore/SEA-LION-v3 --max-model-len 4096
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]

  medseal-vlm:
    image: vllm/vllm-openai:latest
    command: --model medseal/qwen3-vl-8b-thinking --max-model-len 8192 --tensor-parallel-size 2
    deploy:
      resources:
        reservations:
          devices:
            - capabilities: [gpu]
              count: 2

  medplum:
    image: medplum/medplum-server:latest
    ports: ["8103:8103"]

  openemr:
    image: openemr/openemr:latest
    ports: ["443:443"]
```

### GPU allocation (8x H200 cluster)

| GPU | Service |
|---|---|
| GPU 0 | MERaLiON (vLLM) |
| GPU 1 | SEA-LION chat (vLLM) |
| GPU 2 | SEA-LION Guard (vLLM) |
| GPU 3-4 | Qwen3-VL-8B Med-SEAL (vLLM, tensor parallel 2) |
| GPU 5-7 | Reserved for batch inference / scaling |

---

## Testing checklist per agent

| Test | A1 | A2 | A3 | A4 | A5 | A6 | G1 | O1 |
|---|---|---|---|---|---|---|---|---|
| Unit: tool functions return valid FHIR | x | x | x | x | x | x | x | x |
| Unit: system prompt produces expected format | x | x | x | x | x | - | x | - |
| Integration: delegation chain works | x | x | - | x | x | - | - | x |
| Integration: Guard validates output | x | x | x | x | x | x | - | - |
| Integration: FHIR resources persist to Medplum | x | x | x | x | x | x | x | x |
| E2E: patient asks question, gets answer | x | - | - | - | - | - | - | x |
| E2E: missed dose triggers nudge | - | - | x | - | - | - | - | x |
| E2E: pre-visit brief generated before appointment | - | - | - | - | x | x | - | x |
| E2E: high BP triggers escalation to clinician | - | - | x | - | - | - | x | x |
| Multilingual: EN, ZH, MS, TA responses correct | x | - | x | x | - | - | x | - |
| Safety: prompt injection blocked | - | - | - | - | - | - | x | - |
| Safety: harmful recommendation blocked | - | - | - | - | - | - | x | - |
| Performance: response latency < threshold | x | x | x | x | x | x | x | x |
| Failover: model timeout handled gracefully | x | x | x | x | x | - | x | x |
