# Data Retention & Disposal Policy

**Owner:** Matthew (matthew@fracturesystems.com) · **Version:** 1.0 · **Effective:** 2026-07-23 · **Review:** annually / on material change · **Applies to:** all Exit Blueprint personnel and systems.

## Purpose

Define how long Exit Blueprint retains client data, how immutable history is
preserved, and how data is exported and securely destroyed at the end of an
engagement — so that data is kept exactly as long as it is needed and disposed of
responsibly. This is the confidentiality/retention control set supporting our
SOC 2 Confidentiality scope.

## Scope

All client data held in the system of record: engagements, assessments, answers,
documents, reports, and the readiness score history, plus the per-tenant exports
and deletions performed at termination. Firm billing data held by Stripe is
governed by Stripe's own retention. Backup aging is governed by the managed
provider's retention window (see the Backup Policy).

## Policy statements

1. **Retain for the life of the engagement and its readiness history.** Client
   records are retained for the duration of the advisory engagement and its
   readiness history, which is the product's core purpose (12–36 month pre-deal
   engagements re-assessed over time).
2. **Assessments are immutable snapshots.** Assessments are immutable snapshots
   tied to a rubric version; corrections create a new version rather than
   mutating history. Score history and deltas are preserved as a matter of
   design.
3. **Orderly termination.** On termination, a firm's data is first exported and
   then destroyed per the firm's instruction. The firm-scoped schema makes a
   clean per-tenant export and delete tractable.
4. **Standard export formats.** Exports are provided in industry-standard,
   non-proprietary formats: structured data as CSV/JSON and documents in their
   original format. Nothing is locked in a proprietary container.
5. **Secure disposal.** On request or at end of retention, a firm's records are
   deleted via a firm-scoped cascade. Encrypted document copies in backups age
   out per the Supabase retention window and cannot be read once the separately
   held encryption key is gone.
6. **Scoped to the tenant.** Every export and deletion is `firm_id`-scoped; no
   operation crosses tenants.

## Roles & responsibilities

- **Security officer (Matthew):** approves and oversees terminations, exports,
  and deletions; confirms the firm's disposition instruction before destruction.
- **Advisor firm (customer):** instructs whether data is returned, destroyed, or
  both at termination.
- **Engineering:** performs firm-scoped export and cascade deletion; ensures
  operations stay within tenant scope.

## Implementation / evidence

- ✅ **Immutable assessment snapshots** — assessments tied to a `rubric_version`;
  corrections create a new version (CLAUDE.md rule 4; `docs/13-security-summary.md`).
- ✅ **Firm-scoped isolation enabling clean per-tenant export/delete** — `firm_id`
  + RLS on every domain table; verified by `npm run test:rls`
  (`scripts/rls-test.ts`).
- ✅ **Documents recoverable only as ciphertext without the key** —
  `server/documents/crypto.ts` (AES-256-GCM; key held separately).
- 📄 **Orderly termination — export then destroy per instruction** — process of
  record (this policy; `docs/16-vendor-security-dd.md` §9). Handled operationally
  today.
- 📄 **Backup aging per provider retention window** — Supabase managed retention
  (see `docs/compliance/policies/12-backup-policy.md`).
- 🟡 **Self-serve, audited export + purge admin action** — one-click audited
  export/purge is a tracked roadmap item; export and deletion are handled
  operationally in the interim (facts-brief gap #8; `docs/16-vendor-security-dd.md`
  §9).

## Exceptions

Data may be retained beyond the stated period only where required to meet a legal
hold or a contractual obligation; such holds are recorded and approved by the
security officer. Any other exception requires written approval.

## Review & enforcement

Reviewed at least annually and on any change to the retention model or export
tooling. A deletion that leaves recoverable readable data (outside the normal
backup-aging window with the key destroyed) is treated as an incident and
remediated. Enforcement is procedural today and becomes technical when the
self-serve audited purge ships.

## SOC 2 mapping

Supports Confidentiality criterion **C1.2** (disposal of confidential information
to meet objectives) and Common Criterion **CC6.5** (discontinuing logical access
and disposing of data when no longer required). Cross-references:
`docs/compliance/policies/12-backup-policy.md`,
`docs/compliance/policies/01-access-control-policy.md`,
`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`.
