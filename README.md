# Med-SEAL Medical Suite

**Singapore's Enterprise Healthcare Platform — SSO, Backend Systems, ClinOS & CDSS**

Med-SEAL Medical Suite is a comprehensive healthcare platform integrating clinical systems, AI-powered decision support, and interoperable health data exchange built on FHIR R4. Designed for Singapore's healthcare ecosystem in compliance with SGDS (Singapore Government Design System) and DSS standards.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                      Nginx Gateway (TLS)                        │
├──────────┬──────────┬──────────┬──────────┬─────────────────────┤
│ OpenEMR  │ Medplum  │ OHIF     │ Orthanc  │ Med-SEAL Agent      │
│ (EMR)    │ (FHIR R4)│ (DICOM)  │ (PACS)   │ (Multi-Agent AI)    │
├──────────┼──────────┴──────────┴──────────┼─────────────────────┤
│ AI       │ SSO-v2                         │ CDSS                │
│ Service  │ (Carbon Design + React)        │ (Clinical Decision  │
│ (LLM API)│                                │  Support System)    │
├──────────┴────────────────────────────────┴─────────────────────┤
│ PostgreSQL │ MariaDB │ Redis │ Docker Compose Orchestration      │
└─────────────────────────────────────────────────────────────────┘
```

## Components

### Core Clinical Systems

| Component | Path | Description |
|-----------|------|-------------|
| **OpenEMR** | `openemr/`, `apps/openemr/` | Electronic Medical Records — patient demographics, encounters, prescriptions |
| **Medplum FHIR** | `medplum/` | HL7 FHIR R4 server — interoperable health data exchange |
| **Orthanc** | `orthanc/` | DICOM/PACS server — medical imaging storage |
| **OHIF Viewer** | `ohif/` | Radiology DICOM viewer — web-based imaging |

### AI & Decision Support

| Component | Path | Description |
|-----------|------|-------------|
| **Med-SEAL Agent** | `Med-SEAL-Agent/` | Multi-agent AI system (LangGraph + SEA-LION/Azure OpenAI) — 7 specialized agents |
| **AI Service** | `apps/ai-service/` | Express.js backend — clinical chat, radiology reports, CDS alerts, ambient summaries |
| **CDSS** | `apps/cdss/` | Clinical Decision Support System |
| **AI Frontend** | `apps/ai-frontend/` | Clinician dashboard (React + Carbon Design System) |

### Authentication & Identity

| Component | Path | Description |
|-----------|------|-------------|
| **SSO-v2** | `sso-v2/` | Single Sign-On frontend (Vite + React + Carbon Design) |
| **Auth Module** | `apps/ai-service/src/` | 2FA (TOTP), SSO auto-login, bcrypt password management |

### Infrastructure

| Component | Path | Description |
|-----------|------|-------------|
| **Gateway** | `gateway/` | Nginx reverse proxy — TLS termination, routing |
| **Docker Compose** | `docker-compose.yml` | Full stack orchestration — 13+ containers |
| **Scripts** | `scripts/` | Data seeding, Synthea patient generation, FHIR sync |
| **Huawei Cloud** | `huawei/` | Cloud deployment configs |

## AI Agents (Med-SEAL Agent)

```
├── Companion Agent (A1)     — Patient chat hub & router
├── Clinical Reasoning (A2)  — Evidence-based Q&A
├── Nudge Agent (A3)         — Medication reminders & alerts
├── Lifestyle Agent (A4)     — Cultural dietary coaching
├── Insight Synthesis (A5)   — Pre-visit summaries
├── Doctor CDS Agent         — Clinician decision support
└── Pre-Visit Summary Agent  — Pure FHIR aggregation

Safety Guards:
├── Rule-based (regex)       — Prompt injection, PII, toxicity
└── SEA-Guard LLM            — Novel threat detection
```

## Tech Stack

| Layer | Technologies |
|-------|--------------|
| **Backend** | Express.js, Node.js 20, FastAPI, Python 3.11+ |
| **Frontend** | React 18, Vite 5, Carbon Design System (IBM) |
| **Database** | PostgreSQL 16, MariaDB 10.11, Redis 7 |
| **FHIR** | Medplum R4 Server (v5.1.6) |
| **DICOM** | Orthanc + OHIF Viewer v3.9.2 |
| **AI/LLM** | SEA-LION v4-32B, Azure OpenAI, Google Gemini 2.5 Flash |
| **Orchestration** | Docker Compose, Nginx, LangGraph |
| **Auth** | 2FA (TOTP), SSO, Bcrypt, Singpass |
| **Standards** | HL7 FHIR R4, SGDS, WCAG 2.1 AA, DSS |

## Quick Start

```bash
# Clone
git clone https://github.com/IgoyAI/Med-SEAL-Medical-Suite.git
cd Med-SEAL-Medical-Suite

# Start all services
docker-compose up -d

# Services available at:
# OpenEMR:      http://localhost:8081
# Medplum:      http://localhost:3000
# AI Frontend:  http://localhost:3001
# AI Service:   http://localhost:4003
# OHIF Viewer:  http://localhost:3003
# Orthanc:      http://localhost:8042
```

## FHIR Endpoints

| Endpoint | URL |
|----------|-----|
| FHIR R4 Base | `https://fhir.med-seal.org/fhir/R4` |
| API Gateway | `https://api.med-seal.org` |
| Agent API | `http://119.13.90.82:8000` |

## Related Repositories

| Repository | Description |
|-----------|-------------|
| [Med-SEAL-Suite](https://github.com/IgoyAI/Med-SEAL-Suite) | Full monorepo including patient portals |
| [Med-SEAL-docs](https://github.com/IgoyAI/Med-SEAL-docs) | Documentation site |

## Standards Compliance

- **HL7 FHIR R4** — Healthcare data interoperability
- **SGDS** — Singapore Government Design System
- **WCAG 2.1 AA** — Web accessibility
- **DSS** — Digital Service Standards (Singapore)
- **USCDI v3** — US Core Data for Interoperability

## License

This project is part of the Med-SEAL research initiative by NUS, Synapxe, and IMDA.
