# Logging & Monitoring Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually / on material change · **Applies to:** all Exit Blueprint personnel and systems.

## Purpose

Define what the platform logs, what it deliberately does not log, who reviews
logs, how anomalies surface, and how long log data is kept — so that access to
client data is accountable and operational problems are detected. This is the
operations/monitoring control set for our SOC 2 Security scope.

## Scope

Application and access logging produced by the Exit Blueprint compute service and
database: the data-access audit trail, answer-provenance history, structured
request/error logging, and the error-monitoring seam. Infrastructure and network
logs (load balancer, WAF, host) are inherited from our managed providers
(Render, Vercel, Supabase, Clerk) and are governed by their own attested
controls.

## Policy statements

1. **Audit every access to client data.** Every read/download of a client
   document or report is recorded in an append-only audit trail capturing who,
   what, and when.
2. **Immutable provenance.** Answer-provenance mutations are written to an
   immutable event log; history is never updated or deleted in place.
3. **Structured request and error logging.** The compute service emits
   structured logs and routes errors through a monitoring seam that is a no-op
   until a monitoring backend is configured.
4. **Never log secrets or PII.** Tokens, secrets, authorization material, raw
   request bodies, and direct personal data must never appear in logs or error
   context. Sensitive fields are scrubbed before any log or error sink receives
   them. Logs identify actors by id, not by personal detail.
5. **Logs are reviewable by the right party.** A firm's advisors can read their
   own firm's data-access log for compliance; cross-tenant log reads are not
   permitted. Platform-level operational logs are reviewed by the security
   officer.
6. **Alerting.** Errors captured through the monitoring seam are surfaced for
   review when a backend is configured. Formal alert thresholds and on-call
   routing are defined as they are operationalized.
7. **Retention.** The data-access log and answer-provenance events are retained
   for the life of the engagement as part of the client record (see the Data
   Retention & Disposal Policy). Operational/error logs are retained per the
   configured monitoring backend's retention window.

## Roles & responsibilities

- **Security officer (Matthew):** reviews platform operational logs and error
  reports, defines alert thresholds as monitoring matures, investigates
  anomalies.
- **Advisors:** review their firm's data-access log as part of compliance
  oversight.
- **Engineering (all who ship code):** ensure new code paths log through the
  approved seams and never emit secrets or PII.

## Implementation / evidence

- ✅ **Append-only data-access log** — `server/audit.ts` inserts who/what/when
  into `data_access_log`; readable by the firm's advisors, written via the
  service role.
- ✅ **Immutable answer-provenance events** — `server/audit.ts` writes to
  `answer_provenance_events`, which holds no UPDATE/DELETE grant (immutable).
- ✅ **Structured logging + error-monitoring seam** — `server/observability.ts`;
  a Sentry-backed sink that is a no-op until `SENTRY_DSN` is set.
- ✅ **Secret/PII scrubbing** — `server/observability.ts` `scrubContext` drops
  sensitive keys (tokens, secrets, auth material, cookies, JWTs, sessions,
  emails, phones, request bodies/payloads) before any console or Sentry sink.
- 🟡 **Formal alerting thresholds / on-call routing** — not yet configured; the
  monitoring seam is present and disabled by default until `SENTRY_DSN` is set
  in production (facts-brief gap; monitoring not yet operationalized).

## Exceptions

Temporary elevated (debug) logging for incident diagnosis must still exclude
secrets and PII, is time-boxed, and requires security-officer approval. Any other
exception requires written approval and is recorded.

## Review & enforcement

Reviewed at least annually and whenever the logging surface or monitoring backend
changes. A log entry that leaks a secret or PII is treated as an incident and the
offending code path is fixed immediately. Enforcement is technical (the scrubbing
seam, immutable grants) plus code review.

## SOC 2 mapping

Supports Common Criteria **CC7.2** (monitoring of the system for anomalies and
security events) and **CC7.3** (evaluation of events to determine response).
Cross-references: `docs/compliance/policies/01-access-control-policy.md`,
`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`.
