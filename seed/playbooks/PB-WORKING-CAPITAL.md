---
code: PB-WORKING-CAPITAL
name: Working-Capital Peg Program
version: 1
dimension: FIN
phase: Phase 1 (0-6mo)
ev_impact: Protects 2-8% of enterprise value that commonly leaks at close when the buyer, not the seller, sets the net-working-capital target.
summary: Build the net-working-capital evidence base that governs the peg negotiated at close, so value is not clawed back on the final true-up.
sources: SRC-AICPA, SRC-PRACTITIONER
---

# Working-Capital Peg Program

**Roadmap phase:** Phase 1 (0-6mo)

**Value impact:** Protects 2-8% of enterprise value that commonly leaks at close when the buyer sets the net-working-capital (NWC) target from their own read of the balance sheet.

## Why buyers care

Almost every LMM deal closes on a "cash-free, debt-free" basis with a **normal level of
working capital delivered at close.** The buyer proposes a peg; if the business delivers
less than the peg, the price is reduced dollar-for-dollar at the true-up. Owners who have
never quantified their own NWC discover the peg for the first time in diligence and
negotiate from the buyer's number. Owning the trailing-average NWC and its seasonality
turns the peg into a data conversation instead of a surprise.

## How to run it

1. Pull 24 months of monthly balance sheets so the seasonal swing is visible, not averaged
   away.
2. Compute NWC (current operating assets minus current operating liabilities, excluding
   cash and debt) for each month and the trailing-twelve-month average.
3. Identify the seasonal low points — the buyer will anchor the peg near them if you don't
   explain the cycle.
4. Set the operating target you can defend and document the rationale for the diligence
   file, before an LOI fixes the framework.

## Evidence this produces

- A 24-month monthly NWC schedule and TTM average.
- A seasonality analysis with the defensible operating target.
- A short peg-rationale memo for the data room.

## Tasks

| seq | title | owner_role | offset_days |
|---|---|---|---|
| 1 | Assemble 24 months of monthly balance-sheet data | advisor | 30 |
| 2 | Compute monthly and trailing-twelve-month average net working capital | advisor | 45 |
| 3 | Quantify the seasonal swing and set the defensible operating target | owner | 60 |
| 4 | Document the peg rationale for the diligence file | advisor | 90 |

## Sources

Working-capital-peg mechanics and financial-diligence scope: AICPA financial due-diligence
guidance (SRC-AICPA) and practitioner consensus (SRC-PRACTITIONER). See `seed/SOURCES.md`.
