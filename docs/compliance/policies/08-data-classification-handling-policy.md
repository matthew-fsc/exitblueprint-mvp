# Data Classification & Handling Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually and on material change · **Applies to:** all Exit Blueprint data, personnel, and systems.

## Purpose

Classify the data Exit Blueprint handles into tiers and define handling
requirements for each, so that the most sensitive data — client business
financials and owner personal-financial-readiness inputs — receives the
strongest protection. This policy makes the platform's existing technical
controls legible as a data-handling regime.

## Scope

All data created, collected, processed, stored, or transmitted by the Exit
Blueprint platform, in any location (Supabase, Clerk, Stripe, application logs,
documents, exports). Applies to all personnel and to the sub-processors that
handle each tier (policy 06).

## Classification tiers

| Tier | Definition | Examples in the platform |
| --- | --- | --- |
| **Public** | Intended for public release; no harm if disclosed | Marketing pages, public product copy, published methodology descriptions |
| **Internal** | Non-public operational data; low harm if disclosed | Non-sensitive config, aggregate non-identifying metrics, internal docs |
| **Confidential** | Non-public data whose disclosure would harm a firm, owner, or Exit Blueprint | Assessment answers and derived scores (DRS/ORI); user identity and auth data (via Clerk); firm billing data (via Stripe); audit logs |
| **Restricted — NPI** | The most sensitive: nonpublic personal/financial information whose exposure causes direct harm | Client business financial summaries; owner personal-financial-readiness inputs; uploaded source financial documents |

### Mapping the platform's data

- **Client business financials + owner personal-financial-readiness inputs →
  Restricted (NPI).** The crown jewels; strongest handling.
- **Assessment answers and derived DRS/ORI scores → Confidential.**
- **Identity / authentication data (names, emails, session tokens) →
  Confidential**, held by Clerk (the identity provider); no passwords are
  handled in-app.
- **Firm billing / payment data → Confidential**, held by Stripe (PCI DSS Level
  1); no client assessment records reach Stripe.
- **Marketing and public methodology content → Public.**

### NPI definition

Nonpublic Personal Information (NPI) is financial or personal information about
an identifiable business or owner that is not publicly available and that the
owner/firm has not consented to disclose — here, business financial summaries
and owner personal-financial-readiness inputs. NPI is always Restricted and is
never sent to any system outside its required processing path.

## Handling requirements by tier

| Requirement | Public | Internal | Confidential | Restricted (NPI) |
| --- | --- | --- | --- | --- |
| Encryption in transit (TLS 1.2+) | ✅ | ✅ | ✅ | ✅ |
| Encryption at rest | n/a | provider volumes | provider volumes | ✅ AES-256-GCM app-layer for documents; encrypted DB volumes |
| Access control | open | authenticated | RLS + role (`firm_id`) | RLS + role; least privilege |
| Delivery of documents | n/a | n/a | signed short-expiry URL | ✅ HMAC signed URL, 5-min expiry, audited |
| Logging of the data itself | allowed | allowed | metadata only | **never in logs**; access is logged, content is not |
| Sent to Anthropic | n/a | n/a | only structured report inputs | never raw NPI for scoring; see AI boundary |
| Audit of access | optional | optional | ✅ `data_access_log` | ✅ `data_access_log` |

Concrete controls backing the two sensitive tiers:

- **Encryption in transit.** TLS/HTTPS everywhere, modern TLS only; DB
  connections verify the CA when `DATABASE_CA_CERT` is set (`server/db-ssl.ts`). ✅
- **Encryption at rest.** Uploaded source documents are AES-256-GCM encrypted
  before storage; the key comes from `EB_DOCUMENT_KEY` and is never stored with
  the data (`server/documents/crypto.ts`). The database itself sits on encrypted
  Supabase volumes; structured columns are not additionally field-encrypted. See
  **Encryption scope** below for the exact document-vs-structured-data breakdown. ✅
- **Access via RLS.** Every domain table carries `firm_id`; row-level security
  enforces that a firm reads/writes only its own rows, verified by
  `scripts/rls-test.ts` (`npm run test:rls`). ✅
- **Signed-URL delivery.** Documents are served only through HMAC-SHA256 signed
  URLs with a 5-minute default expiry, timing-safe verified
  (`server/documents/signed-url.ts`); never a durable public link. ✅
- **No NPI in logs.** Application logs and error monitoring scrub secrets/PII
  (`server/observability.ts`); the audit trail records *who accessed what and
  when* (`data_access_log`), not the content. ✅
- **Safe serving.** Downloads are served `attachment` octet-stream with
  `X-Content-Type-Options: nosniff` outside a small trusted media set
  (`server/http.ts`), defending against stored XSS. ✅

### Encryption scope — documents vs. structured data (important distinction)

"Encryption at rest" means two different things depending on the form the data
takes, and NPI arrives in **both** forms. This section states exactly what
protects each so the posture is not over-read.

| Form of NPI / Confidential data | Application-level encryption (our key) | Encryption at rest (Supabase-managed volumes) | Tenant isolation |
| --- | --- | --- | --- |
| **Uploaded source documents** (financial statements, tax returns, etc.) — `document_blobs.bytes` | ✅ **AES-256-GCM**, key in `EB_DOCUMENT_KEY`, never stored with the data (`server/documents/crypto.ts`) | ✅ | ✅ RLS |
| **Structured datapoints** (assessment answers, business financial summaries, owner personal-financial-readiness inputs, DRS/ORI scores, profile PII) — ordinary Postgres columns | ❌ **not** field/column-level encrypted | ✅ (whole-database volume encryption, AES-256) | ✅ RLS |

- **Only uploaded document bytes carry a second, application-level encryption
  layer** whose key lives outside the data plane. That layer means a leaked
  object-storage URL, or a read of the raw `document_blobs` table, yields only
  ciphertext. ✅
- **Structured datapoints are stored as normal columns** — protected by
  Supabase's managed volume encryption at rest, RLS tenant isolation, and TLS in
  transit, but **not** individually encrypted with an application key. Verified:
  there is no `pgcrypto`, column encryption, or Vault/pgsodium usage in the
  schema. This is a standard, audit-accepted architecture (SOC 2 does not require
  field-level encryption of queryable structured data).
- **Residual risk (stated plainly).** A compromise at the database layer itself —
  a leaked database credential or a provider-side read — would expose structured
  NPI as plaintext, whereas document contents would remain ciphertext. This
  residual is tracked in `evidence/risk-register.csv` (R17; related R2/R7).
- **Enhancement option (🟡 not adopted).** Application-level field encryption of
  the narrowest structured NPI fields (via a KMS envelope or Supabase
  Vault/pgsodium) is a considered defense-in-depth step, deliberately not adopted
  today because it materially complicates querying, indexing, and search on those
  columns and is not required for the target report. Revisit if a specific
  customer or regulatory requirement calls for it.

## Labeling

Given the small, fixed schema, classification is defined at the data-type level
by this policy rather than per-record tags: the tables and fields holding NPI
and Confidential data are enumerated here and in docs/02 (data model). New data
types must be classified in this policy before they are collected.

- Status: 📄 type-level labeling defined here; 🟡 per-record/field tagging is not
  implemented and is not required at current scale.

## The AI boundary

Consistent with architecture rule 2 and policy 06: only **already-structured
data** is sent to Anthropic to draft narrative. NPI is **never** used to compute
or influence a score, and Anthropic **never trains** on our data. Scoring is
deterministic, rule-based code (`seed/fixtures/reference_scorer.py`); no LLM
touches a score. AI output is always labeled draft narrative. This keeps the
most sensitive tiers out of any generative-training or scoring path. ✅

## Consent gate

No assessment data (Confidential or NPI) is collected for a client until a
signed engagement agreement and explicit data-use consents are recorded. ✅

## Roles & responsibilities

- **Matthew** — owns the classification scheme, approves the tier of any new
  data type, and ensures controls match the tier.
- **All personnel** — must handle each data type per its tier and must never
  place NPI in logs, tickets, chat, or any system outside its processing path.

## Implementation / evidence

- In transit: `server/db-ssl.ts` (✅).
- At rest: `server/documents/crypto.ts`, `EB_DOCUMENT_KEY` (✅); Supabase encrypted volumes.
- Access control: `scripts/rls-test.ts`, `npm run test:rls`, `firm_id` on every domain table (✅).
- Signed delivery: `server/documents/signed-url.ts` (✅).
- No-PII logging: `server/observability.ts` (✅).
- Access audit: `server/audit.ts`, `data_access_log` (✅).
- AI boundary: architecture rule 2; `seed/fixtures/reference_scorer.py` (✅).
- Per-record labeling (🟡 not implemented; type-level only).

## Exceptions

No exception permits NPI in logs or NPI in a scoring/training path. Any other
deviation must be approved and documented by Matthew with a remediation date.

## Review & enforcement

Reviewed at least annually and whenever a new data type is introduced. Matthew
enforces the policy; mishandling Restricted/NPI data is a serious policy
violation handled under the HR Security Policy (policy 14).

## SOC 2 mapping

Supports Common Criteria CC6.1 (logical access security over protected
information), CC6.7 (restricted transmission and movement of data), and
Confidentiality criterion C1.1 (identify and maintain confidential information).
Cross-references: policy 06 (vendor risk — AI boundary), policy 14 (HR
security), docs/02, docs/13, docs/16.
