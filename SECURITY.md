# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 2.1.x   | Yes       |
| < 2.0   | No        |

## Reporting a Vulnerability

If you discover a security vulnerability in Med-SEAL Medical Suite, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

### Contact

Email: **security@med-seal.org**

Please include:
- Description of the vulnerability
- Steps to reproduce
- Potential impact assessment
- Suggested fix (if any)

### Response Timeline

| Stage | Target |
|-------|--------|
| Acknowledgement | 48 hours |
| Initial assessment | 5 business days |
| Fix development | 15 business days |
| Public disclosure | After fix is deployed |

## Security Architecture

### Authentication & Authorization

- **Singpass** — Singapore National Digital Identity integration for patient authentication
- **2FA (TOTP)** — Time-based one-time passwords for clinician accounts
- **Bcrypt** — Password hashing with configurable work factor
- **SSO** — Centralized single sign-on across all platform services
- **RBAC** — Role-based access control (patient, clinician, admin)

### Data Protection

- **TLS 1.2+** — All external traffic encrypted via Nginx gateway
- **Environment injection** — No secrets stored in source code; all credentials via environment variables
- **Database isolation** — Separate databases for clinical (MariaDB), FHIR (PostgreSQL), and SSO (PostgreSQL) data
- **Audit logging** — All clinical data access logged with user, timestamp, and action

### AI Safety

- **Input guard** — 21 regex patterns detecting prompt injection, PII exposure, and toxicity
- **SEA-Guard LLM** — Secondary AI model for novel threat detection
- **Surface-aware filtering** — Clinician responses unrestricted; patient responses subject to full safety pipeline
- **No training on patient data** — LLM providers do not retain or train on transmitted data

### Network Security

- **Nginx reverse proxy** — All services behind TLS-terminating gateway
- **Internal-only services** — Databases and internal APIs not exposed to public internet
- **Docker network isolation** — Services communicate over private bridge network
- **Cloudflare** — DNS and CDN with DDoS protection

### Compliance

- **HL7 FHIR R4** — Standardized healthcare data format
- **SGDS** — Singapore Government Design System
- **WCAG 2.1 AA** — Accessibility compliance
- **DSS** — Digital Service Standards (Singapore)

## Dependency Management

- Container images pinned to specific versions
- Node.js dependencies locked via `package-lock.json`
- Python dependencies managed via `requirements.txt`
- Regular dependency audits recommended (`npm audit`, `pip-audit`)
