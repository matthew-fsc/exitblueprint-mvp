# Change Management Policy

| | |
| --- | --- |
| **Policy** | Change Management |
| **Owner** | Matthew (matthew@fracturesystems.com) |
| **Version** | 1.0 |
| **Effective** | 2026-07-23 |
| **Review** | Annually / on material change |
| **Applies to** | All Exit Blueprint personnel and systems |

## Purpose

Ensure that every change to Exit Blueprint's application code, database schema,
and infrastructure configuration is made deliberately, reviewed, automatically
tested, and traceable — so that changes do not degrade security, tenant
isolation, or scoring integrity, and so that any change can be reconstructed or
reverted from source control.

## Scope

All changes to the audited system: the React + Vite frontend, the Node compute
service (`server/http.ts`), database migrations, seed/methodology data, CI
configuration, and deployment configuration. Configuration held in managed
providers (Render, Vercel, Supabase, Clerk) is changed through those providers'
consoles by authorized personnel and is covered by the same review intent, even
where it is not expressed as a git commit.

## Policy statements

1. **All code changes flow through GitHub pull requests to `main`.** Direct
   pushes that bypass review and CI are not an accepted path for production
   changes. `main` is the deployable branch.
2. **One branch per build-plan slice.** Work happens on a feature branch scoped
   to a single slice (CLAUDE.md, "Working in parallel"). Agents/authors check
   open branches and PRs before starting so two people do not build the same
   slice, and never push to another author's branch.
3. **Green CI is the merge gate.** A PR may not merge unless the CI pipeline
   (`.github/workflows/ci.yml`) passes in full. The pipeline runs on every pull
   request and on push to `main`, and executes, in order:
   - migrations applied to a **fresh** Postgres database (`npm run db:migrate`),
   - the **RLS firm-isolation** suite (`npm run test:rls`),
   - **seed idempotency** — seeds run twice and must be stable (`npm run db:seed`
     twice; `npm run seed:demo` twice, which also validates against the
     reference scorer),
   - the **scoring-fixture** tests, which must reproduce `seed/fixtures`
     exactly (`npm test`),
   - the **extraction eval** (`npm run eval`),
   - the production **build** (`npm run build`).
4. **Code review before merge.** A PR is reviewed before it merges. Review
   confirms the change is in scope for its slice, follows the established
   patterns (`docs/27-engineering-patterns.md`), does not weaken the
   non-negotiable architecture rules in CLAUDE.md, and carries the evidence the
   "Definition of done" requires.
5. **Definition of done is mandatory.** Before a change is considered complete
   (CLAUDE.md, "Definition of done"): `npm run build`, `npm test`, and
   `npm run test:rls` pass; migrations and seeds apply cleanly to an empty
   database; `npm run eval` runs if the AI/narrative layer was touched; and a
   one-line entry is appended to `docs/06-decisions.md` when a decision was made.
6. **Migration discipline.** Schema changes are made only through migration
   files, never by manual edits to a live database (CLAUDE.md rule; docs/02).
   Migration filenames use a full UTC timestamp taken at creation
   (`YYYYMMDDHHMMSS_name.sql`) — never a hand-picked sequential number, which
   races across parallel branches.
7. **Immutable data model.** Completed assessments are never mutated;
   corrections create a new immutable snapshot tied to a `rubric_version`
   (CLAUDE.md rule 4). Change management therefore never includes in-place
   edits to historical scoring records.
8. **High-contention files are union-merged, not overwritten.** Append-only logs
   and shared maps (`docs/06-decisions.md`, `docs/README.md`,
   `docs/28-architecture-map.md`, `src/styles.css`, nav) are resolved by keeping
   both sides on conflict.

## Roles & responsibilities

- **Change owner / approver (Matthew):** owns this policy; reviews and approves
  PRs; is the final arbiter on scope and product-behavior questions.
- **Author (any contributor or Claude Code agent):** opens a scoped branch,
  meets the Definition of done, opens a PR, and does not merge until CI is green
  and the change is reviewed.
- **CI system (GitHub Actions):** enforces the automated merge gate; its result
  is authoritative and is not overridden manually.

## Implementation / evidence

- ✅ **Required CI pipeline** — `.github/workflows/ci.yml` runs migrations on a
  fresh DB, the RLS suite, seed idempotency, scoring fixtures, the eval, and the
  build on every PR.
- ✅ **RLS isolation gate** — `scripts/rls-test.ts` (`npm run test:rls`).
- ✅ **Deterministic-scoring gate** — fixtures in `seed/fixtures/` and the
  reference implementation `seed/fixtures/reference_scorer.py` (`npm test`).
- ✅ **Migration-only schema changes** — migrations directory with timestamped
  filenames; applied by `server/migrate.ts` (`npm run db:migrate`).
- 📄 **PR + review-before-merge workflow** — this policy and CLAUDE.md
  ("Working agreements", "Working in parallel", "Definition of done") establish
  the process; it is followed by people, backed by the automated gate above.
- 📄 **Decision log** — `docs/06-decisions.md`, appended per change that makes a
  decision.
- 🟡 **Two-person review (separation of author and approver)** — on the current
  small team the same person may both author and approve a change. This is an
  honest limitation: enforced branch protection requiring an independent
  reviewer is planned as the team grows past a single maintainer. Compensating
  controls today are the automated CI gate (which no single author can silence)
  and the immutable, versioned data model.
- 🟡 **Automated dependency/vulnerability scan in CI** — `npm audit` currently
  reports 0 vulnerabilities when run manually; wiring it into CI as a blocking
  step is the named next CI hardening item (see
  `docs/compliance/policies/15-vulnerability-management-policy.md`).

## Rollback

Rollback is redeploy of a prior known-good git commit — the compute service is
stateless and redeployable from source, and the frontend is static. Because the
data model is immutable (assessments are append-only snapshots), a code rollback
never has to "undo" mutated history; it only reverts behavior. A schema change is
reverted with a new forward migration, not by editing the database by hand.
Managed-provider state (Supabase data) is recoverable via managed backups and
point-in-time recovery (see docs/16 §8).

## Emergency change process

When a fix must ship faster than the normal slice cadence (e.g. a security or
availability incident):

1. The change is still made on a branch and opened as a PR — no direct-to-`main`
   exception.
2. CI must still pass; the automated gate is never bypassed, because it is the
   control that protects tenant isolation and scoring integrity.
3. Review may be expedited, and where the author and approver are the same
   person the change is self-reviewed against this policy and the Definition of
   done, with a decision-log entry recording the emergency rationale.
4. The change is followed up post-incident: a decision-log entry and, if the
   root cause warrants, a hardening PR through the normal path.

## Exceptions

Exceptions to this policy require the policy owner's (Matthew's) explicit
approval and are recorded in `docs/06-decisions.md` with the rationale and any
compensating control. The CI merge gate is not a permitted exception target.

## Review & enforcement

Reviewed at least annually and on material change to the toolchain or team
structure. Enforcement is primarily automated (the CI merge gate); process
elements are enforced by the policy owner during review. Repeated bypass of the
PR/CI path is a policy violation.

## SOC 2 mapping

Supports **CC8.1** (change management — changes are authorized, designed,
developed/configured, tested, approved, and implemented in a controlled manner).
Cross-references: `docs/compliance/policies/03-secure-development-policy.md`,
`docs/16-vendor-security-dd.md`, CLAUDE.md.
