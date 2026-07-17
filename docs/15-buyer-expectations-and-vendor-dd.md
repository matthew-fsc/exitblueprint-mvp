# 15 - Buyer Expectations & Vendor Due Diligence: What Two Real Diligence Artifacts Tell Us

Status: **Proposal / analysis for Matthew.** This document does not change the
rubric, the scoring engine, or any seed data. Per architecture rule 3
(methodology lives in data, changes ship as a new `rubric_version`) and the
working agreement ("product behavior decisions belong to Matthew"), the concrete
rubric/gap/playbook changes below are recommendations to accept, reject, or
reshape — not applied changes.

## Why this document exists

We were handed two real diligence artifacts:

1. **`Primary_DD_List_Magic_Stairs.xlsx`** — a live *buy-side* due diligence
   request list for **Majic Stairs, Inc.**, a lower-middle-market stair / attic-lift
   manufacturer in Ocala FL (three founders, each 33⅓%, ~10 years old). The buyer's
   team ("Canopy" runs the site visits) is working through 90+ requests across
   Financial & Operations, HR, Customers & Marketing, Product & IP, Compliance,
   and Legal. The seller's own comments are still in the cells — so we see not just
   what buyers *ask*, but where this seller is *scrambling*.

2. **`LWG_Vendor_Due_Diligence_QuestionnaireL2.pdf`** — an **RIA vendor DD
   packet**: the questionnaire a Registered Investment Advisor sends a technology /
   service vendor before trusting it with a "Covered Function." Eight pages of
   security, compliance, data-governance, business-continuity, and
   orderly-termination questions, framed around the SEC outsourcing-rule concept of
   a Covered Function.

Both documents are the same thing viewed from two angles: **an institutional
counterparty interrogating whether an organization is safe to acquire or to rely
on.** That interrogation *is* the event ExitBlueprint exists to predict and
pre-empt. These files are therefore primary-source calibration data for our
methodology — real questions from real gatekeepers, not our guess at them.

The rest of this document is: (1) the thesis, (2) an in-depth mapping of each file
against what we currently measure, (3) the gaps that mapping exposes, and (4) a
phased plan with three work streams.

---

## 1. Thesis

Our DRS today measures the **operating quality** of a business very well —
revenue durability, financial integrity, owner independence, customer risk,
management depth, growth. The Majic Stairs list confirms those six dimensions are
aimed at real buyer concerns.

But the Majic Stairs list also shows, in a real deal, that the items **most likely
to kill or retrade a lower-middle-market transaction are not operating-quality
items at all — they are transferability and legal-hygiene items** that our DRS
barely touches:

- The company's **IP is owned by a founder personally, not the company** ("These
  are in Ron's name and need to be transferred").
- There are **no written customer contracts and no written supplier contracts**
  ("None" / "None").
- A **fraudulent PPP loan** was filed in 2021 (settled) — a disclosure skeleton.
- Three equal owners with **no buy-sell agreement** produced yet.
- A weight-bearing lift product whose **safety certification / rated-capacity
  basis** is a headline diligence item.
- **Single-source supply risk** (a French motor supplier; Metalcraft fabrication;
  outsourced powder coating).

None of those six things is scored by the current DRS. Every one of them is a
classic reason a deal gets repriced, escrowed, earned-out, or walked. That is the
central finding: **we measure how well the business runs; buyers also — and first —
check whether it can be cleanly transferred and whether it hides a liability.**

The RIA vendor packet extends the same lesson into a second surface. For any
client that sells B2B (especially to regulated or enterprise buyers), "can you
survive our customers' vendor-security review" is now part of commercial
diligence — and it is a surface we do not measure at all. It is *also* a checklist
that will be pointed straight at **us**, because ExitBlueprint is a multi-tenant
SaaS holding owners' financials and personal data, sold through advisor firms that
run exactly this kind of vendor review.

So these two files drive three work streams:

- **A. Calibrate & extend the rubric** — add the supply/channel-concentration and
  working-capital signals the buyer list proves matter, and add a **Legal &
  Transferability** readiness layer.
- **B. Ship a Data Room Readiness surface** — turn the buyer's request list into
  the *client's* pre-built checklist. The ammunition becomes the product.
- **C. Complete ExitBlueprint's own vendor-DD answer** — dogfood the RIA packet,
  close the named gaps, and reuse the result as sales enablement and client
  content.

---

## 2. In-depth dive: the Majic Stairs buy-side list vs. our DRS

The buyer list has six sections. Below, each is mapped to what our rubric already
captures (dimension / sub-score codes from `seed/drs-rubric-*.csv`) and what it
does not. A full line-item matrix is in **Appendix A**.

### 2.1 Financial & Operations (A & B) — strongly covered, two real gaps

Covered well. The buyer wants monthly TB / P&L / BS 2023→2026, a QuickBooks
export, revenue-recognition policy, an **EBITDA bridge with owner comp, personal
expenses, one-time and related-party add-backs**, bank recs, AR/AP aging. This is
almost exactly our **FIN** dimension: `FIN-RECON` (reconciliation cadence),
`FIN-ADDBACK-DOC` (add-back documentation → the critical `ADDBACK_RISK` gap),
`FIN-BASIS` (accrual vs cash), `FIN-STATEMENTS` (all three statements),
`FIN-RELPARTY-CTX`, `FIN-ONETIME-CTX`. The list validates that FIN is pointed at
the right things and that add-back defensibility deserves its `critical` severity.

Two signals the buyer treats as first-order that **we do not score**:

- **Sales-tax nexus / exposure** (A7: registered states, exemption certificates).
  Unbooked multi-state sales-tax liability is a standard indemnity / escrow item in
  LMM deals. Not in the rubric.
- **Inventory controls & valuation methodology** (A12–A14: counting cadence,
  costing method, how inventory is relieved through COGS — *"inventory will need
  to be counted post-close"*). Weak inventory discipline is both a
  quality-of-earnings issue (margin reliability) and a working-capital-peg fight.
  Not in the rubric.

The operations half (B) — site visit to watch assembly, **capacity / bottlenecks,
cycle times, KPIs, single-source components** — maps partly to **OPS** and **GRW**,
but exposes the biggest operational gap:

- **Supplier / single-source concentration** (B5 French motor supplier, B3
  Metalcraft fabrication, B6 outsourced powder coating). We score *customer*
  concentration exhaustively (`CUS-TOP1`, `CUS-TOP5`, HHI) but have **no
  supplier-side concentration measure**. For a manufacturer, a single foreign motor
  vendor with long lead times is as much an enterprise-value risk as a 40% customer.

### 2.2 HR (C) — covered

Org list with comp, who is "**considered key to ongoing operations**," benefits,
employee disputes/workers-comp, and management culture for integration. This is
**MGT** (`MGT-LAYERS`, `MGT-NC-PCT`, `MGT-COMP`, `MGT-TURNOVER`, `MGT-FLIGHT-CTX`)
plus **OPS** owner-dependence. Well covered. The buyer's explicit "key to ongoing
operations" framing is exactly our `OWNER_DEP` / key-person thesis.

### 2.3 Customers & Marketing (D) — covered, one structural gap

Sales process, installation network, **customer issues / returns / warranty**,
channel relationships, marketing systems (Analytics, Ads, CRM, CPQ). Customer risk
is our **CUS/REV** core. The gap:

- **Channel / installer dependency.** A large share of Majic's delivered value runs
  through third-party installers and channel partners with "referral, commission,
  or exclusivity arrangements" (D2, D5). We measure customer concentration but not
  **distribution-channel concentration** — a partner who owns the last mile to the
  customer is a concentration risk our rubric can't see.

### 2.4 Product & IP (E) — largely *uncovered*, and this is where value leaked

This section produced the single most damaging finding in the file:

- **IP owned by a founder personally** (E5: "all patents, trademarks, engineering
  designs, domains … owned by the company (not individually by founders)" — seller
  answer: *"These are in Ron's name and need to be transferred"*). This is a
  textbook closing condition / value-killer, and we never ask it.
- **Product liability, warranty history, safety certification, rated-capacity
  basis** (E3, E4) — for a weight-bearing lift, existential. Not scored.
- **Product roadmap** (E6: *"Founders currently feel there is no new innovation for
  either product"*) — a growth-story red flag that touches **GRW** but isn't
  captured.

### 2.5 Compliance (F) — uncovered

Operating permits/licenses, **OSHA / environmental / hazmat**, IT environment and
software licensing, **insurance policies + five years of loss runs**, litigation /
investigations / tax audits. Almost none of this is in the DRS.

### 2.6 Legal (G–M) — uncovered, and full of real skeletons

Corporate formation docs, cap table, **buy-sell / shareholder agreements** (three
equal owners, no buy-sell produced), liens/encumbrances, **written customer and
supplier contracts** ("None" / "None"), employment / **non-compete** / consulting
agreements, IP registrations and assignments, litigation, and regulatory history —
including the disclosed **fraudulent PPP loan (2021, settled)**. This entire block
is transferability and legal hygiene, and the DRS is nearly silent on it.

### 2.7 What the mapping proves

| Buyer section | DRS coverage | Verdict |
|---|---|---|
| Financial & Accounting (A) | FIN (strong) | Covered; **add sales-tax nexus, inventory controls** |
| Supply Chain & Ops (B) | OPS/GRW (partial) | **Add supplier / single-source concentration** |
| HR (C) | MGT + OPS | Covered |
| Customers & Marketing (D) | CUS/REV (strong) | Covered; **add channel/installer concentration** |
| Product & IP (E) | ~none | **Gap: IP assignment, product liability, safety cert** |
| Compliance (F) | ~none | **Gap: licenses, environmental, insurance, litigation** |
| Legal (G–M) | ~none | **Gap: contracts, corporate/governance, disclosures** |

Three of the seven buyer sections — **Product & IP, Compliance, Legal** — are
essentially outside our current measurement surface, and they are precisely where
this real deal accumulated its retrade and closing-condition risk.

---

## 3. In-depth dive: the RIA vendor DD packet — two separate implications

The LWG packet matters to us twice, in ways worth keeping strictly separate.

### 3.1 As a methodology template for a client segment we can't currently score

The packet defines a readiness surface — **information security, data governance
(NPI, encryption at rest/in transit), sub-processor management, business
continuity / DR, regulatory standing, and orderly termination / data
portability** — that no DRS dimension touches. For a services or software LMM
company, passing (or failing) a customer's vendor-security review directly affects
**revenue durability**: a buyer will discount recurring revenue that cannot survive
the customer's annual vendor review or that carries a 30-day breach-notification
clause the company can't honor.

Because our rubric is universal and this surface is segment-specific, the clean
answer under rule 3 is **not** to bolt a security dimension onto the universal DRS.
It is a **segment rubric_version overlay** (a "Services / SaaS vendor-readiness"
variant) or a content-module track — a decision for §5.

### 3.2 As ExitBlueprint's own vendor obligation (this checklist points at us)

ExitBlueprint is a multi-tenant SaaS holding owners' financial statements, cap
tables, and personal-financial-readiness data — textbook NPI — distributed through
advisor firms that will run exactly this questionnaire on us before signing. The
LWG packet is, verbatim, a **sales-gating checklist we must be able to answer
"Yes" to.**

The good news: the decisions log shows we have already built a large part of the
answer. Beta Requirement 5 delivered **AES-256-GCM encryption at rest, signed
short-expiry document URLs, an append-only access audit log, MFA for advisor/admin,
and the `docs/13-security-summary.md` one-pager**; R1 delivered immutable data-rights
agreements + consent capture; R3 a document intake + manual-review pipeline; R6
usage instrumentation. **Appendix B** maps the packet line-by-line to what we can
already answer vs. what is open. The material open items:

- **Independent audit / SOC 2** (packet Q10, Q8) — none yet; the single biggest
  vendor-review blocker.
- **Business Continuity / DR plan** with publication date + test cadence (packet BC
  section) — not documented.
- **Contractual breach-notification within 30 days** (packet D&S Q9) — a contract
  clause, not yet standard language.
- **Sub-processor / subcontractor register + risk management** (packet
  Subcontracting section) — Anthropic, Supabase, Vercel are sub-processors; not yet
  formally listed or risk-assessed in `docs/13`.
- **Orderly termination**: data export in an **industry-standard format** +
  documented **data destruction** (packet Orderly Termination) — partial.
- **CISO / security contact designation** (packet IS Q1–Q2), **employee background
  checks** (packet C&R Q9), **pen-test cadence** and **TLS-version hygiene** (packet
  IS Q8–Q9) — undocumented.

Closing these is both a security task and a go-to-market unlock, and the finished
answer doubles as client-facing content (§4, work stream C).

---

## 4. The plan — three work streams

Sequenced so the low-build, high-leverage items land first, and so nothing violates
the non-negotiables (deterministic scoring, rubric-in-data, AI narrative-only,
new methodology = new `rubric_version`).

### Work stream A — Rubric calibration & extension (methodology IP)

Ships as a **new `rubric_version`** with its own reference-scorer fixtures; never
edits engine logic per-dimension. Two design decisions belong to Matthew (see §5).

**A1. Extend existing dimensions with proven signals.**
- **OPS/REV — supplier & channel concentration.** New sub-scores for top-supplier
  and single-source dependency, and channel/partner concentration. New gaps:
  `SUPPLIER_SINGLE_SOURCE` (critical/high), `CHANNEL_CONC` (high).
- **FIN — sales-tax nexus & inventory controls.** New sub-scores/questions for
  multi-state sales-tax exposure and inventory costing discipline. New gaps:
  `TAX_NEXUS_EXPOSURE` (high), `INVENTORY_CONTROL_GAP` (med).

**A2. Add a Legal & Transferability readiness layer (the big one).**
Captures IP assignment, contract documentation, corporate/governance records,
litigation/regulatory disclosures, insurance adequacy, licenses/permits,
environmental, and (for products) product-liability/safety certification.
Candidate gaps: `IP_UNASSIGNED` (critical), `CONTRACTS_UNDOCUMENTED` (high),
`BUYSELL_MISSING` (high), `LITIGATION_DISCLOSURE` (high), `REGULATORY_DISCLOSURE`
(high), `PRODUCT_LIABILITY` (high, product-only), `INSURANCE_GAP` (med),
`LICENSE_PERMIT_GAP` (med), `ENVIRONMENTAL_RISK` (med).

**Open design decision (§5.1): dimension vs. gating-flag layer.** Most of these are
binary red flags ("IP is/ isn't assigned"), not graded quality curves. They may
model better as a **flag layer that caps the achievable tier** (e.g., unassigned IP
makes *Institutional Grade* impossible regardless of DRS) than as a seventh weighted
dimension. Recommendation: a hybrid — a scored **Transferability** dimension for the
gradable items (contract coverage %, insurance adequacy) plus **hard gating flags**
for the binary killers (unassigned IP, undisclosed litigation, open regulatory
action). This keeps the six-dimension DRS comparable over time while making the
deal-killers impossible to hide behind a good operating score.

**A3. Wire gaps → playbooks → content.** Every new gap gets a remediation playbook
(`seed/playbooks/`) and buyer-question content (`seed/advisory-library.csv`,
`content-modules.csv`), following the existing `AL-BQ-*` pattern — e.g. an IP-
assignment playbook (assignment agreements, founder→co transfer, filing/maintenance)
and a "Buyer Question Prep: IP Ownership" module.

### Work stream B — Data Room Readiness surface (the ammunition, productized)

The Majic Stairs spreadsheet *is* a data-room index. The highest-leverage,
lowest-risk feature here is to ship that request list back to owners as their
**pre-built diligence checklist**, assembled over the 12–36-month window instead of
scrambled during a live deal.

- A **canonical diligence request template** (seed data, versioned) organized like
  the buyer list — Financial, Operations, HR, Customers, Product/IP, Compliance,
  Legal — with each item having a readiness state (Ready / In progress / Gap / N/A)
  and an optional linked document (reuse the existing `documents` pipeline from R3).
- **Deterministic, no LLM** — it is a checklist, not a score. AI may later *draft* a
  narrative "diligence readiness summary" from the structured states (narrative-only,
  labeled draft), but the states themselves are advisor/owner-entered fact.
- Ties into existing gaps: an unchecked "IP assignment agreements" item is the same
  underlying fact as the `IP_UNASSIGNED` gap — the data room surface and the rubric
  should reference one taxonomy, not two.

This is the feature that most directly embodies the product brief ("struggle with
low-level operational and financial issues that quietly destroy valuation… nothing
serves the pre-deal readiness window"): the owner walks into diligence with the
binder already built.

### Work stream C — ExitBlueprint's own vendor-DD answer (dogfood + enablement)

- **Complete a vendor-DD response pack** answering the LWG packet, extending
  `docs/13-security-summary.md`. Fill every field we can today (Appendix B) and open
  tracked items for the rest.
- **Close the named gaps** in priority order: (1) BCP/DR plan + test cadence; (2)
  sub-processor register (Anthropic, Supabase, Vercel) with risk notes; (3) standard
  contractual breach-notification (≤30 days) and orderly-termination / data-export +
  destruction language; (4) CISO/security-contact designation, background-check
  policy, pen-test cadence, TLS-version statement; (5) scope and sequence a **SOC 2
  Type I → II** path (the long pole; start the readiness assessment early).
- **Reuse as content.** The finished pack becomes a client-facing module — "What
  your buyers' customers will ask you" — for the services/SaaS segment (ties to
  A/§3.1). Dogfooding is the credibility: we assemble the exact binder we tell
  clients to build.

### Sequencing

1. **B (Data Room Readiness template)** and **C-answer (vendor-DD pack)** first —
   both are seed/doc/checklist work, no engine or rubric-version churn, and both are
   immediately useful (client value in B, sales unlock in C).
2. **A1 (existing-dimension signals)** next — additive sub-scores in a new
   rubric_version, with fixtures.
3. **A2 (Legal & Transferability layer)** last and only after Matthew settles the
   dimension-vs-gating-flag decision — it is the largest methodology change and the
   most valuable, so it should not be rushed into the engine before the design is
   fixed.

---

## 5. Decisions (resolved with Matthew 2026-07-17)

1. **Transferability modeling → HYBRID.** Score the gradable items (contract
   coverage %, insurance adequacy) as a Transferability dimension AND treat the
   binary deal-killers (unassigned IP, undisclosed litigation, open regulatory
   action) as hard flags. A clean operating score must not be able to mask an
   unassigned-IP closing condition.
2. **Rubric scope → SPLIT (universal + overlays).** Legal / IP / transferability
   lives in the universal rubric (every deal has it); industry-specific signals
   (supplier concentration for manufacturing, vendor-security for services/SaaS)
   live in segment `rubric_version` overlays. Keeps the core DRS comparable across
   the whole book.
3. **Tier gating → HARD CAP.** Any unassigned core IP, undisclosed litigation, or
   open regulatory action forbids *Institutional Grade (85+)* outright, regardless
   of operating score.
4. **Data Room Readiness taxonomy → one source of truth.** The data-room checklist
   and the gap taxonomy share one taxonomy: a data-room item that maps to a gap
   carries that gap's code, so "the IP-assignment item" and the `IP_UNASSIGNED` gap
   are the same fact, never two parallel lists.
5. **Build order → Work stream B first** (Data Room Readiness), because it is
   deterministic, reuses the R3 documents pipeline, ships client value immediately,
   and establishes the shared taxonomy the rubric work (A) then reuses.

Still open (not blocking B): **SOC 2 timing** — a months-long external process that
vendor reviews increasingly hard-gate on; decide when to start the readiness
assessment as part of work stream C.

## 6. Implementation status

- **Work stream B — Data Room Readiness (landed):** a versioned, canonical
  diligence request template (7 sections, 37 items) seeded as global methodology
  like the rubric (`seed/data-room-sections.csv`, `seed/data-room-items.csv`),
  plus a per-engagement readiness state per item (not_started | in_progress |
  ready | gap | not_applicable) with an optional link to an uploaded document
  (reuses the R3 `documents` pipeline). Deterministic, no LLM — nothing here
  computes or writes a score (rule 2). Template items that map to a scored gap
  carry that gap's code (decision 4: one taxonomy). Surfaces:
  - `supabase/migrations/20260717000100_data_room.sql` — `data_room_sections`,
    `data_room_items` (global, methodology-read), `engagement_data_room_items`
    (firm-scoped; staff CRUD + owner-own-company RLS mirroring documents).
  - `server/data-room.ts` (`listDataRoom`, `setDataRoomItem`) wired into the
    router as `list-data-room` / `set-data-room-item`, authorized through the
    generic engagement path (staff by firm, owner by company).
  - Frontend engagement **Data room** tab (`src/pages/DataRoomPage.tsx`): sections
    in buyer-list order, per-item state selector, buyer rationale, gap-code tag,
    and a readiness-percent summary (ready ÷ in-scope items).
  - Each item exposes *why a buyer asks* — the education layer that turns the
    buyer's ammunition into the owner's checklist.
  - Verified: fresh migrate, seed ×2 (idempotent), seed:demo ×2, `test:rls` 67,
    `vitest` 167 (`tests/data-room.test.ts` drives the router end-to-end), eval,
    and `build` all green; the tab was driven live in a browser against the demo
    tenant.
- Work streams A and C: not started; A is gated on this taxonomy, which has now
  landed, so A can proceed next (add the supplier/channel + Legal & Transferability
  rubric_version, reusing these gap codes and extending them with the new ones).

---

## Appendix A — Majic Stairs buy-side list → DRS coverage matrix

| # | Buyer request (abridged) | Current coverage | Proposed |
|---|---|---|---|
| A1–A3 | Monthly TB / P&L / BS 2023–2026 | `FIN-STATEMENTS`, `FIN-HISTORY-CTX` | — |
| A4 | QuickBooks export + tools outside QB | partial (`FIN-STATEMENTS`) | note financial-system quality |
| A5 | Revenue recognition policy | `FIN-BASIS` | — |
| A7 | Sales-tax registered states / exemptions | **none** | `TAX_NEXUS_EXPOSURE` |
| A8 | TTM EBITDA bridge + add-backs | `FIN-ADDBACK-DOC` → `ADDBACK_RISK` | — |
| A9–A11 | Bank recs, AR/AP aging, AP process | `FIN-RECON` | — |
| A12–A14 | Inventory policy / costing / balances | **none** | `INVENTORY_CONTROL_GAP` |
| B2/B5/B6 | Vendor purchases; single-source motor; outsourced powder coat | **none** | `SUPPLIER_SINGLE_SOURCE` |
| B8–B10 | Capacity, cycle times, KPIs | partial (`OPS-*`, `GRW-*`) | ops-KPI signal (optional) |
| C1–C4 | Org/comp, key persons, culture | `MGT-*`, `OPS-HOURS` | — |
| D2/D5 | Installer network, channel/exclusivity | **none** | `CHANNEL_CONC` |
| D4 | Customer issues / returns / warranty | `CUS-SIGNALS-CTX` | — |
| E1–E2 | SKU list, BOMs, drawings | partial (`GRW-REPEAT`) | — |
| E3–E4 | Safety cert, rated capacity, product liability, warranty | **none** | `PRODUCT_LIABILITY` |
| E5 | IP owned by company vs founder | **none** | `IP_UNASSIGNED` (critical) |
| E6 | Product roadmap / innovation | partial (`GRW-POSITIONING`) | growth-story flag |
| F1 | Permits / licenses / OSHA | **none** | `LICENSE_PERMIT_GAP` |
| F2 | Hazmat / environmental | **none** | `ENVIRONMENTAL_RISK` |
| F4 | Insurance + 5yr loss runs | **none** | `INSURANCE_GAP` |
| F5 / K | Litigation / investigations / tax audits | **none** | `LITIGATION_DISCLOSURE` |
| G6–G7 | Cap table + buy-sell (3 equal owners) | **none** | `BUYSELL_MISSING` |
| H4–H5 | Asset titles / liens / encumbrances | **none** | transferability item |
| H7–H8 / M | Written customer & supplier contracts ("None") | `CUS-REV-CONTRACT-PCT`, `REV-CONTRACT-*` (scores it low) | `CONTRACTS_UNDOCUMENTED` |
| I1–I2 | Employment / non-compete / consulting agreements | `MGT-NC-PCT` → `NONCOMPETE_GAP` | — |
| J1–J7 | IP registrations / assignments / licenses | **none** | `IP_UNASSIGNED` |
| L1 | Regulatory correspondence (**PPP-loan disclosure**) | **none** | `REGULATORY_DISCLOSURE` |
| M1/M9 | Leases + other material contracts | **none** | transferability item |

## Appendix B — RIA vendor DD packet → ExitBlueprint posture

| Packet area | Question(s) | Our answer today | Source / gap |
|---|---|---|---|
| Vendor info | ownership, years, headcount, claims | Answerable | company facts |
| Independent audit | Q10, Q8 | **Open** | no SOC 2 / external audit yet |
| Material claims/judgements | Q11 | Answerable | company facts |
| Covered function / scope | Nature §2 | Answerable | narrative-generation vendor |
| Subcontracting | Subcontracting §1–3 | **Partial** | Anthropic/Supabase/Vercel sub-processors not yet formally registered |
| Compliance policies | C&R §4–8 | Partial | `docs/13`; no external audit |
| Background checks | C&R §9 | **Open** | policy undocumented |
| NPI + encryption at rest/in transit | D&S §1 | **Answerable** | AES-256-GCM at rest (R5), TLS in transit |
| Third-party credential storage | D&S §2 | Answerable | not stored |
| Backups / shared vs dedicated / access logs | D&S §4–8 | Partial | Supabase; `data_access_log` (R5) covers doc access |
| Breach notification ≤30 days | D&S §9 | **Open** | not yet contractual language |
| CISO / security contact | IS §1–2 | **Open** | designate |
| Risk assessment of sub-vendors | IS §3–5 | **Open** | formalize |
| AV / firewall / pen test / TLS version / patching / NAC / IDS | IS §6–12 | **Partial/Open** | document; pen-test cadence not set |
| Cloud data location / access reviews / password controls / session timeout | Cloud §1–6 | Partial | Supabase region; MFA (R5); document the rest |
| Business Continuity / DR plan + test cadence | BC §1–5 | **Open** | no documented BCP/DR |
| Orderly termination / data format / data destruction | OT §1–3 | **Partial** | export exists; industry-standard-format + destruction to document |

---

## Provenance

Derived from two supplied artifacts: `Primary_DD_List_Magic_Stairs.xlsx` (a live
buy-side DD request list) and `LWG_Vendor_Due_Diligence_QuestionnaireL2.pdf` (an
RIA vendor DD questionnaire). Analysis is advisor-verifiable fact from those files
mapped against the in-repo rubric (`seed/drs-rubric-*.csv`, `seed/gap-definitions.csv`)
and security posture (`docs/13`, `docs/10`). No score, rubric row, or engine
behavior was changed by this document.
