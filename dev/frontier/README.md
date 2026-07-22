# `dev/frontier/` — R&D spikes (NOT production)

Isolated, runnable prototypes that explore where the platform goes next. Nothing
here is wired into the app: not the function registry, nav, migrations, or seed.
`dev/` is outside both `tsconfig` includes, so these files never enter
`npm run build` / `npm test`. They exist to make a strategic idea concrete and
demonstrable before anyone commits to productionizing it.

Everything here honors the non-negotiables in `../../CLAUDE.md` — deterministic
scoring (rule 1), AI-narrative-only (rule 2), rubric-lives-in-data (rule 3),
immutable assessments (rule 4), multi-tenant RLS (rule 5) — because a spike that
violates them can't ship, so it isn't worth prototyping.

## Frontier assessment — the three highest-leverage directions

Grounded in the data moats (`docs/09-moats.md`) and the horizon frame
(`docs/40-vision-and-business-integration.md`), tied to the six engines
(`docs/28-architecture-map.md`):

1. **Outcome-calibration loop (moat 1)** — *built below.* Every DRS is a
   prediction; almost nobody records what actually happened at close and feeds
   it back. Closing that loop turns the DRS from an opinion into an empirically
   calibrated instrument ("DRS 85–100 closed at 6.9x, 80% within range"). It is
   the moat that compounds fastest and underwrites the fundraising thesis
   (`docs/40 §4a`). Highest leverage → prototyped.
2. **Engagement-graph next-best-action (moat 3)** — `server/engagement-graph.ts`
   already captures the graph of engagements, gaps, plans, and tasks. Mining
   which remediation sequences actually moved a DRS band-to-band would let the
   Roadmap recommend from evidence ("firms like this closed the ops gap first")
   rather than static rules. Deterministic, narrative-only surfacing.
3. **Financial-corpus comparables sharpening (moat 2)** — `server/financial-corpus.ts`
   + `server/comparables.ts` hold the private multiples corpus; a de-identified,
   n-gated benchmarking read (still out-of-scope for prod until requested) would
   tighten valuation ranges beyond public comps.

Directions 2 and 3 are noted for a later spike; direction 1 is implemented here.

## What's built: the DRS Calibration Engine (`calibration/`)

- `types.ts` — local mirrors of the production tables it would read
  (`deal_outcomes`, the versioned valuation rule). Intentionally decoupled — no
  app imports.
- `engine.ts` — three pure, deterministic functions:
  1. `calibrationTable()` — the empirical per-band readout (realized multiple
     distribution, within-predicted-range hit rate, EV variance, retrade rate),
     with an explicit confidence gate on `n` (`MIN_CONFIDENT_N`).
  2. `calibrationDiagnostics()` — headline reliability of the DRS as a predictor
     (overall mean |EV variance|, within-range hit rate, per-band directional bias).
  3. `proposeRecalibration()` — a **draft** proposal to supersede the current
     valuation rule: damped, dead-banded, clamped nudges to the readiness
     multiple per confident band. `applied: false`, `requires_human_review: true`,
     always. It never edits a score or a rubric.
- `demo.ts` — a standalone runner over a deterministic synthetic corpus.

### Run it

```bash
npx tsx dev/frontier/calibration/demo.ts
# or, Node 22+ with native type-stripping:
node --experimental-strip-types dev/frontier/calibration/demo.ts
```

The synthetic corpus deliberately encodes a rubric that under-predicts the
top band, so the demo shows the engine detecting the bias and proposing a
gated multiple bump for `sale_ready` while leaving well-calibrated bands alone.

### What productionizing would take

- A `deal_outcomes` table (frozen prediction snapshot + advisor-reported reality),
  firm-scoped under RLS; the engine runs on the service-role `analytics` path
  behind the superadmin gate, like `server/moat-metrics.ts` (rule 5).
- The proposal becomes a real `valuation_rules_version` candidate surfaced in an
  admin review UI; accepting it inserts a **new** version — prior assessments keep
  their original version (rules 1 & 4). No live edits, ever.
- A narrative seam may *describe* the table/proposal; it never generates the
  numbers (rule 2).
