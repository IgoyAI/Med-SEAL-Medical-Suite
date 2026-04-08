# MED-SEAL: Agentic AI for Patient Empowerment in Chronic Disease Management

## Problem

Singapore's ageing population faces a rising chronic disease burden — diabetes, hypertension, and hyperlipidemia affect over 1 million residents. Between clinic visits, patients navigate medication schedules, biometric monitoring, dietary restrictions, and appointment follow-ups largely on their own, leading to poor adherence, delayed escalation, and preventable complications.

## Solution

**Med-SEAL** (Medical — Systems for Empowerment with AI & Learning) is an **agentic AI platform** that provides proactive, empathetic, culturally aware, and personalised support to chronic disease patients — 24/7, outside of clinical settings. Built on **IMDA's National LLM SEA-LION** and interoperable healthcare standards (HL7 FHIR R4), Med-SEAL deploys **7 specialised AI agents** orchestrated by a safety-guarded multi-agent system:

| Agent | Role | Model |
|---|---|---|
| **Companion** (A1) | Empathetic multilingual patient chat (EN/ZH/MS/TA) | SEA-LION v4-32B |
| **Clinical Reasoning** (A2) | Evidence-based clinical Q&A grounded in patient FHIR records | Azure OpenAI (ChatGPT) |
| **Nudge** (A3) | Proactive medication reminders, biometric alerts, escalation | SEA-LION v4-32B |
| **Lifestyle** (A4) | Culturally-appropriate dietary coaching (hawker food, festive meals) | SEA-LION v4-32B |
| **Insight Synthesis** (A5) | Pre-visit clinical briefs for clinicians | SEA-LION v4-32B |
| **Doctor CDS** | Clinician-facing decision support within OpenEMR | SEA-LION v4-32B |
| **Pre-Visit Summary** | FHIR-based 11-section patient data aggregation | No LLM (pure FHIR) |

**SEA-Guard** (IMDA) wraps all agent inputs and outputs with safety checks — toxicity filtering, PII redaction, hallucination detection, and clinical harm prevention — ensuring responsible AI in healthcare.

## Key Innovation: National LLM Integration

Med-SEAL is built around IMDA's **SEA-LION ecosystem** as its primary AI backbone:

- **SEA-LION v4-32B** (`Qwen-SEA-LION-v4-32B-IT`) — powers 5 of 7 agents: patient conversation, nudge messaging, lifestyle coaching, insight synthesis, and clinician decision support. Enables multilingual support across Singapore's 4 official languages
- **SEA-Guard** — IMDA's safety model providing input/output guardrails on every agent interaction
- **Azure OpenAI (ChatGPT)** — used only for the Clinical Reasoning Agent (A2) for complex medical reasoning, as a substitute for Med-SEAL V1 (`med-r1`, a fine-tuned Qwen3-VL-8B clinical model) pending GPU infrastructure

## Architecture & Implementation

```
Patient App (React Native) ←→ AI Service (FastAPI/LangGraph) ←→ Medplum FHIR R4 ←→ OpenEMR
                                     ↕                ↕
                              Azure OpenAI      SEA-LION API
                             (Clinical A2)    (A1/A3/A4/A5/CDS/Guard)
```

- **7 LangGraph agent graphs** compiled at startup with session checkpointing (SQLite)
- **13 REST API endpoints** — patient chat (sync + SSE streaming), doctor CDS, CDS Hooks, pre-visit summaries, system triggers
- **Deployed on Azure App Service** (Linux) with Docker containerisation
- **Patient portal** — React Native/Expo iOS app with FHIR-driven appointments, vitals, medications, Apple HealthKit sync, and Singpass SSO

## Impact

| Outcome | Target |
|---|---|
| Medication adherence (PDC) | ≥ 80% |
| Patient engagement | Daily proactive nudges in patient's language |
| Clinician pre-visit brief | Auto-generated ≥ 30 min before appointment |
| Clinical escalation latency | < 5 min from trigger to clinician alert |
| Languages supported | English, Chinese, Malay, Tamil |

Med-SEAL empowers patients to actively manage their chronic conditions between clinic visits, enables timely clinician intervention through automated escalation, and elevates healthcare delivery through FHIR-native, standards-compliant AI — aligned with Singapore's HealthierSG and Smart Nation vision.

**Docs:** [igoyai.github.io/Med-SEAL-docs](https://igoyai.github.io/Med-SEAL-docs/) · **Source:** [github.com/IgoyAI/Med-SEAL-Suite](https://github.com/IgoyAI/Med-SEAL-Suite) · [github.com/IgoyAI/Med-SEAL-Patient-Portal](https://github.com/IgoyAI/Med-SEAL-Patient-Portal)
