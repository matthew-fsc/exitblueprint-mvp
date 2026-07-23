# Backup Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually / on material change · **Applies to:** all Exit Blueprint personnel and systems.

## Purpose

Define how Exit Blueprint's data and configuration are backed up, what is and is
not covered, and how a restore is performed — so that client data can be
recovered after loss or corruption within stated targets. This is the
data-recovery control set supporting our SOC 2 Availability scope.

## Scope

The production system of record (Supabase Postgres and the document/object
store), application source code, and infrastructure/deployment configuration.
Backup infrastructure itself is inherited from our managed provider (Supabase);
this policy governs how we rely on and verify it, not the provider's internal
mechanics.

## Policy statements

1. **Managed database backups.** The production Postgres database is backed up by
   Supabase's managed backups with point-in-time recovery (PITR). Backups are
   encrypted at rest.
2. **Code and config are recreatable from source.** All application code and
   infrastructure configuration are versioned in git; the compute service is
   stateless and redeployable from source, so a running environment can be
   rebuilt without a separate server image backup.
3. **Encrypted documents remain recoverable, not readable, from backups.**
   Uploaded source documents are AES-256-GCM encrypted before storage, so backup
   copies contain only ciphertext; the decryption key (`EB_DOCUMENT_KEY`) is held
   separately in the secret store and is itself part of the recovery
   dependencies.
4. **What is not backed up by this mechanism.** Secrets and environment
   configuration live in managed secret stores (Render/Vercel/CI), not in the
   database backup; they are recovered from those stores. Client-side state and
   static frontend assets hold no data at rest and are rebuilt from git.
5. **Recovery targets.** Target **RPO ≤ 24 hours** (bounded tighter by PITR
   granularity within the retention window) and target **RTO ≤ 24 hours** for a
   full restore-and-redeploy. These are design targets for the initial report.
6. **Restore procedure.** Recovery is: restore Supabase to the required point in
   time, redeploy the compute service and frontend from git, restore secrets from
   the secret store, and re-point DNS. This is the same procedure of record as the
   BCP/DR plan.
7. **Recovery is tested.** A restore/DR test with a recorded last-tested date is
   performed on a defined cadence to validate the targets above.

## Roles & responsibilities

- **Security officer (Matthew):** owns backup reliance and recovery targets,
  initiates and records DR tests, executes or oversees restores during an
  incident.
- **Managed provider (Supabase):** performs and retains database backups and PITR
  per its attested controls and its contracted retention window.
- **Engineering:** keep code and infrastructure config fully reproducible from
  git so a redeploy needs no undocumented steps.

## Implementation / evidence

- ✅ **Managed Postgres backups + PITR** — provided by Supabase (managed);
  referenced in `docs/13-security-summary.md` and `docs/16-vendor-security-dd.md`
  §8.
- ✅ **Code/config in git, stateless redeployable compute** — the compute service
  (`server/http.ts`) is stateless and redeployable from source.
- ✅ **Document ciphertext in backups** — `server/documents/crypto.ts`
  (AES-256-GCM; key from `EB_DOCUMENT_KEY`, stored separately).
- 📄 **Restore procedure of record** — documented here and in the BCP/DR plan
  (`docs/compliance/policies/05-business-continuity-dr-plan.md`; interim
  reference: `docs/16-vendor-security-dd.md` §8).
- 🟡 **DR / restore test with a recorded last-tested date** — planned, not yet
  performed; last-tested date to be recorded once the first test runs
  (facts-brief gap #7).

## Exceptions

If a restore must deviate from the documented procedure during an incident (for
example, restoring a single tenant's rows rather than the whole database), the
deviation is recorded in the incident write-up. Any standing exception requires
security-officer approval.

## Review & enforcement

Reviewed at least annually and on any change to the database provider, retention
window, or recovery targets. The DR test result is recorded and reviewed; a
failed or stale test is remediated before the next review closes.

## SOC 2 mapping

Supports Availability criterion **A1.2** (backup and recovery / environmental
protections for availability) and Common Criteria **CC7** (recovery from
incidents affecting availability). Cross-references:
`docs/compliance/policies/05-business-continuity-dr-plan.md`,
`docs/compliance/policies/09-data-retention-disposal-policy.md`,
`docs/16-vendor-security-dd.md`.
