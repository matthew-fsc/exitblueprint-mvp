# Seed Data - CANONICAL DRS METHODOLOGY (v1.0)

This folder is generated from Matthew's DRS methodology (Blueprint II: Ontology to Insight).
It is real, load-ready seed data - not templates. Weights, bands, and thresholds are canonical.

## Files

1. **drs-rubric-dimensions.csv** - 9 dimensions. Six business dimensions carry DRS weights
   (REV .25, FIN .20, OPS .20, CUS .15, MGT .10, GRW .10). Three owner dimensions
   (GOL, PFN, VAL) are score_group=owner_readiness and roll into the Owner Readiness
   Index (ORI), never into the DRS.
2. **drs-rubric-questions.csv** - intake inputs. scored=True questions feed sub-scores;
   scored=False questions are context captured for the narrative layer and buyer prep.
3. **drs-rubric-subscores.csv** - 26 business sub-scores + 6 ORI sub-scores with exact
   weights, formula types, and band logic from the methodology.
4. **gap-definitions.csv** - 24 gaps with triggers (mostly sub_score_below 70, per the
   methodology rule that any sub-score under 70 generates a buyer question).
5. **playbooks/** - 13 remediation playbooks with roadmap phase, EV impact language from
   the initiative impact table, and task templates.
6. **content-modules.csv** - buyer question prep modules (question / response framework /
   documentation needed, verbatim structure from the methodology) plus education modules.
7. **gap-playbook-map.csv / gap-content-map.csv** - wiring.
8. **fixtures/** - three fictional companies with full answers and expected outputs,
   plus reference_scorer.py, the executable reference implementation of the scoring
   logic. The production engine is correct when it reproduces these outputs exactly.

## Fixture expected results

| Company | DRS | Tier | ORI |
|---|---|---|---|
| Meridian Managed IT | 82.6 | Sale Ready | 79.2 |
| Apex Fabrication | 16.1 | Not Saleable (Yet) | 7.8 |
| Harborview Staffing | 52.0 | High Risk | 40.2 |

## v1 conventions (deliberate, revisit later)

- **Discrete bands, no interpolation.** The methodology allows linear interpolation
  within recurring-revenue bands; v1 uses discrete band points everywhere for hand-
  verifiability. Flip on interpolation as a rubric version bump if desired.
- **HHI estimated from top-5 shares** (sum of squared percentages, lower bound).
  Exact HHI arrives with the data-ingestion phase (Blueprint I).
- **Addback Defensibility Index** uses a documentation-quality select as a
  questionnaire proxy for % of addback dollars rated LOW CHALLENGE.
- **Unknown NRR scores 25** and raises a not-tracked flag. Not measuring is treated
  as worse than measuring badly, but not as zero.
- **ORI weights are a v1 convention** (the blueprints do not define owner-side
  scoring). Matthew to ratify or adjust.
- **Band boundary convention:** higher-is-better bands are lower-bound inclusive
  (recurring 60% scores 75); lower-is-better bands use strict less-than
  (owner hours 10 scores 75, not 100).

## Later-phase scope captured in the methodology but NOT in this seed

EBITDA recast engine (A2), enterprise value calculation (A10), value gap dollars (A11),
monthly DRS/EV projection (A12.3), and the Blueprint I data-ingestion ontology. The
playbooks carry the EV-impact language so advisor conversations can reference it, but
the platform does not compute EV in v1. See docs/07-drs-methodology.md.
