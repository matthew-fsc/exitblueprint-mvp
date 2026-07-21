# 42 — LWG Vendor Due Diligence Questionnaire (L2) — completed response

Exit Blueprint's answers to the **LWG Vendor Due Diligence Questionnaire (Level
2)**, filled in against the platform's actual posture. This follows the packet's
own section order and question numbers so it can be read side-by-side with the
form. It is the specific, form-shaped instance of the generic response pack in
**docs/16-vendor-security-dd.md**; the underlying controls live in code and in
**docs/13-security-summary.md**.

**Status legend:** ✅ implemented in the platform · 📄 documented policy/process ·
🟡 planned (named, not yet in place). Nothing here is claimed that isn't true —
where a control is not yet in place it is marked 🟡, not glossed.

**Fill-ins:** items in `[brackets]` are company facts (entity name, contacts,
addresses, dates) to be supplied by Exit Blueprint at submission time; they are
not in the codebase.

---

## Vendor Information (page 1)

- **Vendor Name / Address / Phone / Website:** `[Exit Blueprint legal entity, address, phone, exitblueprint.net]`
- **Date completed / completed by (Q1):** `[date]` · `[name, title, email, phone]`
- **Q2 — Parent company:** `[No / Yes + name — supplied per review]`
- **Q3 — Public or private:** **Private.**
- **Q4 — Regulated entity subject to independent supervision:** **No.** Exit
  Blueprint is a software vendor. It never takes custody of assets, never gives
  investment advice, and is not itself a regulated financial entity. *If yes /
  regulator:* N/A.
- **Q5 — Business license / CRD:** N/A (not a registered financial entity); `[state business-registration number if desired]`.
- **Q6 — State / country of organization:** `[state]`, United States.
- **Q7 — Years in business:** `[supplied per review]`.
- **Q8 — Years providing the outsourced function:** `[supplied per review]`.
- **Q9 — Approximate employees:** `[supplied per review]`.
- **Q10 — Independent examinations / audits (SOC 2, etc.):** 🟡 **No SOC 2 report
  yet.** A SOC 2 Type I → Type II path is scoped (docs/15 work stream C); the
  readiness assessment is the next external step. Sub-processors that operate the
  platform are themselves SOC 2 Type II (see Subcontracting). This is the single
  most common hard gate on institutional vendor reviews and is our top security
  roadmap item.
- **Q11 — Material claims or judgements:** `[None — confirmed per review]`.

## Nature and Scope of Function(s) (page 2)

- **Q1 — Type of service outsourced:** ☑ **Information Technology** (SaaS
  platform) and ☑ **Administrative / Support Functions** — specifically,
  software that measures exit readiness and drafts reports/briefs. It is **not**
  Asset Management, Custody/Clearing, Trading, Investment Research, Financial
  Planning, Legal Services, or Compliance Consulting.
- **Q2 — Scope / "Covered Function" definition:** Exit Blueprint provides a
  multi-tenant SaaS platform that (a) computes a deterministic, rule-based exit-
  readiness score from advisor-entered data, (b) diagnoses gaps and prescribes
  remediation tasks, and (c) uses an AI service to draft narrative **from** the
  firm's own structured data. **No LLM ever computes or influences a score**
  (architecture rule 1–2). To the extent the firm treats platform hosting of its
  client data as a covered/outsourced function, this response documents the
  associated controls. Exit Blueprint does not perform any investment,
  advisory, custody, or record-of-account function.

## Subcontracting Arrangements (page 2)

- **Q1 — Independent contractors:** `[Yes/No — supplied per review]`. All
  personnel and contractors with access to the rubric, client data, or code are
  under confidentiality and IP-assignment obligations.
- **Q2 — Material subcontracting arrangements:** Yes — the platform is operated
  with a fixed set of vetted **sub-processors** (📄 register below, canonical in
  `seed/subprocessors.csv`, mirrored on the in-app `/security` page):

  | Sub-processor | Purpose | Data exposure | Region | Attestation |
  | --- | --- | --- | --- | --- |
  | **Supabase** | Postgres database, row-level security, object storage | All client records (encrypted at rest; RLS-isolated) | US | SOC 2 Type II |
  | **Clerk** | Identity provider — auth, MFA, org/user management | User identity + session data (names, emails, tokens); no client business records | US | SOC 2 Type II |
  | **Render** | Compute hosting (valuation, report/PDF render, webhooks) | Transient request/response only; no client data at rest | US | SOC 2 Type II |
  | **Vercel** | Static frontend hosting (Vite SPA) | Serves the browser app; no client data at rest | US | SOC 2 Type II |
  | **Stripe** | Subscription billing + payments for advisor firms | Firm billing/payment data; no client assessment records | US | PCI DSS L1; SOC 2 Type II |
  | **Anthropic** | AI narrative drafted from already-structured data | Report inputs only; never trains on data; never scores | US | SOC 2 Type II |

- **Q3 — How subcontractor risk is mitigated:** Each sub-processor is a reputable
  provider carrying its own SOC 2 / PCI attestations; each is limited by design to
  the minimum data its function needs (see the table's "data exposure" column).
  Client business records are RLS-isolated in Supabase; no human at a provider has
  application-level access to firm records under RLS. Changes to the list are
  reflected in the register and the `/security` page. 🟡 A formal **annual
  sub-processor re-assessment cadence** is defined but not yet a recurring
  operational process.

## Compliance & Regulatory (pages 2–3)

- **Q1 — Coordinate with the firm on securities-law compliance:** ✅ Yes. Exit
  Blueprint contractually supports the firm's compliance obligations (data-rights
  agreement + consent capture, docs/02) and never acts as a fiduciary or
  record-of-account keeper.
- **Q2 — Material changes to compliance personnel (past 12 mo):** `[supplied per review]`.
- **Q3 — Significant events (M&A, key-personnel, product changes) (past 12 mo):** `[supplied per review]`.
- **Q4 — Written compliance/security policies:** 📄 This document plus docs/13
  constitute the current security policy of record; a standalone InfoSec policy
  pack is 🟡 planned alongside SOC 2.
- **Q5 — Annual assessment / audit of policies (past 12 mo):** 🟡 No formal
  external audit yet; scoped with SOC 2.
- **Q6 — Material regulatory/criminal action or proceedings (past 12 mo):** **None.**
- **Q7 — Orders or sanctions (past 12 mo):** **None.**
- **Q8 — External audits of compliance/financial controls:** 🟡 Not yet; SOC 2
  path scoped.
- **Q9 — Background checks on all employees:** 🟡 Not yet a documented policy;
  planned before first enterprise/RIA engagement.

## Data & Security (page 4)

- **Q1 — Maintains NPI; encryption at rest & in transit:** **Yes**, NPI is
  treated as confidential client data. ✅ Uploaded source documents are
  **AES-256-GCM** encrypted before storage (`server/documents/crypto.ts`; key from
  `EB_DOCUMENT_KEY`, stored separately from the data). Database volumes are
  encrypted at rest (Supabase). ✅ All traffic is over **TLS 1.2+** (no SSL/legacy
  TLS).
- **Q2 — Stores third-party credentials (usernames/passwords):** **No.**
  Authentication is delegated to **Clerk**; the platform does not store customers'
  external usernames or passwords.
- **Q3 — Level of third-party access to customer information:** Limited to the
  sub-processors listed above, each scoped to the minimum data its function needs.
  No provider has application-level access to firm records under RLS.
- **Q4 — Backup storage / encryption:** ✅ Supabase managed backups with
  point-in-time recovery, encrypted at rest.
- **Q5 — Dedicated or shared environment:** Multi-tenant (shared infrastructure),
  **logically isolated per firm**.
- **Q6 — Shared-environment security / controls:** ✅ **Row-level security** on
  every domain table keyed by `firm_id`, enforced **in the database** (not just the
  application) and covered by an automated isolation test suite (`npm run
  test:rls`). No cross-firm read is possible.
- **Q7 — Who has access to infrastructure and software:** A small, limited set of
  Exit Blueprint administrators, plus the managed-platform providers' operational
  staff bound by their own SOC 2 controls. The application `admin` role's reach is
  defined by RLS policy, not ad-hoc grants.
- **Q8 — Application/data access audit logs:** ✅ Every read of a client document
  or report is written to an **append-only `data_access_log`** (who, what, when),
  readable by the firm's advisors. Assessments are immutable snapshots — a
  correction creates a new version rather than mutating history.
- **Q9 — Breach notification within 30 days (Y/N):** ✅ **Yes** (committed).
  📄 Standard contractual language commits to notification within 30 days of
  discovery, targeting 72 hours. 🟡 The contract template carrying this clause is
  being finalized (see the DPA draft in `src/pages/legal/content.ts`).

## Information Security (pages 5–7)

- **Q1 — Chief Information Security Officer:** 🟡 No dedicated CISO role yet;
  planned as the team grows.
- **Q2 — InfoSec contact:** 📄 A named security contact is designated for vendor
  reviews (see `/security` / docs/13): `[name, title, email, phone]`.
- **Q3 — Risk assessment before granting third-party production access:** 📄
  Sub-processors are vetted at onboarding before any production access.
- **Q4 — % of vendors risk-assessed at onboarding:** 📄 100% of the (small, fixed)
  sub-processor set is vetted at onboarding.
- **Q5 — % of vendors risk-assessed each year:** 🟡 A formal annual re-assessment
  percentage target is defined but not yet tracked as a recurring process.
- **Q6 — AV signature update frequency:** Inherited from managed-platform
  providers (Supabase, Render, Vercel, Clerk), which run provider-managed
  endpoint/host controls. Exit Blueprint operates no self-managed servers.
- **Q7 — Inbound/outbound firewalls:** Provider-run network controls / WAF on the
  managed platforms; no self-managed network perimeter.
- **Q8 — Penetration test frequency:** 🟡 Not yet performed; a first external
  penetration test is scoped with the SOC 2 effort.
- **Q9 — SSL/TLS version:** ✅ **TLS 1.2+ only**; SSL and legacy TLS are disabled.
- **Q10 — Security patches on network devices:** Managed and applied by the
  platform providers; application dependencies are 🟡 to be placed under a
  scheduled vulnerability scan (`npm audit` in CI) — named as the next CI hardening
  step.
- **Q11 — Prevent unauthorized devices on the internal network (NAC):** Inherited
  from providers; Exit Blueprint runs no self-managed office/production network.
- **Q12 — Intrusion detection/prevention (IDS/IPS):** Provider-run at the
  infrastructure layer; application-layer monitoring via the audit log and the
  observability seam (docs/32).

## Cloud (pages 6–7)

- **Q1 — Physical location of primary site:** **United States** (Supabase US
  region); `[specific region/data-center on request]`.
- **Q2 — Access-rights review frequency:** ✅ Access is governed by RLS + roles
  (admin, advisor, reviewer, owner); 📄 a formal periodic access-review cadence is
  defined.
- **Q3 — Password security controls:** ✅ Delegated to **Clerk** — hashing,
  salting, strength enforcement, passwordless options, and **TOTP MFA required for
  advisor and admin accounts**.
- **Q4 — Privileged-user reviews:** 📄 Admin accounts are limited and reviewed; the
  admin role's reach is defined by RLS policy, not ad-hoc grants.
- **Q5 — Automatic shutdown of inactive sessions:** ✅ Implemented — users are
  signed out after **30 minutes of inactivity** (`src/lib/auth.tsx`,
  `IDLE_TIMEOUT_MS`).
- **Q6 — Technical safeguards:** RLS tenant isolation; AES-256-GCM document
  encryption with separately-held key; TLS 1.2+ in transit; short-expiry
  **HMAC-signed URLs** for document delivery (no durable public links);
  role-based access control; required MFA; append-only access audit log; immutable
  assessment snapshots.

## Business Continuity (pages 7–8)

- **Q1 — Business Continuity Plan exists:** 📄 **Yes** — docs/16 §8 is the current
  BCP/DR plan of record.
- **Q2 — Publication date of current BCP/DR plan:** `[date of docs/16 §8 / plan record]`.
- **Q3 — How often tested:** 🟡 A scheduled DR *test* with a recorded last-tested
  date is the next step (not yet performed).
- **Q4 — When last tested:** 🟡 Not yet tested end-to-end.
- **Q5 — How often reviewed/updated:** 📄 Reviewed on each material infrastructure
  change. *Design:* Supabase managed Postgres with automated backups + PITR;
  application code and infra config versioned in git and redeployable from source;
  the compute service is stateless and horizontally redeployable behind the
  `FunctionContext` seam (a host change requires no code change). Recovery =
  restore Supabase to a point in time, redeploy from git, re-point DNS.

## Orderly Termination (page 8)

- **Q1 — Orderly-termination process (assurances/contractual):** 📄 **Yes** — on
  termination a firm's data is exported and then destroyed per the firm's
  instruction; the firm-scoped schema makes a clean per-tenant export/delete
  tractable.
- **Q2 — Data format (industry-standard or proprietary):** ☑ **Industry-standard**
  — exports are structured **CSV/JSON** with documents in their original format;
  nothing is locked in a proprietary container.
- **Q3 — Mechanism to ensure no confidential data remains post-termination:** 📄
  **Yes** — on request or at end of retention, a firm's records are deleted
  (firm-scoped cascade); backups age out per Supabase's retention window. 🟡 A
  self-serve, audited export-and-purge admin action is the planned code deliverable
  that turns this policy into a one-click operation.

---

## Summary of open items (the honest 🟡 list)

Carried from docs/16; these are the answers above that are *planned*, not yet in
place. Items 1–3 are the most likely hard gates on an institutional/RIA review.

1. **SOC 2 Type I → II** — start the readiness assessment (top priority; Q10,
   Compliance Q5/Q8).
2. **Formal InfoSec policy pack + background-check policy** — before first
   enterprise engagement (Compliance Q9; InfoSec Q1).
3. **Contract clause finalization** — ≤30-day breach notification + orderly-
   termination language (Data Q9; Termination Q1/Q3).
4. **CI vulnerability scanning** (`npm audit`/dependency review) and a first
   **penetration test** (InfoSec Q8/Q10).
5. **Recurring cadences with recorded dates** — annual sub-processor
   re-assessment, periodic access review, and a **DR test** with a last-tested date
   (Subcontracting Q3; InfoSec Q5; Cloud Q2; BC Q3/Q4).
6. **Self-serve tenant export + audited purge** — the code that makes orderly
   termination one click (Termination Q3).

*Cross-references: docs/16 (generic response pack), docs/13 (advisor-facing
security summary), docs/15 (the DD analysis this packet was modeled on),
`seed/subprocessors.csv`, `src/pages/legal/content.ts` (DPA/breach clause).*
