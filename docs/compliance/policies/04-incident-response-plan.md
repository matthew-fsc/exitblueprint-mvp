# Incident Response Plan

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually and on material change · **Applies to:** all Exit Blueprint personnel and production systems.

## Purpose

Define how Exit Blueprint detects, classifies, responds to, and learns from
security and availability incidents affecting the platform or its client data.
The goal is fast, consistent handling that limits harm, preserves evidence, and
meets our notification commitments — right-sized for a small, remote,
cloud-native team.

## Scope

All confirmed or suspected events that threaten the confidentiality, integrity,
or availability of the Exit Blueprint application, its production data plane
(Supabase, Clerk, Render, Vercel, Stripe, Anthropic — see docs/16), or client
data held within it. Covers technical incidents (breach, data exposure,
outage, malware, credential compromise) and process failures that carry the
same risk. Excludes routine, non-security operational tasks.

## Policy statements

1. Every suspected incident is triaged, assigned a severity, and owned by a
   single incident commander until closed.
2. Incidents are recorded in an incident register from detection through
   post-mortem; the register is the system of record.
3. Evidence (logs, timestamps, affected records) is preserved before
   remediation destroys it.
4. Confirmed breaches of client data trigger notification per the commitment
   below: **within 30 days of discovery, targeting 72 hours.**
5. Every SEV1/SEV2 closes with a blameless post-incident review whose action
   items are tracked to completion.

### Severity classification

| Severity | Definition | Examples | Target response |
| --- | --- | --- | --- |
| **SEV1** | Confirmed or likely exposure/loss of client data, or full production outage | Cross-tenant data leak, RLS bypass, database compromise, signing/document key exposure, total unavailability | Immediate; commander engaged within 1 hour of discovery |
| **SEV2** | Security control failure or partial outage without confirmed data exposure | Auth degradation, single-tenant outage, exploitable vulnerability in production, suspicious privileged access | Same business day |
| **SEV3** | Low-impact or contained issue, or near-miss | Isolated failed-auth anomaly, non-exploitable finding, degraded non-critical dependency | Within 3 business days |

Severity can be raised or lowered as facts change; changes are logged in the register.

### Detection sources

- **Sentry** error monitoring and structured request logging
  (`server/observability.ts`) — active once `SENTRY_DSN` is set; scrubs
  secrets/PII. ✅ seam in place; 🟡 alerting is dormant until the DSN is configured.
- **Managed-provider alerts** — Supabase, Render, Vercel, Clerk, Stripe status
  and security notifications (inherited monitoring).
- **Audit-log anomalies** — unexpected reads/downloads in the append-only
  `data_access_log` and answer-provenance mutations in
  `answer_provenance_events` (`server/audit.ts`). ✅
- **User / firm reports** — advisors or owners reporting suspected issues.
- **CI signals** — failing RLS isolation suite or scoring-fixture tests on a PR
  (`.github/workflows/ci.yml`). ✅

## Roles & responsibilities

- **Incident Commander — Matthew (currently).** Owns triage, severity, the
  response, communications, and closure. Holds the security-officer /
  CISO-equivalent role today; 🟡 a dedicated role is planned as the team grows.
- **Engineering (Matthew / any on-call engineer).** Executes containment,
  eradication, and recovery; preserves evidence.
- **Communications (Matthew).** Owns notification to affected firms, and any
  regulator or provider, on the commander's decision.
- **All personnel.** Must report a suspected incident to the commander without
  delay; no one is penalized for reporting in good faith.

## Response lifecycle (runbook)

1. **Identify.** Confirm the event is a real incident. Record it in the register
   with time of discovery, reporter, and initial severity. Open a private
   channel/thread for coordination.
2. **Contain.** Stop the bleeding without destroying evidence: revoke or rotate
   compromised credentials (Clerk sessions, `EB_DOCUMENT_KEY`, `EB_SIGNING_KEY`,
   provider API keys), disable an affected route, or block an actor. Snapshot
   affected data first.
3. **Eradicate.** Remove the root cause — patch the vulnerability, revoke
   attacker access, purge malicious artifacts. Land the fix through the normal
   PR + CI gate unless the severity justifies an emergency change (documented
   after the fact).
4. **Recover.** Restore service and verify integrity: confirm RLS isolation
   (`npm run test:rls`), scoring fixtures (`npm test`), and a clean build.
   For data loss, follow the DR restore procedure (policy 05).
5. **Post-mortem.** Within 5 business days of closing a SEV1/SEV2, hold a
   blameless review (below) and file action items.

### Evidence preservation

Before remediation, capture: relevant `data_access_log` /
`answer_provenance_events` rows, Sentry events, provider logs, affected record
IDs and firm scope, timestamps, and the commander's contemporaneous notes.
Store artifacts under `docs/compliance/evidence/` referenced from the register
entry. Never alter logs; the audit tables are append-only by design. ✅

## Communication plan

- **Internal:** the incident channel/thread is the single source of truth
  during an active incident; the register is updated at each phase transition.
- **Affected firms (customers):** notified by the Communications owner once
  scope is understood, with what happened, what data was involved, what we did,
  and what they should do.
- **Regulators:** Exit Blueprint is a software vendor, not a regulated financial
  entity; where a firm's own regulatory notification obligations are triggered,
  we support the firm with the facts they need to meet them.
- **Providers:** report to the relevant sub-processor when the incident
  originates in or affects their platform.

### Breach notification commitment

On a confirmed breach of client data, Exit Blueprint notifies affected firms
**within 30 days of discovery, targeting 72 hours.** This is committed as
standard contractual language.

- Status: 📄 committed as our process and standard clause. 🟡 the contract
  template carrying the clause is being finalized (facts brief gap #5;
  docs/16 §5).

## Blameless post-incident review

For every SEV1/SEV2 (and any SEV3 with a useful lesson): reconstruct the
timeline, identify contributing causes without assigning individual blame,
capture what detection/response worked and what did not, and record concrete
action items with owners and due dates. Action items are tracked to closure and
reviewed in the annual policy review. The written review is filed with the
register entry.

## Incident register

A running log of all incidents: ID, discovery date, reporter, severity, summary,
affected firms/data, response actions, resolution date, and post-mortem link.
This plan establishes the register.

- Status: 📄 register defined by this policy; maintained under
  `docs/compliance/evidence/`. 🟡 no incidents logged to date (no incident has
  occurred).

## Implementation / evidence

- Detection seam — Sentry: `server/observability.ts` (✅ seam; 🟡 dormant until `SENTRY_DSN` set).
- Audit trail: `server/audit.ts`, tables `data_access_log`, `answer_provenance_events` (✅).
- CI safety gates: `.github/workflows/ci.yml`, `scripts/rls-test.ts` (✅).
- Credential rotation targets: `EB_DOCUMENT_KEY`, `EB_SIGNING_KEY`, Clerk/provider keys (✅ managed via env secret stores; hard-fail at startup if missing — `server/http.ts`).
- Register + evidence store: `docs/compliance/evidence/` (📄).
- Breach-notification clause: 🟡 being finalized in the contract template.

## Exceptions

Any deviation (e.g. an emergency change bypassing normal review) must be
approved by the incident commander and documented in the register with
rationale. There is no standing exception to the notification commitment.

## Review & enforcement

Reviewed at least annually and after any SEV1/SEV2 incident or material infra
change. The incident commander enforces this plan; failure to report a known
incident is a policy violation handled under the HR Security Policy (policy 14).

## SOC 2 mapping

Supports Common Criteria CC7.3 (evaluate security events), CC7.4 (respond to
incidents), and CC7.5 (recover from incidents). Cross-references: policy 05
(BCP/DR), policy 06 (vendor risk), docs/13, docs/16.
