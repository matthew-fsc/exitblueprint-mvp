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
  the data. (Beta stores encrypted bytes in Postgres; the `StorageAdapter` seam
  moves them to object storage without changing application code.)
- **Document delivery:** source documents are served **only through short-expiry
  signed URLs** (HMAC, default 5-minute expiry) — never a durable public link.

## Access controls

- **Roles:** platform admin, advisor, reviewer, and client (owner). Each role's
  reach is defined by row-level security policies.
- **MFA:** multi-factor authentication (TOTP) is **required for advisor and admin
  accounts**, enforced at sign-in via authenticator assurance level.
- **Audit log:** every read of a client document or report is recorded in an
  append-only `data_access_log` (who, what, when), readable by the firm's
  advisors for compliance.
- **Consent gate:** no assessment data is collected for a client until a signed
  engagement agreement and explicit data-use consents are recorded.

## Retention

- Records are retained for the life of the engagement and its readiness history.
  Deletion on request is handled operationally (there is no automated purge in the
  beta).

## Subprocessors

| Subprocessor | Purpose | Data |
| --- | --- | --- |
| **Supabase** | Database, authentication, storage | All client records |
| **Compute host** (Render/Railway/Fly) | Report/PDF rendering, document processing | Transient, per-request |
| **Anthropic** (optional) | AI narrative drafted from structured data | Report inputs only — **never** used to compute or influence a score |

## Configuration checklist (production)

- `EB_DOCUMENT_KEY` — 32-byte hex key for document encryption at rest (**required**).
- `EB_SIGNING_KEY` — HMAC key for signed document URLs (falls back to the JWT secret).
- MFA enforced by the hosted Supabase project (the local dev stack bypasses it).
