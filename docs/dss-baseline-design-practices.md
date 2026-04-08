# DSS Baseline Design Practices (BD)

> **Source:** [Singapore Government Digital Service Standards — Control Catalog](https://info.standards.tech.gov.sg/control-catalog/dss/bd/)
> **Last Updated:** 23 Feb 2026

Controls based on foundational design principles for Singapore Government digital services.

---

## BD-1: Responsive Web Design

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Adopt responsive design for web services; disable mobile access only when content is unsuitable, with clear explanation. |
| **Recommendations** | Implement responsive techniques for various devices; test and resolve layout/functionality issues across screen sizes. |
| **Rationale** | Mobile traffic is significant; responsive design optimizes browsing across screen sizes. |

---

## BD-2: Site Search

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Provide a search function for multi-page websites. |
| **Recommendations** | Implement accessible search (e.g., SearchSG); review search analytics regularly to improve results. |
| **Exceptions** | Mobile apps, transactional services, services where search is the primary offering. |
| **Rationale** | Search is a known and effective alternative to navigation. |

---

## BD-3: Support Multiple Languages

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Provide content in multiple languages to accommodate user preferences. |
| **Recommendations** | Enable language selection at entry points; allow easy switching between languages. |
| **Rationale** | Language selection enhances usability and inclusivity. |

---

## BD-4: Clear and Concise Content

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Write clearly using simple, understandable language. |
| **Recommendations** | Conduct user testing; use readability formulas (e.g., Flesch Reading Ease, Flesch-Kincaid) to evaluate content clarity. |
| **Rationale** | Simplicity enables broader understanding across diverse backgrounds. |

---

## BD-5: Search Engine Optimisation

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Implement SEO best practices to improve search rankings. |
| **Recommendations** | Optimise metadata, meta tags, page titles, and abstracts. |
| **Exceptions** | Restricted-audience services, experimental/beta services. |
| **Rationale** | SEO increases findability and reach of web content. |

---

## BD-6: Consistent UI Design

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Use a design system or style guide for consistency across the service. |
| **Recommendations** | Use the Singapore Government Design System (SGDS). |
| **Rationale** | Consistency improves usability; design systems enable scalability. |

---

## BD-7: Mandatory and Optional Fields

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Clearly indicate if input fields are mandatory or optional. |
| **Recommendations** | Use consistent visual indicators (e.g., asterisks for mandatory fields); ensure these indicators are accessible. |
| **Exceptions** | Login pages requesting only username and password. |
| **Rationale** | Reduces form completion time; increases completion rates. |

---

## BD-8: Log-in Indication

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Display user name or identifier prominently after login. |
| **Recommendations** | Display in header or top-of-page location, clearly accessible to the user. |
| **Rationale** | Confirms logged-in status; especially important on shared devices. |

---

## BD-9: Contact Channels

| Field | Detail |
|-------|--------|
| **Group** | Baseline Design Practices |
| **Statement** | Provide at least one contact channel for help or assistance. |
| **Recommendations** | Implement phone, email, contact forms, or live chat. |
| **Related Controls** | TL-4, WU-9 |
| **Rationale** | Enables user support; reassures users with a clear assistance method. |

---

## Summary Table

| Control | Title | Key Requirement |
|---------|-------|-----------------|
| BD-1 | Responsive Web Design | Responsive design for all web services |
| BD-2 | Site Search | Search function for multi-page sites |
| BD-3 | Support Multiple Languages | Multi-language content support |
| BD-4 | Clear and Concise Content | Simple, understandable language |
| BD-5 | Search Engine Optimisation | SEO best practices |
| BD-6 | Consistent UI Design | Design system / style guide usage |
| BD-7 | Mandatory and Optional Fields | Clear field requirement indicators |
| BD-8 | Log-in Indication | Visible logged-in status |
| BD-9 | Contact Channels | At least one help/contact channel |
