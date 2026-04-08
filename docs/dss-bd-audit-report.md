# DSS Baseline Design Practices — Audit Report

> **Subject:** Med-SEAL Suite
> **Standard:** [Singapore DSS Baseline Design Practices (BD)](https://info.standards.tech.gov.sg/control-catalog/dss/bd/)
> **Date:** 5 Apr 2026
> **Scope:** ai-frontend, patient-portal (web), patient-portal-native, sso-v2

---

## Executive Summary

| Control | Title | Verdict | Notes |
|---------|-------|---------|-------|
| BD-1 | Responsive Web Design | PARTIAL | Patient-portal strong; ai-frontend and sso-v2 have gaps |
| BD-2 | Site Search | NON-COMPLIANT | No site-wide search in any app |
| BD-3 | Support Multiple Languages | NON-COMPLIANT | Language selector exists only in chat; ~95% of UI is English-only |
| BD-4 | Clear and Concise Content | PARTIAL | Patient-portal good; admin apps use heavy technical jargon |
| BD-5 | Search Engine Optimisation | NOT APPLICABLE | All apps are login-gated (BD-5 exception for restricted-audience services) |
| BD-6 | Consistent UI Design | PARTIAL | 3 different design systems across 4 apps; no shared component library |
| BD-7 | Mandatory and Optional Fields | NON-COMPLIANT | No required indicators, no asterisks, no `aria-required` on any form |
| BD-8 | Log-in Indication | COMPLIANT | All apps display user name/role prominently after login |
| BD-9 | Contact Channels | PARTIAL | Admin apps have email link; patient-portal apps have zero human contact channels |

---

## BD-1: Responsive Web Design

**Requirement:** Adopt responsive design for web services.

### patient-portal (Next.js) — COMPLIANT

- Viewport meta via Next.js `Viewport` export (`app/layout.tsx:25-31`)
- Tailwind CSS v4 with mobile-first utility classes throughout
- Mobile-optimised 430px app frame with breakpoint adaptation (`app/globals.css:69-87`)
- Safe-area insets for notched devices (`app/globals.css:124,129`)
- Dynamic viewport height (`min-h-dvh`) instead of `100vh`
- Flexible grid layouts (`grid-cols-2`, `grid-cols-4`, `max-w-lg`)

### ai-frontend (React+Vite) — PARTIAL

- Viewport meta tag present (`index.html:6`)
- Fluid grid: `repeat(auto-fill, minmax(205px, 1fr))` (`src/index.css:340`)
- Only one breakpoint at 768px (`src/index.css:1855`) — no tablet breakpoint
- Sidebar is binary show/hide — no progressive enhancement
- Some fixed widths (`--sidebar-w: 232px`) though modals use `max-width`
- No safe-area support

### sso-v2 (React+Vite + Carbon) — PARTIAL

- Viewport meta tag present (`index.html:6`)
- IBM Carbon Grid system with responsive `<Grid narrow>` components
- Two breakpoints: 1056px and 768px (`src/app.scss:884,894`)
- Desktop-first layout: 256px fixed sidebar not hidden until 768px — tablets are cramped
- No safe-area support

### Gaps to Close

1. **ai-frontend:** Add tablet breakpoint (~1024px); adopt progressive sidebar collapse
2. **sso-v2:** Collapse sidebar at 1056px (not just 768px) for tablet-friendly layout
3. Both apps: Add `env(safe-area-inset-*)` for notched devices

---

## BD-2: Site Search

**Requirement:** Provide search function for multi-page websites.
**Exceptions:** Mobile apps, transactional services, services where search is the primary offering.

### Findings

| App | Search Exists? | Scope |
|-----|---------------|-------|
| ai-frontend | Audit log filter only | Single-table filter, not site search |
| patient-portal | None | Zero search on 10+ routes |
| patient-portal-native | N/A | Exempt (mobile app) |
| sso-v2 | Table toolbar filter | Carbon `TableToolbarSearch` on data tables only |

**No app implements site-wide search.** The patient-portal is the most critical gap — it has 10+ pages (records, medications, appointments, analytics, lifestyle, wearables, chat, check-in, insights, dashboard) with no way to search across content.

### Recommendation

- Add a global search bar to the patient-portal header/navigation
- Index searchable content: medications, appointment details, health records, lab results
- Consider SearchSG integration if publicly accessible pages are added

---

## BD-3: Support Multiple Languages

**Requirement:** Provide content in multiple languages; enable language selection at entry points; allow easy switching.

### Findings

| App | i18n Library | Language Selector | Coverage |
|-----|-------------|-------------------|----------|
| patient-portal | None | Chat page only | ~5% |
| patient-portal-native | None | Chat page only | ~5% |
| ai-frontend | None | None | 0% |
| sso-v2 | None | None | 0% |

**Language selector implementation (chat pages only):**
- patient-portal: `app/chat/page.tsx:18-23` — EN, ZH, MS, TA dropdown
- patient-portal-native: `app/(tabs)/chat.tsx:118-123` — EN, ZH, MS, TA modal

**Critical gaps:**
1. All `<html lang>` attributes hardcoded to `"en"` — never updated dynamically
2. No i18n framework (no react-intl, i18next, or next-intl)
3. No translation files or locale directories anywhere
4. ~95% of UI strings are hardcoded English (login, dashboard, records, appointments, profile, all nav labels)
5. Language preference not persisted (resets on page reload)
6. FHIR `Patient.communication` (preferred language) not connected to frontend

### Recommendation

1. Adopt an i18n framework (e.g., `next-intl` for patient-portal, `react-i18next` for others)
2. Extract all UI strings to translation files for EN, ZH, MS, TA
3. Add language selector to app entry point (login page or global header)
4. Persist language preference to user profile / `localStorage`
5. Update `<html lang>` dynamically based on selection

---

## BD-4: Clear and Concise Content

**Requirement:** Write clearly using simple, understandable language.

### patient-portal — GOOD

Most patient-facing copy is clear: "Good morning", "Next Appointment", "Today's Medications", "Latest Vitals", "AI Health Assistant".

**Issues:**
- Medical units used without plain-language context: `mmol/L`, `bpm`, `mmHg`, `HbA1c` (`app/chat/page.tsx:45`, `app/wearables/page.tsx:29`)
- "NRIC" acronym unexplained on login page (`app/login/page.tsx:80`)
- "Complete Blood Count", "Fasting Glucose" used without tooltips or explanations

### ai-frontend — POOR

Heavy technical jargon aimed at clinicians but still unclear:
- `src/services.ts:67` — "FHIR R4 server — interoperable patient data, resources, and API access"
- `src/pages/LoginPage.tsx:113` — "One secure login for OpenEMR, Medplum FHIR, Orthanc PACS, and OHIF Viewer"
- `src/pages/LoginPage.tsx:120-128` — "TOTP-based Two-Factor Authentication", "Bcrypt password hashing", "Role & tag-based access control (RBAC)"

### sso-v2 — POOR

Same technical jargon as ai-frontend (shared login page copy):
- `src/pages/LoginPage.jsx:113-128` — identical FHIR/PACS/TOTP/RBAC copy

### Recommendation

1. Add plain-language tooltips for medical units (e.g., "HbA1c (average blood sugar over 3 months)")
2. Spell out acronyms on first use: "NRIC (National Registration Identity Card)"
3. Rewrite admin login page security features in user-friendly language
4. Add contextual helper text for technical service names

---

## BD-5: Search Engine Optimisation

**Requirement:** Implement SEO best practices.
**Exceptions:** Restricted-audience services, experimental/beta services.

### Verdict: NOT APPLICABLE

All three web apps require authentication (login-gated):
- **patient-portal** — patient login (Singpass or hospital account)
- **ai-frontend** — clinician/staff authentication
- **sso-v2** — institutional access

This qualifies for the BD-5 exception for **restricted-audience services**.

**However, for completeness — current SEO status:**

| Element | patient-portal | ai-frontend | sso-v2 |
|---------|---------------|-------------|--------|
| Page title | Global only | Static | Static |
| Meta description | Global only | Static | Static |
| Per-route metadata | No | No (SPA) | No (SPA) |
| Semantic HTML (`<nav>`, `<main>`, `<article>`) | Partial | Poor | Best (Carbon) |
| robots.txt | Missing | Missing | Missing |
| sitemap.xml | Missing | Missing | Missing |
| Open Graph tags | Missing | Missing | Missing |
| Structured data | Missing | Missing | Missing |

**Note:** Even for restricted-audience apps, semantic HTML and ARIA attributes remain important for accessibility (covered under separate accessibility standards).

---

## BD-6: Consistent UI Design

**Requirement:** Use a design system or style guide for consistency.

### Findings

| App | Design System | Tokens/Theme |
|-----|--------------|--------------|
| patient-portal | Tailwind CSS v4 | Custom CSS properties: primary blue, teal accent, warm grays (`app/globals.css:1-100`) |
| patient-portal-native | Custom TypeScript tokens | Evidence-based theme: Open Sans, Atkinson Hyperlegible, Roboto Mono (`lib/theme.ts:1-225`) |
| ai-frontend | None (custom CSS) | Minimal custom styling (`src/index.css`) |
| sso-v2 | IBM Carbon Design System | Carbon g100 dark theme + healthcare overrides (`src/app.scss:12-23`) |

### Cross-App Inconsistencies

- **3 different design systems** across 4 apps (Tailwind, Carbon, custom CSS)
- **No shared component library** between web apps
- **Different icon libraries:** Lucide (patient-portal, ai-frontend) vs Carbon Icons (sso-v2)
- **Different colour palettes:** Primary blue `#4a6fa5` (patient-portal) vs Carbon blue `#4589ff` (sso-v2) vs unthemed (ai-frontend)
- **Different typography:** Source Sans 3 (patient-portal) vs Open Sans (native) vs system default (ai-frontend) vs IBM Plex (sso-v2)

### Recommendation

1. Adopt a single primary design system across web apps (Tailwind or SGDS)
2. Create shared design tokens (colours, spacing, typography) as a common package
3. At minimum, align the primary colour palette and icon library
4. Consider SGDS (Singapore Government Design System) for compliance bonus

---

## BD-7: Mandatory and Optional Fields

**Requirement:** Clearly indicate if input fields are mandatory or optional.
**Exceptions:** Login pages requesting only username/password.

### Findings

**Login forms (exempt per BD-7 exception):**
- ai-frontend: `src/pages/LoginPage.tsx:80-103` — username + password only (exempt)
- patient-portal: `app/login/page.tsx:75-101` — username + password only (exempt)
- sso-v2: `src/pages/LoginPage.jsx:144-161` — username + password only (exempt)

**Non-login forms (NOT compliant):**

| Form | Location | `required` attr | Asterisk | `aria-required` |
|------|----------|-----------------|----------|-----------------|
| Profile (patient-portal) | `app/profile/page.tsx:48-95` | No | No | No |
| Profile (sso-v2) | `src/pages/ProfilePage.jsx:172-191` | No | No | No |
| 2FA code input (ai-frontend) | `src/pages/LoginPage.tsx:139` | No | No | No |
| 2FA code input (sso-v2) | `src/pages/LoginPage.jsx:170` | No | No | No |
| Chat input (patient-portal) | `app/chat/page.tsx` | No | No | No |

**No form in any app uses:**
- Asterisks (*) for mandatory fields
- HTML5 `required` attribute (outside login exemption)
- `aria-required="true"` for accessibility
- Visual cues (bold labels, colour-coded borders)
- Form legends explaining required vs. optional

### Recommendation

1. Add `required` and `aria-required="true"` to all mandatory fields
2. Add asterisk (*) with legend text: "* Required field"
3. Use consistent visual indicator across all apps (e.g., asterisk + red border on validation failure)

---

## BD-8: Log-in Indication

**Requirement:** Display user name/identifier prominently after login.

### Verdict: COMPLIANT

| App | Display Location | What's Shown |
|-----|-----------------|--------------|
| ai-frontend | Top bar (`src/App.tsx:49-55`) | Avatar initials + display name + role badge |
| patient-portal | Dashboard header (`app/dashboard/page.tsx:36-39`) | "Good morning/afternoon, {firstName}" + profile icon |
| patient-portal-native | Home header (`app/(tabs)/index.tsx:119-121`) | "Welcome, {firstName}" + avatar button |
| sso-v2 | Header bar + notification panel (`src/App.jsx:139-144,157`) | Display name in aria-label + "Signed in as {name}" |

All apps show user identity prominently and immediately after authentication. No action needed.

---

## BD-9: Contact Channels

**Requirement:** Provide at least one contact channel for help/assistance.

### Findings

| App | Email | Phone | Human Chat | Contact Form | Help Page |
|-----|-------|-------|------------|--------------|-----------|
| ai-frontend | `support@medseal.io` | No | No | No | GitHub docs |
| patient-portal (web) | No | No | AI only | No | No |
| patient-portal-native | No | No | AI only | No | No |
| sso-v2 | `support@medseal.io` | No | No | No | GitHub docs |

**Critical gap:** The patient-facing apps (patient-portal, patient-portal-native) have **zero human contact channels**. The chat feature is AI-only — not a support channel.

### Recommendation

1. Add `support@medseal.io` email link or hospital helpline number to patient-portal bottom nav / profile page
2. Add emergency contact number (995 for Singapore) in a visible location
3. Consider adding a "Contact Support" option in the chat interface to escalate to human agents
4. Add hospital reception phone number on appointment pages

---

## Compliance Summary

```
BD-1  Responsive Web Design       ██████████░░  PARTIAL       (patient-portal strong; others need work)
BD-2  Site Search                  ██░░░░░░░░░░  NON-COMPLIANT (no site-wide search anywhere)
BD-3  Multiple Languages           █░░░░░░░░░░░  NON-COMPLIANT (chat only; 95% English-only)
BD-4  Clear and Concise Content    ██████░░░░░░  PARTIAL       (patient-portal good; admin apps poor)
BD-5  Search Engine Optimisation   ████████████  N/A           (all apps are login-gated)
BD-6  Consistent UI Design         ████░░░░░░░░  PARTIAL       (3 design systems, no shared tokens)
BD-7  Mandatory/Optional Fields    █░░░░░░░░░░░  NON-COMPLIANT (zero indicators on any form)
BD-8  Log-in Indication            ████████████  COMPLIANT     (all apps show user name + role)
BD-9  Contact Channels             ████░░░░░░░░  PARTIAL       (admin apps have email; patient apps have none)
```

### Priority Remediation

| Priority | Control | Effort | Impact |
|----------|---------|--------|--------|
| **P0** | BD-9 — Add contact channels to patient apps | Low | High (patient safety) |
| **P0** | BD-7 — Add required field indicators | Low | High (accessibility/usability) |
| **P1** | BD-3 — Implement i18n framework + translations | High | High (Singapore multi-ethnic population) |
| **P1** | BD-2 — Add site search to patient-portal | Medium | Medium |
| **P2** | BD-6 — Unify design system across web apps | High | Medium (consistency) |
| **P2** | BD-1 — Add tablet breakpoints to ai-frontend, sso-v2 | Low | Medium |
| **P3** | BD-4 — Add plain-language tooltips for medical terms | Low | Low |
