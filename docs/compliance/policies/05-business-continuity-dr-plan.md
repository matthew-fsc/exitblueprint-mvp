# Business Continuity & Disaster Recovery Plan

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually and on material infrastructure change · **Applies to:** all Exit Blueprint production systems and personnel.

## Purpose

Ensure Exit Blueprint can recover its service and client data after a disruptive
event — provider outage, data loss, or compromise — within defined targets, and
resume normal operation in an orderly way. Right-sized for a cloud-native remote
startup running entirely on managed providers: there are no data centers,
corporate LAN, or on-prem servers to recover.

## Scope

The Exit Blueprint application and its production data plane: the Supabase
database and storage (system of record), the Node compute service on Render,
the static frontend on Vercel, and identity via Clerk. Billing (Stripe) and
narrative drafting (Anthropic) are non-critical to core availability and degrade
gracefully. Sub-processor resilience is inherited (see docs/16 and policy 06).

## Architecture that makes recovery cheap

- **Stateless compute.** The Node service (`server/http.ts`) holds no durable
  state and is redeployable from git. It runs behind a host-portable seam
  (`FunctionContext`), so moving hosts requires config, not code changes. ✅
- **Static frontend.** The React + Vite SPA on Vercel holds no client data at
  rest; it is a rebuild-and-redeploy artifact. ✅
- **Durable system of record.** All client data lives in Supabase managed
  Postgres with automated backups and point-in-time recovery (PITR). Documents
  are stored AES-256-GCM encrypted (`server/documents/crypto.ts`), so restored
  bytes remain protected. ✅
- **Everything reproducible from source.** Schema is migrations
  (`npm run db:migrate`), seed data is idempotent (`npm run db:seed`), and infra
  config lives in env secret stores — no snowflake state to reconstruct. ✅

## Policy statements

1. Client data is protected by managed backups + PITR sufficient to meet the
   RPO below.
2. The service can be fully restored from git + a Supabase point-in-time restore
   without bespoke, undocumented steps.
3. Recovery targets (RTO/RPO) are defined, and the recovery procedure is
   documented and testable.
4. The plan is validated by a periodic DR test with a recorded last-tested date.
5. The plan is reviewed on every material infrastructure change and at least
   annually.

### Recovery targets

- **RTO (Recovery Time Objective): 8 hours.** Justification: recovery is
  redeploy-from-git plus a Supabase point-in-time restore — both are managed
  operations measured in minutes-to-hours, not days. The 8-hour target leaves
  ample margin for a single operator (Matthew) to diagnose, restore, verify
  isolation and scoring, and re-point DNS, even outside business hours.
- **RPO (Recovery Point Objective): 1 hour.** Justification: Supabase PITR
  allows restore to a granular point in time, so realistic data loss on a clean
  restore is well under an hour. We state 1 hour as the committed target; daily
  automated backups are the fallback floor if PITR is unavailable for a given
  incident.

These are concrete targets for the current single-operator, single-region
posture and will be tightened as the team and tooling grow.

## Recovery procedure (runbook)

1. **Declare.** Open an incident (policy 04), assign severity, and record the
   disruption's scope and start time.
2. **Assess.** Determine what is lost or degraded: data (Supabase), compute
   (Render), frontend (Vercel), or identity (Clerk).
3. **Restore data.** If data is corrupted or lost, restore Supabase to a point
   in time just before the event (PITR), or to the latest good automated backup.
4. **Redeploy compute.** Redeploy the Node service from git to Render (or an
   alternate host via the `FunctionContext` seam). Confirm required secrets
   (`EB_DOCUMENT_KEY`, `EB_SIGNING_KEY`, provider keys) are present — the service
   hard-fails at startup if they are missing (`server/http.ts`).
5. **Redeploy frontend.** Rebuild and redeploy the SPA to Vercel (or alternate
   static host).
6. **Re-point DNS.** Update DNS to the recovered endpoints if hosts changed.
7. **Verify integrity.** Run `npm run test:rls` (tenant isolation) and
   `npm test` (scoring fixtures reproduce exactly); confirm a clean build and a
   smoke test of sign-in, an assessment read, and a signed document download.
8. **Resume & record.** Return to normal operation; log recovery time and any
   data-loss window in the incident register for RTO/RPO measurement.

## Single-region posture & future stance

The platform runs in a single US region (Supabase US region; US-based
sub-processors). This satisfies data-residency expectations and keeps the
architecture simple. Multi-region active-active is **out of scope today** and is
the documented future stance to raise availability as customer requirements
demand it. A regional provider outage is mitigated by PITR/backups plus
redeploy, within the RTO above, not by live failover.

## Dependency on managed providers

Underlying resilience — hardware redundancy, volume durability, backup
infrastructure, network and DDoS protection, patching — is inherited from
Supabase, Render, Vercel, and Clerk, each of which maintains its own SOC 2 Type
II attestation (`seed/subprocessors.csv`). We monitor provider status and depend
on their published availability commitments; provider resilience is reviewed as
part of vendor risk management (policy 06).

## DR test

The recovery procedure is validated by a scheduled DR test that exercises a
point-in-time restore into a scratch environment and a redeploy, with the
outcome and **last-tested date** recorded here. Auditors specifically ask for
test cadence; the intended cadence is at least annually and after any material
infra change.

- Status: 🟡 planned. **Last tested: not yet performed** (facts brief gap #7;
  docs/16 §8). This is the primary open item on this plan.

## Roles & responsibilities

- **Matthew** — declares disasters, owns and executes the recovery procedure,
  schedules and records the DR test, and owns this plan.
- **Managed providers** — deliver the inherited backup, durability, and
  infrastructure resilience described above.

## Implementation / evidence

- Backups + PITR: Supabase managed (📄 provider-inherited; verifiable in the Supabase console).
- Stateless redeploy seam: `server/http.ts`, `FunctionContext` (✅).
- Reproducible schema/seed: `npm run db:migrate`, `npm run db:seed` (✅).
- Post-restore integrity gates: `scripts/rls-test.ts`, `npm test`, `seed/fixtures/reference_scorer.py` (✅).
- Encrypted-at-rest documents survive restore: `server/documents/crypto.ts` (✅).
- Recovery targets: RTO 8h / RPO 1h (📄 defined here).
- DR test with recorded last-tested date (🟡 planned, not yet performed).

## Exceptions

Any deviation from the recovery procedure during a live event is at the
incident commander's discretion and must be documented in the incident register.
There is no standing exception to the backup/PITR requirement.

## Review & enforcement

Reviewed on every material infrastructure change and at least annually, and
updated after each DR test or real recovery. Matthew enforces the plan.

## SOC 2 mapping

Supports Availability criteria A1.1 (capacity and environmental protection via
managed providers), A1.2 (backups, recovery infrastructure, and recovery
procedures), and A1.3 (recovery testing). Cross-references: policy 04 (incident
response), policy 06 (vendor risk), docs/13, docs/16.
