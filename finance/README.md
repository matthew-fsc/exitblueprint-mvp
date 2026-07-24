# Finance — Bootstrap Cash Flow Model

`ExitBlueprint_CashFlow_Bootstrap_v6.xlsx` — the founder-facing cash flow model for
bootstrapping ExitBlueprint on a small loan from Joe (no SBA loan, no Series A raise).
This is a planning artifact, not application code; it is fully formula-driven and
recalculates on open in Excel / Google Sheets.

## Thesis

Joe lends the company just enough to bridge the pre-revenue burn. The loan accrues
interest (non-cash) while pre-revenue, then is repaid out of operating cash flow as
advisors ramp. Founders draw only once the business can fund it.

## Bootstrap mechanism (base case)

1. **Joe funds a $55k loan at Mo 0 (Aug-26)** — sized to the deepest cumulative cash
   hole (~$39k) plus a $15k buffer.
2. Interest accrues (PIK) during the burn; nothing is paid out.
3. **GTM right after Labor Day** — Mo 1 = Sep-26. Founding advisors onboard; revenue begins.
4. **Founder draws ($5k/mo) switch on only when gross profit covers them** — Mo 3 (Nov-26).
5. Once monthly cash flow turns positive (Mo 4), surplus above the buffer **sweeps back
   to Joe**.
6. Joe is **fully repaid by ~Mo 7 (Mar-27)** with ~$1.9k total interest; the business
   self-funds thereafter.

## Key decisions baked in

- **Marketing:** $750/mo for Mo 0–1, then $1,500 → $2,250 → $3,000/mo cap as the software matures.
- **Legal itemized:** entity formation, Operating Agreement, Trademark/IP, ToS/Privacy Policy.
- **SOC 2 kept** (~$20k, spread Mo 0–2). Dev build, EPI conference, and BizDev retainer removed.
- Costs scale with advisor count / phase, not hired ahead of revenue.

## Sheets

| Sheet | Purpose |
|---|---|
| README | Thesis, mechanism, legend |
| Assumptions | Every editable input (blue). Yellow = key levers. |
| Joe Loan | Drawdown, PIK interest accrual, cash-flow sweep repayment |
| Monthly Cash Flow | Base case, Mo 0–18 (Aug-26 → Feb-28) |
| Dashboard | One-screen read: loan payoff, cash trough, self-funding milestones, traction |
| SaaS Metrics | Unit economics (ARPU, LTV, CAC payback, LTV:CAC, Rule of 40) |
| Downside (Slow GTM) | Ramp slips 2 mo + adds haircut; tests loan survival, sizes any top-up |

**Color legend:** blue = input · black = formula · green = cross-sheet link · yellow fill = key lever.

## Notes

- The loan size, interest rate, cash buffer, marketing ramp, draw target/trigger, and the
  full advisor ramp are all blue inputs on the **Assumptions** tab — edit to run scenarios.
- The revenue ramp is inherited (re-anchored) from the prior `NewCo_CashFlow_v5` plan and is
  the single biggest swing; the Downside tab shows the bootstrap still holds under a slower launch
  (a ~2-month slip with 40% fewer adds needs roughly a $71k loan instead of $55k).
