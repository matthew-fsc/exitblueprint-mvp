# 23 — Posture vs. Vision: Infrastructure Strength (and the immutability build)

The vision (docs/20) makes strong claims — "defensible evidence," "immutable
history," "records that withstand institutional diligence," "multi-tenant RLS
everywhere," "deterministic scoring." This is an honest audit of each load-bearing
claim against what the **infrastructure actually enforces**, and a build where the
gap between claim and guarantee was real. The lens is deliberately not features
(docs/21 covers those) — it is: *if a buyer's technical diligence or a security
reviewer probed this pillar, would it hold?*

## Posture read — claim vs. guarantee

| Vision pillar | What the infrastructure actually does | Verdict |
|---|---|---|
| **Deterministic scoring** (rule 1) | `seed:demo` validates the engine against `reference_scorer.py` on every CI run; fixtures must match exactly; extraction `eval` gates regressions | **Strong** — real, CI-enforced |
| **Multi-tenant isolation** (rule 5) | Per-table RLS policies; `rls-test` exercises firm isolation across every domain table (77 checks) | **Strong** — real, regression-tested |
| **Audit history** | `logAccess` writes `data_access_log` on function-call access (server/http.ts); `usage_events` captured client-side | **Adequate** — wired, not decorative |
| **Defensible evidence / immutable history** (rule 4) | *Was* convention only — see below | **Was the thin spot → now enforced** |
| **Institutional knowledge graph** | `graph_nodes/edges` are substrate; the connected chain is assembled deterministically over source tables (docs/21 choice), not materialized | **Intentionally thin** — fine for now |
| **Outcome calibration** | Substrate + capture built (deal_outcomes, prediction snapshot); aggregate read not yet | **Progressing** |
| **AI as institutional reviewer** | Narrative generation only; the reviewer that surfaces blind spots is not built | **Deferred** (phase 4) |

Most pillars hold. One did not, and it is one of the most-cited in the vision.

## The gap: "immutable" was a habit, not a guarantee

Rule 4 and docs/20 promise that a completed assessment is an **immutable
snapshot** — "never update a completed assessment; create a new one" — and that
the record is **defensible**. In the server this was honored: `server/scoring.ts`
throws on re-scoring a completed assessment; `server/ledger.ts` refuses to modify
one. But those are application-code guards. At the **data layer**, the
`advisor_firm_all` policy on `assessments`, `answers`, `sub_score_results`, and
`dimension_scores` is `for all` — so a client holding a valid advisor JWT could
`UPDATE` a finalized `drs_score`, rewrite the answers behind it, or `DELETE` the
snapshot outright, straight through PostgREST, with **no supersede record**.

A diligence reviewer asking *"can a user alter a finalized score after the fact?"*
would have found: yes. That guts the "immutable / version-controlled / defensible"
claim — precisely the claim the platform's credibility rests on.

## The build: database-enforced, role-scoped immutability

`supabase/migrations/20260718000200_immutable_assessments.sql` moves the rule from
convention to guarantee with triggers (not RLS, so it holds regardless of the
policy set):

- A completed assessment **cannot be updated or deleted**, and its scored
  children (`answers`, `sub_score_results`, `dimension_scores`) **cannot be
  updated or deleted**, once the parent is `completed`.
- Enforcement is **role-scoped to the untrusted path**: the triggers constrain
  `authenticated` / `anon` (an end-user JWT via PostgREST) — the actual tampering
  surface. The trusted backend (`service_role`) and admin/superuser maintenance
  pass through, because corrections are orchestrated **server-side as supersede**
  (a new assessment, the old one marked `superseded`), and tenant offboarding /
  backfills must remain possible. This matches the threat model exactly: close
  the client-side hole, keep the legitimate server and admin paths working.
- **Scoring is unaffected**: the engine INSERTs sub-scores while the row is
  `in_progress` and flips `status` to `completed` last; INSERTs are never frozen.

### Why triggers, and why role-scoped

RLS can restrict *which rows* a role writes, but not cleanly express "a completed
row is frozen except via the server's supersede path." Triggers express exactly
that, apply to any writer, and — gated on `current_user` — draw the trust boundary
where it actually is: the end-user JWT is untrusted; the backend service and DBA
are trusted. A physical DB guarantee for the untrusted role is the honest answer to
the diligence question, without breaking supersede, offboarding, or maintenance.

## Verification

Full CI pipeline, fresh database, exact CI order:

- `test:rls` — **77 checks pass** (+6 immutability: an `authenticated` advisor
  cannot edit a completed score, delete the assessment, edit/delete its
  sub-scores/dimension-scores/answers, or supersede it via a client write).
- `npm test` — **202 pass** (the DB-integration suites run as the superuser, are
  correctly exempt, and their score→supersede→teardown flows are unaffected).
- `seed`/`seed:demo` ×2 idempotent; `eval` 8/8; `tsc` clean; `build` clean.

Direct SQL against seeded data confirmed each freeze fires and that the
server-side supersede bookkeeping update still lands.

## Not built this pass (recorded)

- **Aggregate outcome-calibration read** — the payoff of the capture substrate.
- **AI institutional reviewer** — the phase-4 pillar; still narrative-only.
- **Knowledge graph materialization** — deliberately deferred; the deterministic
  chain (docs/21) is the current, lower-risk substitute.

These are depth on pillars that already hold. Immutability was the one where the
claim outran the guarantee — so that is where the strength was built.
