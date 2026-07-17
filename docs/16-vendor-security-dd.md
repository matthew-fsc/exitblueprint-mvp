# 16 - Vendor Security Due-Diligence Response

Exit Blueprint's answer to a vendor due-diligence questionnaire of the kind an
RIA or enterprise buyer sends before trusting a technology vendor with a
"covered function" (modeled on the LWG vendor DD packet analyzed in docs/15).
This is the ready-made response pack for the sales-gating security review that
advisor firms will run on us, and it doubles as an honest internal control map.

**Status legend:** ✅ implemented in the platform · 📄 documented policy/process ·
🟡 planned (named, not yet in place). Nothing here is claimed that isn't true —
where a control is not yet in place it is marked 🟡, not glossed.

The controls themselves live in code and in docs/13-security-summary.md (the
one-page advisor-facing summary); this document is the questionnaire-shaped view.

---

## 1. Vendor information

- **Entity / ownership / years / headcount:** company facts, supplied per review.
- **Regulated entity:** No — Exit Blueprint is a software vendor, not a regulated
  financial entity; it never takes custody of assets or gives investment advice.
- **Independent audit / SOC 2 (Q8, Q10):** 🟡 No SOC 2 report yet. A SOC 2 Type I →
  Type II path is scoped (docs/15 work stream C); the readiness assessment is the
  next external step. This is the single most common hard gate on enterprise vendor
  reviews and is tracked as the top security roadmap item.
- **Material claims/judgements (Q11):** company facts, supplied per review.

## 2. Nature & scope of function

- **Service outsourced:** narrative generation — Exit Blueprint drafts reports and
  briefs *from* a firm's own structured assessment data. It is **not** asset
  management, custody, trading, or investment advice, and it never computes or
  influences a readiness score with an LLM (architecture rule 2).
- **Data handled:** business financial summaries, assessment answers, and limited
  owner personal-financial-readiness inputs (treated as NPI).

## 3. Subcontracting / sub-processors

📄 **Sub-processor register** (canonical list maintained in
`seed/subprocessors.csv`; summarized on the in-app `/security` page):

| Sub-processor | Purpose | Data exposure | Region |
| --- | --- | --- | --- |
| **Supabase** | Postgres database, authentication, object storage | All client records (encrypted at rest; RLS-isolated) | US |
| **Vercel** | Frontend hosting + serverless compute (functions, PDF render) | Transient request/response only | US |
| **Anthropic** | AI narrative drafted from already-structured data | Report inputs only; never trains on data; never scores | US |

- Sub-processors are limited to those above; each is a reputable provider with its
  own SOC 2 / ISO attestations. 🟡 A formal annual sub-processor risk-assessment
  cadence is defined here but not yet a recurring operational process.
- Changes to the sub-processor list are reflected in this register and the
  `/security` page.

## 4. Compliance & regulatory

- **Written security policy:** 📄 this document + docs/13 constitute the current
  security policy; a standalone InfoSec policy pack is 🟡 planned alongside SOC 2.
- **Coordinate with the firm on securities-law compliance:** ✅ we contractually
  support the firm's compliance obligations (data-rights agreement + consent
  capture, docs/02) and never act as a fiduciary or record-keeper of account data.
- **Background checks (§9):** 🟡 not yet a documented policy; planned before first
  enterprise engagement.
- **Material regulatory/criminal action:** none.

## 5. Data & security

- **NPI held:** Yes — treated as confidential client data.
- **Encryption at rest (§1):** ✅ uploaded source documents are **AES-256-GCM**
  encrypted before storage (`server/documents/crypto.ts`, key from
  `EB_DOCUMENT_KEY`, never stored with the data). Database storage is on Supabase
  (encrypted volumes).
- **Encryption in transit (§1):** ✅ all traffic over TLS/HTTPS; modern TLS only.
- **Third-party credential storage (§2):** No — we do not store customers' external
  usernames/passwords. Auth is delegated to Supabase (hashed, salted).
- **Third-party access to customer data (§3):** limited to the sub-processors in §3;
  no human at those providers has application-level access to firm records under RLS.
- **Backups (§4):** ✅ Supabase managed backups with point-in-time recovery;
  encrypted at rest.
- **Shared vs dedicated environment (§5–6):** multi-tenant, logically isolated by
  **row-level security** on every domain table (`firm_id`), enforced in the
  database and covered by an automated isolation test suite (`npm run test:rls`).
- **Access & audit logs (§7–8):** ✅ every read of a client document/report is
  recorded in an append-only `data_access_log` (who, what, when), readable by the
  firm's advisors.
- **Breach notification ≤30 days (§9):** 📄 committed as standard contractual
  language: notification within 30 days of discovery (target: 72 hours). 🟡 the
  contract template carrying this clause is being finalized.

## 6. Information security

- **CISO / security contact (§1–2):** 📄 a named security contact is designated for
  vendor reviews (see the security contact on `/security` / docs/13). 🟡 a dedicated
  CISO role is planned as the team grows.
- **Vendor risk assessment before access (§3–5):** 📄 sub-processors are vetted at
  onboarding; 🟡 a formal annual re-assessment percentage target is not yet tracked.
- **AV / firewall / patching / NAC / IDS (§6–12):** infrastructure controls are
  inherited from Supabase and Vercel (managed platforms with provider-run WAF,
  patching, and network controls). Application dependencies are 🟡 to be put under a
  scheduled vulnerability-scan (e.g. `npm audit` in CI) — named here as the next
  concrete CI hardening step.
- **TLS version (§9):** ✅ TLS 1.2+ only; no SSL/legacy TLS.
- **Penetration testing (§8):** 🟡 not yet performed; a first external pen test is
  scoped with the SOC 2 effort.

## 7. Cloud

- **Primary data location (§1):** United States (Supabase US region).
- **Access-rights review (§2):** ✅ access is governed by RLS + roles (admin,
  advisor, reviewer, owner); 📄 a formal periodic access-review cadence is defined.
- **Password controls (§3):** ✅ delegated to Supabase Auth (hashing, salting,
  strength enforcement).
- **Privileged-user review (§4):** 📄 admin accounts are limited and reviewed; the
  admin role's reach is defined by RLS policy, not ad-hoc grants.
- **Automatic shutdown of inactive sessions (§5):** ✅ implemented — the app signs a
  user out after 30 minutes of inactivity (`src/lib/auth.tsx`, `IDLE_TIMEOUT_MS`).
- **MFA:** ✅ TOTP MFA is **required for advisor and admin accounts**, enforced at
  sign-in via Supabase authenticator assurance level.

## 8. Business continuity

📄 **Business Continuity / DR plan** (this section is the current plan of record):

- **Data durability:** Supabase managed Postgres with automated backups + PITR;
  application code and infrastructure config are versioned in git and redeployable
  from source.
- **Availability:** Vercel provides redundant, multi-region edge hosting for the
  frontend; the compute layer is stateless and horizontally redeployable behind the
  `FunctionContext` seam (docs/10) — a host change requires no code change.
- **Recovery:** RTO/RPO targets are documented here; recovery is: restore Supabase
  to a point in time, redeploy from git, re-point DNS. 🟡 a scheduled DR *test* with
  a recorded last-tested date is the next step (the packet asks for test cadence).
- **Review cadence:** this plan is reviewed on each material infrastructure change.

## 9. Orderly termination

- **Orderly-termination process (§1):** 📄 on termination, a firm's data is exported
  and then destroyed per the firm's instruction; the platform's firm-scoped schema
  makes a clean per-tenant export/delete tractable.
- **Data format (§2):** industry-standard — data exports are structured
  (CSV/JSON) and documents in their original format; nothing is locked in a
  proprietary container.
- **Data destruction (§3):** 📄 on request or at end of retention, a firm's records
  are deleted (firm-scoped cascade); backups age out per Supabase's retention
  window. 🟡 a self-serve, audited export-and-purge admin action is the planned code
  deliverable that turns this policy into a one-click operation.

---

## Summary of open items (the honest 🟡 list)

1. **SOC 2 Type I → II** — scoped; start the readiness assessment (top priority).
2. **Formal InfoSec policy pack + background-check policy** — before first
   enterprise engagement.
3. **Contract clause finalization** — ≤30-day breach notification + orderly
   termination language.
4. **CI vulnerability scanning** (`npm audit`/dependency review) and a first
   **penetration test**.
5. **Recurring cadences** — annual sub-processor re-assessment, periodic access
   review with recorded dates, and a **DR test** with a last-tested date.
6. **Self-serve tenant export + audited purge** — the code that makes §9 one click.

These are tracked as docs/15 work stream C. Items 1–3 are the ones most likely to
be hard gates on an enterprise/RIA vendor review; the rest strengthen the posture.
