# SOC 2 Policy Pack — Shared Facts Brief (authoring source of truth)

> **Internal authoring aid, not an audit artifact.** This file exists so every
> policy in `docs/compliance/policies/` cites the *same, true* facts about the
> Exit Blueprint platform. When you write a policy, pull specifics from here —
> do not invent controls, dates, headcounts, or vendor claims. If a control is
> not yet real, mark it **🟡 planned**, never ✅.

## Honesty contract (non-negotiable — mirrors CLAUDE.md)

Use these status markers consistently in every policy, exactly as docs/16 does:

- **✅ Implemented** — the control exists in code/config today and can be evidenced.
- **📄 Documented** — the policy/process is written and adopted (this pack), but
  is a procedure people follow, not something enforced by code.
- **🟡 Planned** — named, scoped, not yet in place. Never dress a 🟡 as a ✅.

An auditor will test claims against evidence. A single over-claim (saying a
control is implemented when it is a plan) is worse than an honest 🟡, because it
reads as a material misstatement. When unsure, mark it 🟡 and add it to the gap list.

## Company & scope

- **Company:** Exit Blueprint (operating entity: Fracture Systems). Software vendor.
  **Not** a regulated financial entity; never takes custody of assets, never gives
  investment advice, never acts as fiduciary or record-keeper of account data.
- **Product:** Exit-readiness platform for lower-middle-market (LMM) business owners,
  distributed through M&A advisors. Measures exit readiness (deterministic DRS/ORI
  score), diagnoses gaps, prescribes remediation, educates owners over a 12–36 month
  pre-deal engagement.
- **Document owner / approver:** Matthew (matthew@fracturesystems.com). Small team;
  Matthew currently holds the security-officer / CISO-equivalent responsibility.
- **Policy pack adoption date:** 2026-07-23. **Review cadence:** at least annually
  and on material change. **Version:** 1.0.
- **Target report:** SOC 2. **Trust Services Categories in scope:** Security
  (Common Criteria — primary), **Availability**, and **Confidentiality**.
  Processing Integrity and Privacy are **not** in the initial scope (note this
  explicitly where relevant; Privacy is handled via the DPA/consent process, not a
  SOC 2 Privacy assertion, in the first report).
- **Report path:** SOC 2 Type I (design of controls at a point in time) first, then
  Type II (operating effectiveness over a 3–12 month window). Type I is the near-term
  external milestone.

## The stack (system description boundary)

The audited system is the Exit Blueprint application and its production data plane:

| Component | Role | Notes |
| --- | --- | --- |
| **React + Vite SPA** | Advisor workspace + owner portal frontend | Static assets; holds no client data at rest |
| **Node compute service** (`server/http.ts`) | The single deployable serving `/functions/v1/*`, webhooks, signed downloads | Stateless; redeployable from git |
| **Supabase (Postgres + RLS + Storage)** | System of record; all client data | US region; managed backups + PITR; RLS enforces tenant isolation |
| **Clerk** | Identity provider — auth, MFA, org/user management | Clerk Organizations = firms; issues session JWTs verified via JWKS |
| **Render** | Compute hosting for the Node service | TLS termination, WAF, patching inherited |
| **Vercel** | Static frontend hosting | No client data at rest |
| **Stripe** | Subscription billing for advisor firms | Firm billing data only; no assessment records |
| **Anthropic (Claude API)** | AI narrative drafting from already-structured data | Report inputs only; never computes/influences a score; never trains on data |

Sub-processor canonical register: `seed/subprocessors.csv`. All sub-processors are
US-based and maintain their own SOC 2 / ISO attestations (inherited controls).

## Implemented technical controls (✅ — cite the file path)

- **Multi-tenant isolation via Postgres Row-Level Security.** Every domain table
  carries `firm_id`; RLS policies enforce a firm reads/writes only its own rows.
  Enforced in the database, not just the app. Verified by an automated suite:
  `npm run test:rls` (`scripts/rls-test.ts`), run in CI on every PR.
- **Encryption in transit:** TLS/HTTPS everywhere; modern TLS only (1.2+). DB
  connections use TLS with CA verification when `DATABASE_CA_CERT` is set
  (`server/db-ssl.ts`); production warns if unverified.
- **Encryption at rest (documents):** uploaded source documents are AES-256-GCM
  encrypted before storage (`server/documents/crypto.ts`); key from `EB_DOCUMENT_KEY`,
  never stored with the data. GCM auth tag detects tampering. Supabase provides
  encrypted volumes for the database itself.
- **Signed, short-expiry document delivery:** documents are served only through
  HMAC-SHA256 signed URLs with a default 5-minute expiry (`server/documents/signed-url.ts`),
  verified with a timing-safe comparison. Never a durable public link.
- **Safe content-type serving (stored-XSS defense):** the download route recomputes
  a safe content-type from a sanitized extension, serves all but a small trusted set
  (PDF/PNG/JPEG) as `attachment` octet-stream, and sets `X-Content-Type-Options: nosniff`
  (`server/http.ts` `/documents/download`).
- **Audit logging:** every read/download of a client document or report is recorded
  append-only in `data_access_log` (who/what/when), readable by the firm's advisors
  (`server/audit.ts`). Answer-provenance mutations are logged immutably to
  `answer_provenance_events`.
- **Authentication:** delegated to Clerk. Compute service verifies JWTs by signature
  and expiry against Clerk/Supabase JWKS or a legacy HS256 secret (`server/auth-jwt.ts`);
  requires a `sub` claim. No password handling in-app.
- **MFA:** TOTP MFA required for advisor and admin accounts, enforced at sign-in by
  Clerk policy. (The local dev emulator bypasses it; production enforces it.)
- **Idle session timeout:** signed-in sessions auto-terminate after 30 minutes of
  inactivity (`src/lib/auth.tsx`, `IDLE_TIMEOUT_MS`).
- **Rate limiting:** per-IP fixed-window limiter on the authenticated function surface
  and the unauthenticated webhook routes (`server/ratelimit.ts`, `server/http.ts`).
  Volume hygiene, not an auth boundary.
- **Webhook security:** Clerk (Svix) and Stripe webhooks are signature-verified on the
  raw body with replay/timestamp tolerance; n8n scheduled webhooks use a shared secret
  compared timing-safely. Unset secret → endpoint returns 503 (disabled by default).
- **Secrets management:** secrets supplied via environment variables (Render/Vercel/CI
  secret stores), never committed. `.env`/`.env.local` are git-ignored. Production
  **hard-fails at startup** if `EB_DOCUMENT_KEY` or `EB_SIGNING_KEY` is missing
  (`server/http.ts`) — real client documents can never be protected by a dev default.
- **Immutable assessments:** assessments are immutable snapshots tied to a
  `rubric_version`; corrections create a new version, never mutate history.
- **Deterministic scoring integrity:** scores are produced by versioned, rule-based
  code verified against a reference implementation (`seed/fixtures/reference_scorer.py`);
  no LLM ever computes or influences a score (CLAUDE.md rule 1). AI output is always
  labeled draft narrative.
- **Consent gate:** no assessment data is collected for a client until a signed
  engagement agreement and explicit data-use consents are recorded.
- **CI quality gate** (`.github/workflows/ci.yml`): every PR runs migrations on a fresh
  DB, the RLS isolation suite, idempotent seeds, the scoring-fixture tests, the
  extraction eval, and the production build. Merge is gated on green CI.
- **Error monitoring / structured request logging:** Sentry seam
  (`server/observability.ts`), no-op until `SENTRY_DSN` set; scrubs secrets/PII.

## Documented processes (📄 — this pack establishes them)

- Change management runs through GitHub PRs + required CI + review before merge to `main`.
- Access provisioning/deprovisioning for firms/advisors via `scripts/admin.ts`
  (Clerk Organization + user + membership + profile) and the Clerk provisioning webhook.
- Backups + PITR are provided by Supabase (managed).
- Vendor set is fixed and each vendor is a reputable provider with its own attestations.
- Breach notification: committed contractual language of ≤30 days from discovery
  (target 72 hours).

## Known gaps / open items (🟡 — the honest list; keep policies consistent with this)

Straight from docs/16 §"open items" — every policy must stay consistent with these:

1. **No SOC 2 report yet.** Type I → Type II path scoped; readiness assessment is this pack.
2. **No penetration test performed yet.** First external pen test scoped with the SOC 2 effort.
3. **Formal InfoSec policy pack** — this pack is the deliverable that closes item; before
   the pack it did not exist as adopted policy.
4. **Background-check policy** for personnel — planned before first enterprise engagement.
5. **Breach-notification contract clause** — being finalized in the contract template.
6. **CI vulnerability scanning** (`npm audit` / dependency review in CI) — named as the
   next CI hardening step. (Note: a manual `npm audit` currently reports 0 vulnerabilities.)
7. **Recurring cadences not yet operationalized:** annual sub-processor re-assessment,
   periodic access review with recorded dates, and a DR test with a recorded last-tested date.
8. **Self-serve tenant export + audited purge** — deletion/export handled operationally
   today; one-click audited export/purge is a tracked roadmap item.
9. **Dedicated CISO role / formal risk-assessment cadence** — Matthew holds the role now;
   formalization planned as the team grows.
10. **Formal employee security-awareness training program** — planned.

## Style & format for every policy

- Start with a header block: **Policy name · Owner (Matthew) · Version 1.0 · Effective
  2026-07-23 · Review: annually / on material change · Applies to: all Exit Blueprint
  personnel and systems.**
- Sections: Purpose · Scope · Policy statements (the requirements) · Roles &
  responsibilities · Implementation / evidence (cite real file paths & the ✅/📄/🟡
  status) · Exceptions · Review & enforcement.
- Right-size for a small, cloud-native startup. Do **not** cargo-cult enterprise
  controls that don't apply (no data centers, no corporate LAN, no on-prem servers —
  it's a remote team on managed cloud). Say "inherited from managed provider" where true.
- Map each policy to the SOC 2 Common Criteria it supports (e.g. CC6.x for access,
  CC7.x for operations/monitoring, CC8.x for change management) in a short line.
- Cross-reference sibling policies and docs/13, docs/16 by path.
- Plain, readable prose. No boilerplate legalese padding.
</content>
