# Exit Blueprint — Security Summary

_A one-page overview for advisor compliance review. Reflects the controls
implemented in the platform (beta Requirement 5)._

## Data storage

- Client data lives in **PostgreSQL (Supabase)**. Every domain table carries a
  `firm_id` and is protected by **row-level security**: a firm can read and write
  only its own records — advisors, clients, engagements, assessments, documents,
  reports. Isolation is enforced in the database, not just the application, and is
  covered by an automated RLS test suite.
- Assessments are **immutable snapshots** tied to a scoring rubric version;
  corrections create a new version rather than mutating history.

## Encryption

- **In transit:** all traffic is over TLS/HTTPS.
- **At rest:** uploaded source documents are encrypted with **AES-256-GCM**
  before storage; the key is supplied via `EB_DOCUMENT_KEY` and never stored with
  the data. Encrypted bytes live either in Postgres or, with `EB_STORAGE=supabase`,
  in a **private object-storage bucket** — the same envelope either way, so even a
  leaked bucket URL yields only ciphertext.
- **Malware scanning:** with `EB_SCANNER=clamav`, every upload is scanned before it
  is stored; an infected file is rejected and never persisted. (Default: recorded
  as skipped.)
- **Document delivery:** source documents are served **only through short-expiry
  signed URLs** (HMAC, default 5-minute expiry) — never a durable public link, and
  always through the audited server route that logs every read/download.

## Access controls

- **Roles:** platform admin, advisor, reviewer, and client (owner). Each role's
  reach is defined by row-level security policies.
- **MFA:** multi-factor authentication (TOTP) is **required for advisor and admin
  accounts**, enforced at sign-in via authenticator assurance level.
- **Idle timeout:** signed-in sessions are automatically terminated after 30
  minutes of inactivity.
- **Audit log:** every read of a client document or report is recorded in an
  append-only `data_access_log` (who, what, when), readable by the firm's
  advisors for compliance.
- **Consent gate:** no assessment data is collected for a client until a signed
  engagement agreement and explicit data-use consents are recorded.

## Retention & orderly termination

- Records are retained for the life of the engagement and its readiness history.
- On termination, a firm's data is exported in industry-standard formats
  (CSV/JSON + original documents) and then destroyed per the firm's instruction;
  the firm-scoped schema makes a clean per-tenant export/purge tractable.
  (Deletion on request is handled operationally in the beta; a self-serve audited
  export+purge is a tracked roadmap item.)

## Subprocessors

Canonical register: `seed/subprocessors.csv`.

| Subprocessor | Purpose | Data |
| --- | --- | --- |
| **Supabase** | Postgres database, row-level security, storage | All client records (encrypted at rest, RLS-isolated) |
| **Clerk** | Identity provider — authentication, MFA, org/user management | User identity + session data; no client business records |
| **Render** | Compute service hosting (valuation, report + PDF render, webhooks) | Transient, per-request |
| **Vercel** | Static frontend hosting (Vite single-page app) | Serves the browser app; no client data at rest |
| **Stripe** | Subscription billing + payments for advisor firms | Firm billing/payment data; no client assessment records |
| **Anthropic** | AI narrative drafted from structured data | Report inputs only — **never** used to compute or influence a score |

## Business continuity

Managed Postgres backups + point-in-time recovery (Supabase); stateless,
redeployable-from-git compute (Render); static frontend hosting (Vercel). Full BCP/DR and
the complete vendor-DD response: **docs/16-vendor-security-dd.md**.

## Configuration checklist (production)

- `EB_DOCUMENT_KEY` — 32-byte hex key for document encryption at rest (**required**).
- `EB_SIGNING_KEY` — HMAC key for signed document URLs (falls back to the JWT secret).
- `EB_STORAGE=supabase` + `SUPABASE_SERVICE_ROLE_KEY` — move encrypted bytes to the
  private Storage bucket (created by the `20260720000400` migration). Optional.
- `EB_SCANNER=clamav` + `EB_CLAMD_HOST`/`EB_CLAMD_PORT` — enable malware scanning. Optional.
- MFA enforced by Clerk, the identity provider (the local dev emulator bypasses it).
