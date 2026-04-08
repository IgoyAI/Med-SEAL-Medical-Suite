# Changelog

All notable changes to Med-SEAL Medical Suite are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [2.1.0] - 2026-04-09

### Added

- **Med-SEAL Agent** — 7 specialized AI agents (Companion, Clinical Reasoning, Nudge, Lifestyle, Insight Synthesis, Doctor CDS, Pre-Visit Summary) powered by SEA-LION v4-32B, Med-SEAL V1, and Qwen 3.6 Plus
- **CDSS** — Clinical Decision Support System with real-time alerts and recommendations
- **SSO-v2** — Single Sign-On frontend with 2FA (TOTP), Singpass integration, and Carbon Design System UI
- **AI Service** — Express.js backend providing clinical chat, CDS alerts, ambient summaries, and audit logging
- **AI Frontend (ClinOS)** — Clinician dashboard built with React 18 and Carbon Design System
- **Medplum FHIR R4** — Full HL7 FHIR R4 server integration for interoperable health data exchange
- **Nginx Gateway** — TLS-terminating reverse proxy with domain routing for all services
- **Data synchronization** — Bi-directional sync between OpenEMR, Medplum FHIR, and SSO databases
- **Huawei Cloud CCE** — Kubernetes deployment scripts for production (ap-southeast-1 Singapore)
- **Dual-layer AI safety** — Rule-based input guards (21 regex patterns) + SEA-Guard LLM for novel threat detection
- **Multi-language support** — English, Chinese, Malay, Tamil across patient-facing agents
- **Docker Compose orchestration** — 10+ containers with health checks and dependency management
- **Synthea data seeding** — Scripts for generating and loading realistic patient data
- **Environment variable security** — All secrets injected via environment, no hardcoded credentials

### Standards

- HL7 FHIR R4 healthcare data interoperability
- SGDS (Singapore Government Design System) compliance
- WCAG 2.1 AA web accessibility
- DSS (Digital Service Standards) compliance
- USCDI v3 support

## [1.0.0] - 2026-03-23

### Added

- Initial OpenEMR integration with custom modules
- Docker Compose base infrastructure
- Gateway configuration with TLS
- OpenEMR custom chat widget and theme

---

[2.1.0]: https://github.com/IgoyAI/Med-SEAL-Medical-Suite/releases/tag/v2.1.0
[1.0.0]: https://github.com/IgoyAI/Med-SEAL-Medical-Suite/releases/tag/v1.0.0
