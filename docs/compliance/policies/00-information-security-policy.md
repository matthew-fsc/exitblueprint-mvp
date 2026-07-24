# Information Security Policy (Master)

| | |
| --- | --- |
| **Owner / Approver** | Matthew (matthew@fracturesystems.com) — Security Officer |
| **Version** | 1.0 |
| **Effective** | 2026-07-23 |
| **Review cadence** | At least annually and on material change |
| **Applies to** | All Exit Blueprint personnel, contractors, systems, and data |

This is the master policy for Exit Blueprint's information security program. It sets
the intent and the top-level rules; the sibling policies in this directory carry the
detail for each domain. Where this document and a sibling policy both speak to a
topic, the sibling policy governs the detail and this one governs the intent.

## 1. Purpose

Exit Blueprint handles confidential business and personal financial information
("client data", including non-public personal information / NPI) on behalf of M&A
advisory firms and their business-owner clients. This policy establishes the
management framework that protects the **confidentiality, integrity, and
availability** of that data and of the systems that process it, and demonstrates the
control environment expected of a SOC 2 (Security, Availability, Confidentiality)
service provider.

## 2. Scope

- **Systems:** the Exit Blueprint application (React SPA, the Node compute service in
  `server/`), its production database and storage (Supabase), identity (Clerk),
  compute/edge hosting (Render, Vercel), billing (Stripe), and the AI narrative
  service (Anthropic). See `docs/compliance/_facts-brief.md` and `docs/28-architecture-map.md`
  for the system boundary.
- **Data:** all client data, authentication data, and company operational data.
- **People:** all employees, founders, and contractors with access to company systems.
- **Out of scope for the initial SOC 2 report:** Processing Integrity and Privacy as
  formal Trust Services categories. Privacy obligations are met through the DPA /
  consent process (`docs/02-data-model.md`), not a SOC 2 Privacy assertion, in the
  first report.

## 3. Security principles (the standing rules)

1. **Least privilege, default deny.** Access is granted only as needed to perform a
   role. Cross-tenant access is denied by default and enforced in the database, not
   just the application — every domain table carries `firm_id` and is protected by
   Postgres Row-Level Security (**✅**, verified by `npm run test:rls`).
2. **Defense in depth.** Controls are layered: TLS in transit, AES-256-GCM at rest for
   documents, RLS for tenant isolation, signed short-expiry URLs for delivery,
   authentication + MFA at the edge, rate limiting, and audit logging.
3. **Secure by default in production.** The compute service **hard-fails at startup**
   in production if document-encryption or URL-signing keys are missing
   (`server/http.ts`) — real client data can never be protected by a development
   default.
4. **Data minimization and purpose limitation.** We collect only what the assessment
   methodology requires, and only after a signed engagement agreement and explicit
   data-use consent are recorded (**✅** consent gate).
5. **Integrity of the core product.** Scores are produced by deterministic, versioned
   code verified against a reference implementation; **no LLM ever computes or
   influences a score** (CLAUDE.md rule 1). Assessments are immutable snapshots.
6. **Honest posture.** Controls are represented truthfully. A control that is planned
   is marked 🟡 planned, never claimed as implemented. This program's credibility
   depends on the map matching the territory.

## 4. Governance & roles

Exit Blueprint is a small, cloud-native, remote team. Security responsibilities are
consolidated accordingly, with formal separation planned as the team grows (🟡).

| Role | Held by | Responsibility |
| --- | --- | --- |
| **Security Officer (CISO-equivalent)** | Matthew | Owns this program, approves policies, owns risk decisions, is the incident commander and the external security contact. |
| **Engineering** | All engineers | Build to the secure-development policy; review each other's changes; run the definition-of-done gate before merge. |
| **All personnel** | Everyone | Follow the acceptable-use policy, complete security-awareness training (🟡 formal program planned), and report suspected incidents immediately. |

A dedicated CISO role and a security/compliance committee are 🟡 planned as headcount
grows.

## 5. Policy framework (the sibling policies)

This program is implemented through the following policies. Each names the SOC 2
Common Criteria it primarily supports.

| # | Policy | Primary SOC 2 mapping |
| --- | --- | --- |
| 00 | Information Security Policy (this document) | CC1, CC2, CC5 |
| 01 | Access Control Policy | CC6.1–CC6.3 |
| 02 | Change Management Policy | CC8.1 |
| 03 | Secure Development Policy | CC8.1, CC7.1 |
| 04 | Incident Response Plan | CC7.3–CC7.5 |
| 05 | Business Continuity & Disaster Recovery Plan | A1.1–A1.3 |
| 06 | Vendor / Sub-processor Risk Management Policy | CC9.2 |
| 07 | Risk Assessment Policy | CC3.1–CC3.4 |
| 08 | Data Classification & Handling Policy | CC6.1, CC6.7, C1.1 |
| 09 | Data Retention & Disposal Policy | C1.2, CC6.5 |
| 11 | Logging & Monitoring Policy | CC7.2–CC7.3 |
| 12 | Backup Policy | A1.2 |
| 13 | Acceptable Use Policy | CC1.1, CC6.7 |
| 14 | Human Resources Security Policy | CC1.1, CC1.4, CC6.2 |
| 15 | Vulnerability Management Policy | CC7.1, CC3.2 |

The control-to-criteria mapping with evidence pointers is in
`docs/compliance/01-trust-services-criteria-matrix.md`. The current gap list and
remediation roadmap is in `docs/compliance/00-soc2-readiness-assessment.md`.

## 6. Risk management

Security decisions are driven by a documented risk assessment (policy 07), maintained
at least annually and on material change, with a risk register at
`docs/compliance/evidence/risk-register.csv`. Risks are treated by mitigation,
transfer, acceptance, or avoidance, with the Security Officer as decision owner.

## 7. Compliance & legal

- We support (never replace) each advisory firm's own regulatory compliance
  obligations. Exit Blueprint is a software vendor, not a regulated financial entity.
- We commit to breach notification within **30 days of discovery (target: 72 hours)**;
  the contract clause carrying this is 🟡 being finalized.
- Data-processing and consent obligations are governed by the engagement agreement and
  the DPA (`docs/02-data-model.md`, `docs/43-legal-counsel-talking-points.md`).

## 8. Enforcement & exceptions

- Violations of this policy may result in revoked access and, for personnel,
  disciplinary action up to termination.
- Exceptions must be requested in writing, risk-assessed, and approved by the Security
  Officer with a defined expiry. Approved exceptions are recorded in the risk register.

## 9. Review

This policy and every sibling policy are reviewed at least annually and upon any
material change to the system, the vendor set, the team, or the regulatory context.
Review is recorded in `docs/06-decisions.md` (the append-only decision log) and, once
operational, in the evidence log.
