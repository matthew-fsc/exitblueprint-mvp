# 06 - Decision Log

Append-only. One line per decision: date, decision, reason. Claude Code adds entries when a session makes a call; Matthew adds entries when product behavior is decided.

- 2026-07-06 | Deterministic rule-based scoring, AI narrative-only | Explainability and reproducibility are credibility requirements with advisors; avoids hallucination risk with financial clients.
- 2026-07-06 | Rubric stored as data with rubric_versions | Methodology will evolve; old assessments must stay comparable against their version.
- 2026-07-06 | Engagement (not deal) as core unit; immutable assessment snapshots | Clients are 12-36 months pre-deal; longitudinal score data is the compounding asset.
- 2026-07-06 | Multi-tenant RLS by firm from S2 | Advisor firms are the distribution channel; retrofitting tenancy is high-risk.
- 2026-07-06 | Advisor workspace before owner portal | Advisors drive adoption and revenue; owners can be served manually during pilot.
- 2026-07-06 | Sub-scores are a first-class table between questions and dimensions | DRS methodology scores derived metrics (HHI, CAGR, ratios), not raw answers; matches Blueprint II exactly.
- 2026-07-06 | DRS = six business dimensions only; owner-side questions form separate ORI | Per Blueprint II composite formula; owner/business divergence is itself a diagnostic output.
- 2026-07-06 | Discrete band scoring, no interpolation, in v1 | Hand-verifiability of fixtures; interpolation available later as rubric version bump.
- 2026-07-06 | HHI estimated from top-5 shares in v1 | Exact HHI requires Blueprint I data ingestion; proxy documented in seed README.
- 2026-07-06 | Unknown NRR scores 25 with a not-tracked flag | Not measuring is worse than measuring badly, but not zero; Matthew to ratify.
- 2026-07-06 | EBITDA recast, EV, value-gap dollars deferred to post-v1 | Methodology documented in docs/07; v1 ships scoring, gaps, roadmap, narrative.
- 2026-07-07 | Restricted dev/CI runs migrations on plain Postgres via db/supabase-shim.sql (auth schema, roles, auth.uid()) | Docker/supabase CLI unavailable in the build container; migrations stay Supabase-canonical, shim skipped on real Supabase.
- 2026-07-07 | Engine rounding replicates Python round-half-even on the exact binary double (pyRound) | Reference scorer used Python round; fixture 3 ORI (40.25 -> 40.2) is irreproducible with JS default rounding.
- 2026-07-07 | ORI sub-scores persist to sub_score_results like business sub-scores; fixture sub_scores maps cover business dims only | Explain trace and owner-readiness reporting need the stored parts; matches reference which tracks ORI separately.
- 2026-07-07 | Not-tracked flag text derived from sub-score code suffix (REV-NRR -> "NRR not tracked") | Matches reference fixture output; revisit if flags need per-sub-score copy.
- 2026-07-07 | Dev-only "Phase 1 verification" page runs the pure engine in-browser on bundled seed rubric + fixtures | Visual acceptance evidence for Phase 1; production scoring still reads rubric from db; page carries a DEV label.
- 2026-07-07 | Outcome capture schema (engagement_outcomes, append-only outcome_events) ships in v1 with no UI | The moat dataset cannot be built retroactively; recorded only from advisor-reported facts, never backfilled.
- 2026-07-07 | Assessment immutability preserved via supersede pattern (record_status + linkage, active_assessments read path); no in-place edits, ever | Corrections create a new scored assessment; column named record_status because status tracks the intake lifecycle.
- 2026-07-07 | Deltas are same-rubric-version only; cross-version comparison returns an explicit incomparable marker | Cross-version comparison deferred to a rescore-as-derived-data feature that never mutates the original snapshot.
- 2026-07-07 | Firm/advisor/owner provisioning is CLI-only (scripts/admin.ts) through MVP | Admin UI is out of scope until requested; S5 builds login + advisor shell only.
- 2026-07-07 | Demo tenant is seed data (seed/demo + scripts/seed-demo.ts), distinct from correctness fixtures | Demo tells the longitudinal story (59.9 Needs Work -> 72.3 Sale Ready, 6 gaps resolved); validated against the reference scorer inside the seed script, not the test suite.
