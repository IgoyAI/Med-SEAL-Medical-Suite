# Contributing to Med-SEAL Medical Suite

Thank you for your interest in contributing to Med-SEAL Medical Suite. This project is a research collaboration between NUS, Synapxe, and IMDA.

## Development Setup

### Prerequisites

- Docker 24+ and Docker Compose v2
- Node.js 20 LTS
- Python 3.11+ (for Med-SEAL Agent)
- Git 2.30+

### Local Environment

```bash
# Clone
git clone https://github.com/IgoyAI/Med-SEAL-Medical-Suite.git
cd Med-SEAL-Medical-Suite

# Configure environment
cp .env.example .env
# Edit .env with your values

# Start services
docker compose up -d
```

## Code Standards

### General

- Write clear, self-documenting code
- Follow existing patterns in the codebase
- Keep commits focused and atomic

### JavaScript / TypeScript

- ES modules (`import`/`export`)
- Strict TypeScript where applicable
- Carbon Design System components for UI

### Python

- Type hints for function signatures
- Follow PEP 8 conventions
- Use virtual environments for local development

### Healthcare Data

- All patient data access must use FHIR R4 resources via Medplum
- Never store PHI (Protected Health Information) in logs or error messages
- Audit trail required for all clinical data operations

## Branch Strategy

| Branch | Purpose |
|--------|---------|
| `main` | Production-ready releases |
| `develop` | Integration branch |
| `feature/*` | New features |
| `fix/*` | Bug fixes |
| `release/*` | Release preparation |

## Pull Request Process

1. Create a feature branch from `develop`
2. Make your changes with clear commit messages
3. Ensure all services start cleanly (`docker compose up -d`)
4. Run any relevant tests
5. Open a PR against `develop` with:
   - Clear description of changes
   - Screenshots for UI changes
   - Test evidence
6. Obtain at least one review approval

## Commit Messages

Follow [Conventional Commits](https://www.conventionalcommits.org/):

```
feat: add medication interaction checker to CDSS
fix: resolve SSE timeout on long clinical queries
docs: update API reference for /api/chat endpoint
chore: upgrade Medplum server to v5.1.7
```

## Reporting Issues

Use [GitHub Issues](https://github.com/IgoyAI/Med-SEAL-Medical-Suite/issues) for bug reports and feature requests.

For security vulnerabilities, see [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contributions will be subject to the project's [license terms](LICENSE).
