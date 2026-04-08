<p align="center">
  <h1 align="center">🩺 Med-SEAL</h1>
  <p align="center"><strong>Medical — Safe Empowerment through AI-assisted Living</strong></p>
  <p align="center">
    An agentic AI platform for chronic disease patient empowerment in Singapore & Southeast Asia
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Python-3.11+-blue?logo=python" alt="Python">
  <img src="https://img.shields.io/badge/FastAPI-0.115+-green?logo=fastapi" alt="FastAPI">
  <img src="https://img.shields.io/badge/LangGraph-Multi--Agent-purple?logo=langchain" alt="LangGraph">
  <img src="https://img.shields.io/badge/FHIR-R4-red?logo=data:image/svg+xml;base64," alt="FHIR R4">
  <img src="https://img.shields.io/badge/SEA--LION-v4--32B-orange" alt="SEA-LION">
</p>

---

## What is Med-SEAL?

Med-SEAL is an **AI-powered health assistant** that helps patients manage chronic conditions (diabetes, hypertension, hyperlipidemia) **between clinic visits**. It provides:

- 🗣️ **Empathetic multilingual chat** in English, Chinese, Malay & Tamil
- 📋 **Health record access** — explains conditions, medications & lab results in plain language
- 📅 **Appointment management** — search, book, cancel & reschedule appointments
- 💊 **Medication reminders** — proactive nudges for missed doses
- ⚠️ **Clinical escalation** — alerts clinicians when biometrics exceed safe thresholds
- 🩺 **Pre-visit summaries** — auto-generated briefs for doctors before appointments
- 🥗 **Lifestyle coaching** — culturally-aware dietary advice (hawker food, festive meals)

Built on **IMDA's National LLM SEA-LION** and interoperable **HL7 FHIR R4** healthcare standards.

---

## Architecture

```
Patient App (React Native)  ←→  AI Service (FastAPI + LangGraph)  ←→  Medplum FHIR R4
                                         ↕              ↕
                                   Azure OpenAI    SEA-LION API
                                  (Clinical A2)  (A1/A3/A4/A5/CDS/Guard)
```

### Multi-Agent System

Med-SEAL deploys **7 specialized AI agents** orchestrated by a safety-guarded system:

| Agent | ID | Role | Model |
|-------|----|------|-------|
| **Companion** (A1) | `companion-agent` | Patient-facing chat hub — routes, delegates, and delivers all responses | SEA-LION v4-32B |
| **Clinical Reasoning** (A2) | `clinical-reasoning-agent` | Evidence-based medical Q&A grounded in patient EHR data | Azure OpenAI GPT-5.3 |
| **Nudge** (A3) | `nudge-agent` | Proactive medication reminders, biometric alerts, engagement nudges | SEA-LION v4-32B |
| **Lifestyle** (A4) | `lifestyle-agent` | Culturally-appropriate dietary & exercise coaching | SEA-LION v4-32B |
| **Insight Synthesis** (A5) | `insight-synthesis-agent` | Pre-visit clinical briefs for clinicians | SEA-LION v4-32B |
| **Doctor CDS** | `doctor-cds-agent` | Clinician-facing decision support within OpenEMR | SEA-LION v4-32B |
| **Pre-Visit Summary** | `previsit-summary-agent` | 11-section patient data aggregation from FHIR (no LLM) | Pure FHIR |

### How Requests Flow

```
1. Patient sends message
2. Input Guard screens for: prompt injection, toxicity, PII, crisis, emergencies
3. Orchestrator classifies intent via regex rules
4. Request routed to appropriate agent (usually Companion)
5. Agent fetches FHIR data, searches medical sources, generates response
6. If needed, Companion delegates to Clinical (A2) or Lifestyle (A4)
7. Output Guard screens for: clinical harm, identity leaks, hallucinations
8. Safe response returned to patient
```

### Safety: Dual-Layer Guard

Every input and output passes through a **two-layer safety system**:

| Layer | What it catches |
|-------|----------------|
| **Rule-based** (regex) | Prompt injection (21 patterns), PII (NRIC, phone, email, credit cards), crisis keywords, identity manipulation, clinical harm, toxicity |
| **SEA-Guard LLM** (IMDA) | Novel threats missed by rules — toxicity, harmful content, unsafe outputs |

The guard is **surface-aware**: clinicians on OpenEMR can discuss dosages and diagnoses freely; patients are fully protected.

---

## Quick Start

### Prerequisites

- Python 3.11+
- Access to [SEA-LION API](https://sea-lion.ai) (powers 5 agents + guard)
- Access to Azure OpenAI (powers Clinical agent A2)
- A Medplum FHIR R4 server (patient data)

### 1. Install

```bash
cd Med-SEAL
pip install -r requirements.txt -r agent/requirements_agent.txt
```

### 2. Configure

Set environment variables (or create a `.env` file):

```bash
# SEA-LION (required — powers most agents)
export MEDSEAL_SEALION_API_KEY="your-sealion-key"

# Azure OpenAI (required — powers Clinical agent)
export MEDSEAL_AZURE_OPENAI_ENDPOINT="https://your-endpoint.cognitiveservices.azure.com/"
export MEDSEAL_AZURE_OPENAI_API_KEY="your-azure-key"
export MEDSEAL_AZURE_OPENAI_DEPLOYMENT="gpt-4o"

# Medplum FHIR (required — patient data)
export MEDSEAL_MEDPLUM_URL="https://your-fhir-server/fhir/R4"
export MEDSEAL_MEDPLUM_EMAIL="admin@example.com"
export MEDSEAL_MEDPLUM_PASSWORD="password"
```

All configuration lives in [`agent/config.py`](agent/config.py) with sensible defaults.

### 3. Run

```bash
uvicorn agent.main:app --host 0.0.0.0 --port 8000
```

Open **http://localhost:8000/docs** for the interactive Swagger UI.

### 4. Deploy (Docker)

```bash
docker build -t medseal-agent .
docker run -p 8000:8000 \
  -e MEDSEAL_SEALION_API_KEY=xxx \
  -e MEDSEAL_AZURE_OPENAI_API_KEY=xxx \
  medseal-agent
```

---

## API Endpoints

### Patient App Surface

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/sessions` | Create a new chat session |
| `POST` | `/sessions/{id}/messages` | Send a message (synchronous) |
| `POST` | `/sessions/{id}/messages/stream` | Send a message (SSE streaming) |
| `GET` | `/sessions/{id}/messages` | Get conversation history |
| `DELETE` | `/sessions/{id}` | Delete a session |
| `POST` | `/patients/{id}/previsit-summary` | Generate pre-visit summary |

### OpenEMR / Clinician Surface

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/openemr/sessions/{id}/chat` | Doctor CDS chat (SSE streaming) |
| `POST` | `/openemr/sessions/{id}/chat/sync` | Doctor CDS chat (synchronous) |
| `POST` | `/cds-services/patient-view` | CDS Hooks — triggers Insight Synthesis |

### System & Admin

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/triggers/{type}` | Fire system triggers (nudge, measurement, etc.) |
| `GET` | `/agents` | List registered agents |
| `GET` | `/agents/{id}/health` | Agent health check |
| `GET` | `/health` | System health (LLM, FHIR, checkpointer) |

### Example: Send a Message

```bash
# Create session
SESSION=$(curl -s -X POST http://localhost:8000/sessions | jq -r .session_id)

# Send message
curl -X POST "http://localhost:8000/sessions/$SESSION/messages" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "What medications am I taking?",
    "patient_id": "patient-123"
  }'
```

---

## Project Structure

```
Med-SEAL/
├── agent/
│   ├── main.py                 # FastAPI app entry point
│   ├── config.py               # Pydantic settings (env vars)
│   ├── agents/                 # Individual agent implementations
│   │   ├── companion.py        #   A1: Patient chat hub (1,900 lines)
│   │   ├── clinical.py         #   A2: Clinical reasoning
│   │   ├── nudge.py            #   A3: Proactive reminders
│   │   ├── lifestyle.py        #   A4: Diet & exercise coaching
│   │   ├── insight.py          #   A5: Pre-visit briefs
│   │   ├── doctor_cds.py       #   Doctor decision support
│   │   ├── previsit.py         #   Pre-visit summary (FHIR-only)
│   │   └── measurement.py      #   Measurement scheduling
│   ├── core/                   # Shared infrastructure
│   │   ├── orchestrator.py     #   Intent classification & routing
│   │   ├── guard.py            #   Input/output safety layer
│   │   ├── identity.py         #   Agent persona & disclaimers
│   │   ├── graph.py            #   Legacy single-agent graph
│   │   ├── llm_factory.py      #   vLLM / Azure LLM factory
│   │   ├── router.py           #   Task type classifier
│   │   └── language.py         #   10-language SEA detection
│   ├── tools/                  # FHIR & search tool modules
│   │   ├── fhir_client.py      #   Medplum HTTP client
│   │   ├── fhir_tools_*.py     #   Per-agent FHIR tools (9 modules)
│   │   └── medical_tools.py    #   Web search (WebMD, Mayo Clinic, etc.)
│   └── api/
│       └── routes.py           # 13 REST API endpoints
├── Dockerfile                  # Docker deployment
├── startup.sh                  # Azure App Service startup
├── requirements.txt            # Runtime dependencies
└── medseal-agent-specification.md  # Full engineering spec
```

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| **Rule-based routing** (not LLM routing) | Deterministic, fast (~0ms), no hallucination risk in routing |
| **Dual safety layer** (regex + SEA-Guard) | Rules catch known patterns instantly; LLM catches novel threats |
| **Surface-aware guard** | Clinicians discuss dosages freely; patients are fully protected |
| **Companion as hub** | All patient interactions funnel through A1 for consistent tone |
| **FHIR-native data** | HL7 FHIR R4 enables interoperability with any hospital system |
| **Graceful degradation** | SQLite → in-memory fallback; Azure → vLLM fallback |
| **Per-agent temperatures** | Clinical (0.3) for precision; Companion (0.7) for warmth |

---

## Supported Languages

| Language | Code | SEA-LION | Guard | Emergency Numbers |
|----------|------|----------|-------|-------------------|
| English | `en` | ✅ | ✅ | 995 (SG) |
| 中文 (Mandarin) | `zh` | ✅ | ✅ | 995 (SG) |
| Bahasa Melayu | `ms` | ✅ | ✅ | 995 (SG) |
| தமிழ் (Tamil) | `ta` | ✅ | ✅ | 995 (SG) |
| Bahasa Indonesia | `id` | ✅ | ✅ | 119 ext 8 |
| + 5 more SEA languages | — | ✅ | — | — |

---

## Links

- 📖 **Documentation**: [igoyai.github.io/Med-SEAL-docs](https://igoyai.github.io/Med-SEAL-docs/)
- 💻 **Agent Source**: [github.com/IgoyAI/Med-SEAL-Suite](https://github.com/IgoyAI/Med-SEAL-Suite)
- 📱 **Patient Portal**: [github.com/IgoyAI/Med-SEAL-Patient-Portal](https://github.com/IgoyAI/Med-SEAL-Patient-Portal)

---

<p align="center">
  Built at the <strong>National University of Singapore</strong> · Powered by <strong>IMDA SEA-LION</strong> · Aligned with <strong>HealthierSG</strong> & <strong>Smart Nation</strong>
</p>
