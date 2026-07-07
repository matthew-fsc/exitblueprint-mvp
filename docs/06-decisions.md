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
