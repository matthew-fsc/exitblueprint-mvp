# Legal counsel talking points

**Status:** Reference — a briefing agenda for outside counsel. Not legal text.
**Owner:** Matthew. **Prepared:** 2026-07-21.

This is the agenda to walk counsel through before go-live on exitblueprint.net
(docs/29). It covers the four things asked for — **Terms of Service**, the
**in-product legal disclaimers**, **trade-secret** protection, and **trademark**
protection — plus the adjacent items counsel will need to see the whole picture
(privacy/DPA, the AI layer, third-party data licensing, the advisor channel,
regulatory exposure, and the future benchmarking layer).

## What already exists (hand counsel these first)

We have drafted a legal scaffold in code so counsel edits real structure, not a
blank page. Every clause needing a legal decision is tagged so it is greppable.

- **`src/pages/legal/content.ts`** — draft **Terms of Service, Privacy Policy,
  Data Processing Addendum, and Sub-processors** register. Every page renders a
  `DRAFT — pending review by legal counsel` banner, and every open decision is
  marked `[to be completed by counsel]` (the `COUNSEL_TODO` marker). The
  sub-processor register and the security-measures sections are **factual**
  (sourced from the real stack); everything else is placeholder.
- **`seed/subprocessors.csv`** — the real third-party processor list, kept in
  sync with the in-app `/security` page and docs/13 / docs/16.
- **`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`** — the
  implemented security controls (RLS tenant isolation, AES-256-GCM at rest,
  signed URLs, MFA, audit logging). These back every "technical and
  organizational measures" representation.
- **Existing in-product valuation disclaimer** (`src/pages/ValuationPage.tsx`):
  *"Estimate only, from valuation rules {version}. Not an appraisal or a fairness
  opinion."* — confirm this is sufficient (see §3).

Counsel's job is to (a) finalize the `COUNSEL_TODO` decisions, (b) pressure-test
the disclaimers, and (c) advise on the IP/trademark strategy in §5–§6.

---

## 1. Product primer for counsel (so the advice fits the facts)

- **What it is.** A SaaS platform that measures a private company's *exit
  readiness* (the deterministic **DRS** — Deal Readiness Score — and a separate
  **Owner Readiness Index / ORI**), diagnoses gaps, prescribes remediation
  playbooks, and educates the owner over a 12–36-month pre-deal engagement.
- **The three parties.**
  1. **Provider** — us (the contracting entity — **`COUNSEL_TODO`: confirm the
     legal entity name**).
  2. **Advisor firm** — M&A advisory firms that license the platform; they are
     the paying customer and the channel.
  3. **Business owner / client company** — assessed by the advisor; may be
     invited into an owner portal.
- **The data.** Sensitive by design: company financial summaries, uploaded
  source documents (tax returns, statements, cap tables), assessment answers,
  **owner personal-financial-readiness inputs (PII)**, and valuation outputs.
- **How scores are produced.** Rule-based, versioned, deterministic code — *no
  LLM ever computes or influences a score* (CLAUDE.md rule 1). This is a
  material fact for the disclaimers: the number is an algorithmic readiness
  indicator, not an appraisal and not AI output.
- **How AI is used.** Claude drafts *narrative only* (reports, briefs,
  summaries) **from** already-structured data, always labeled draft (CLAUDE.md
  rule 2; docs/04). Anthropic does not train on the data.
- **Tenancy.** Every table carries `firm_id`; Postgres row-level security
  enforces firm isolation in the database (CLAUDE.md rule 5).
- **Current stage.** Beta; participating firms may have complimentary access.

---

## 2. Terms of Service — decisions to close

Map these to the `COUNSEL_TODO` markers already in `termsDoc`
(`src/pages/legal/content.ts`).

- **Contracting entity & "customer" definition.** Which legal entity offers the
  Service? Is the customer the *advisor firm* (B2B), the individual advisor, or
  (where the owner portal is enabled) the owner? Our model treats the **firm as
  customer**; confirm.
- **Acceptance mechanism.** Click-through at signup vs. signed order form. How is
  acceptance recorded and versioned (we version everything — align ToS
  versioning with that)?
- **Eligibility / authority to bind** a firm; minimum age/authority for owner
  portal users.
- **Acceptable use.** We already prohibit cross-tenant access attempts,
  circumventing tenancy controls, reverse-engineering, and unlawful/no-right
  uploads — counsel to complete the full list and remedies. (Reverse-engineering
  and anti-scraping tie directly to trade-secret protection, §5.)
- **Fees / billing.** Subscription via Stripe; plan/seat/engagement limits; taxes,
  renewal/auto-renewal, refunds, non-payment. **Beta:** how do complimentary
  beta terms interact with paid terms, and can we change or sunset them?
- **Intellectual property split.** Provider owns the platform, methodology, and
  all derived analytics; **customer retains ownership of the business/assessment
  data it submits** and grants us the limited operating license. Confirm scope
  of that license — critically, it must be **broad enough to cover calibration
  and the future benchmarking layer** (§7). Also: who owns AI-generated
  narrative output, and a feedback license.
- **AI-generated content clause.** Narrative is a labeled draft aid, *not*
  financial/legal/tax/investment advice; scores are deterministic, not AI. (Draft
  language already present — counsel to finalize reliance allocation.)
- **Disclaimers / "as is."** Full warranty disclaimer; no uptime/error-free
  warranty; not investment/legal/tax/accounting advice.
- **Limitation of liability.** Cap amount/formula, excluded damages, exceptions.
  High stakes given the data sensitivity and the reliance risk — **do not treat
  any figure as agreed until counsel supplies it.**
- **Indemnification.** Both directions — customer for its uploaded content and
  its own advice to owners; provider for IP infringement (standard).
- **Termination & data handling.** Export in standard formats then delete per
  instruction (the firm-scoped schema makes clean per-tenant export/deletion
  tractable). Notice periods and for-cause triggers.
- **Governing law, venue, dispute resolution** — jurisdiction, arbitration vs.
  litigation, class-action waiver.
- **Changes to terms** — notice mechanism; how continued use = acceptance.

---

## 3. In-product legal disclaimers (the highest-risk area)

The core litigation risk is **reliance**: an owner or buyer treats a score or a
valuation estimate as a promise. Counsel should specify the exact wording *and
placement* of each disclaimer. Candidate list:

- **"Not advice."** Blanket: the platform does not provide investment, legal,
  tax, accounting, or appraisal advice; outputs are decision-support for the
  advisor's professional judgment.
- **DRS / ORI score.** State plainly that the score is a **rule-based readiness
  indicator**, versioned to a rubric, **not a valuation, not a guarantee of a
  sale, price, multiple, or timeline**, and not a prediction of any specific
  outcome. (The moat doc, docs/09, explicitly frames the DRS as a *prediction*
  we intend to calibrate against real outcomes — see §7; that ambition makes the
  "no guarantee" disclaimer more important, not less.)
- **Valuation estimate.** We already show *"Estimate only… Not an appraisal or a
  fairness opinion."* Confirm this is enough to keep us clearly outside
  **business-appraisal regulation (USPAP / credentialed-appraiser rules)** and
  outside anything that could read as a securities valuation or fairness
  opinion. Consider adding: methodology is rule-based comparables, not a
  USPAP-compliant appraisal; do not use for tax, litigation, ESOP, or
  transaction-pricing purposes.
- **AI-drafted narrative.** Labeled as **draft**, may contain errors or omissions,
  requires human (advisor) review before any use, and does not constitute advice.
  (Draft labeling is already an architectural rule; counsel to bless the wording.)
- **Verified vs. self-reported data.** The product tags provenance. Disclaim that
  outputs depend on inputs; self-reported figures are unaudited.
- **No outcome guarantee / forward-looking.** No assurance any owner will sell,
  or achieve any indicated value or readiness level.

**Placement to confirm with counsel:** the ToS AI/disclaimer sections; the
valuation page; the footer of every generated **report and PDF**; adjacent to
every **score display**; and on the AI narrative output surfaces. We can wire
these centrally so they version alongside the rubric/prompt versions.

---

## 4. Privacy, DPA & data protection

The scaffold's `privacyDoc` and `dpaDoc` carry the structure; the open decisions:

- **Controller / processor roles.** Working model: the **advisor firm is the
  controller** of its client data, **we are the processor**. Confirm, and confirm
  how this routes data-subject requests (through the firm).
- **Existing consent gate.** docs/13 records that *no assessment data is collected
  for a client until a signed engagement agreement and explicit data-use consents
  are recorded.* Counsel should (a) approve the wording of that consent, and
  (b) confirm it is broad enough to cover the calibration/benchmarking use in §7
  — this is the natural place to capture that opt-in.
- **Data inventory & sensitive categories.** Confirm the full inventory,
  including **owner personal-financial-readiness PII** — assess whether any
  financial-privacy regimes (e.g., GLBA-adjacent expectations for the advisors)
  flow to us contractually.
- **Legal bases, secondary uses.** Especially the calibration/benchmarking use
  (§7) — is it a compatible secondary use, and what consent/opt-in is required?
- **Retention periods** per data category, backup-retention window, and
  post-termination deletion timeline (all `COUNSEL_TODO` today).
- **Data-subject rights** (GDPR/CCPA as applicable) — enumeration, mechanism,
  timelines. Confirm whether we serve non-US data subjects at all (today
  processing is US-only).
- **Breach notification.** DPA currently flags a target of **72 hours / ≤30-day
  clause** — counsel to set the contractually committed deadline and notice
  content. **No deadline is committed until counsel finalizes it.**
- **Sub-processor change notice & objection rights.** Register is factual and
  published; counsel to set the advance-notice period and objection process.
- **International transfers** — mechanisms/safeguards *if/when* we go beyond the
  US.
- **DPA execution flow** — is the DPA incorporated by reference into the ToS or
  separately signed per firm?

---

## 5. Trade-secret protection (the core moat)

The scoring **methodology** is the crown-jewel IP and is deliberately kept in
data, not code: the DRS/ORI **rubric — dimensions, questions, sub-scores,
weights, bands, thresholds** (`seed/drs-rubric-*.csv`, docs/07), the **valuation
multiples** (`seed/valuation-multiples.csv`), the **content/playbook library**,
and — per docs/09 — the three data moats: **outcome-calibration corpus, the
verified financial corpus, and the engagement graph**. Talking points:

- **We already brand the methodology as confidential IP.** docs/07 states
  verbatim: *"Confidential IP of Exit Blueprint,"* and `seed/README.md` marks the
  weights/bands/thresholds as *"canonical… not templates."* Counsel should build
  on that framing, not invent it.
- **Elect trade-secret (not patent) protection** for the rubric/weights/calibration
  and confirm the strategy. Under DTSA/UTSA, protection requires **"reasonable
  measures to maintain secrecy"** — we should document that we already have them:
  RLS tenant isolation, encryption at rest, signed-URL-only document access, MFA,
  role-based access, and **append-only audit logging** (docs/13). This
  security posture *is* legal evidence — have counsel note it as such.
- **Contractual confidentiality in the ToS.** No reverse-engineering, no scraping
  or bulk extraction of the rubric/scoring outputs, no using the platform to
  build a competing scoring model, no disclosure of the methodology. (Anti-scrape
  + anti-reverse-engineering language ties §2 to this section.)
- **Employee & contractor coverage.** IP-assignment + NDA + invention-assignment
  agreements for everyone who touches the rubric, calibration data, or content
  library. Confirm we have these in place for all current contributors.
- **Advisor-firm confidentiality.** Advisors see methodology outputs and some
  logic; restrict their disclosure and competitive use. Consider whether the
  detailed rubric is ever exposed to firms and gate accordingly.
- **Ownership of derived datasets.** Ensure the ToS/DPA give us the **contractual
  right to build and retain** the calibration corpus, verified-financial corpus,
  and engagement graph (aggregated/derived from customer data) — this is the
  asset base and it must be secured now, not retrofitted (docs/09; see §7).
- **Trade-secret hygiene process.** Marking confidential materials, access
  on a need-to-know basis, and an offboarding checklist.

---

## 6. Trademark protection

- **Marks to clear and register.** "**Exit Blueprint**" / "**ExitBlueprint**"
  (word mark + any logo), the domain **exitblueprint.net** (docs/29), and the
  **proprietary index names**: "**DRS**" / "**Deal Readiness Score**" and
  "**Owner Readiness Index**" / "**ORI**." docs/09 explicitly positions the DRS
  as a **FICO-style** branded score — that analogy is the reason to protect the
  index names aggressively and early.
- **Clearance search first.** Full clearance/knockout search before filing and
  before further brand spend; flag conflicts.
- **Descriptiveness risk.** "Exit Blueprint" is somewhat descriptive of the
  service — counsel to assess distinctiveness / secondary-meaning strategy and
  whether the logo/stylized form strengthens the filing.
- **Classes.** Likely Intl. Class **9** (software), Class **35/36**
  (business/financial-consulting services), and possibly Class **41**
  (educational content). Counsel to confirm the class strategy.
- **Federal registration (USPTO)** vs. common-law ™ in the interim; correct
  **™ / ® marking** conventions in-product and in marketing.
- **Enforcement / policing** posture and a watch service.
- **Copyright** (adjacent): the content library, report templates, and prompt
  library are original works — confirm ownership (work-for-hire/assignment from
  any contributors) and clear any third-party content used in the education
  modules.

---

## 7. The future cross-firm benchmarking / calibration layer (plan now)

docs/09 describes an **anonymized, opt-in cross-firm benchmarking** layer and a
calibration engine fed by real deal outcomes. It is out of scope to *build* now,
but the **legal rights to do it must be secured in today's contracts** or we
cannot build it later without re-papering every firm. Points:

- **Data-use license** in the ToS/DPA that permits creating **de-identified,
  aggregated** analytics from customer data for calibration and benchmarking.
- **Consent / opt-in** model — docs/09 commits to opt-in and to *"a firm's raw
  deals never leak."* Counsel to design the consent so it is valid under the
  privacy regime.
- **De-identification standard** — which standard makes the aggregated pool
  legally "not personal data" (e.g., HIPAA-style safe-harbor vs.
  expert-determination reasoning applied to financial data)?
- **Ownership of the aggregated/derived layer** — we own the benchmark; the firm
  retains its raw data. Make this explicit.

---

## 8. Third-party / external paid data — licensing the data we buy to improve the system

We license external **paid datasets** (e.g., valuation comparables / market
multiples, industry benchmarks, market/economic data) to refine the valuation
engine (`server/valuation.ts`, `server/comparables.ts`, `seed/valuation-multiples.csv`)
and, over time, to calibrate the rubric/DRS. "Betterment of our system" means
feeding that purchased data into product-wide improvements — and **every such
dataset comes with a license whose use restrictions can limit, or forfeit, that
use.** Counsel must review each data license against how we actually use it.

- **Permitted-use scope.** For each license: internal use only vs. incorporation
  into a **commercial product**; internal modeling vs. **display to customers**;
  redistribution restrictions (may advisors/owners see the data itself, or only
  derived outputs?); per-seat vs. enterprise scope. Many financial-data licenses
  forbid redistribution and forbid use of the data in a derived **index or
  benchmark** — exactly the direction we're heading (§7).
- **Derivative works & our ownership (the moat issue).** Does the license permit
  creating **derived/blended datasets and models** — blending purchased comps
  into our own valuation multiples and calibration corpus — and **who owns the
  derivative?** Some licenses claim rights in derivatives or bar using the data to
  build a competing/independent product; that would **taint our own proprietary
  corpus** (§5) and the benchmarking layer (§7). Preserve our ownership of derived
  analytics and avoid contaminating the moat with restricted inputs.
- **"Improve the system for all customers."** Using licensed data to benefit every
  tenant (a shared benchmark / calibration) is precisely what many licenses
  restrict — and it also has to sit inside our customers' own data-use consents
  (§4, §7). Confirm the purchased data may be **pooled/aggregated** the way we
  intend.
- **AI/ML training restrictions.** Data licenses increasingly prohibit feeding the
  data into AI/ML **training**. Our scoring is deterministic (not AI), but confirm
  (a) purchased data used to calibrate the rubric is permitted, and (b) it is not
  passed to Anthropic in any way that breaches the license (ties to §9).
- **Survivability / termination.** If a data license ends, must we **purge the
  data and its derivatives**? That could gut an improved model — and outputs
  already delivered. Negotiate **perpetual rights to already-derived aggregated
  results**, and clarify the status of valuations/reports already delivered to
  customers.
- **Accuracy, provenance & pass-through.** Vendors disclaim accuracy; where a
  valuation estimate is partly driven by purchased data, our disclaimers (§3) and
  reps must not over-promise. Secure the vendor's **accuracy / IP-infringement
  indemnity**, and be deliberate about what raw vendor data (vs. our derived
  output) we pass through to advisors/owners.
- **Personal data in purchased datasets.** If external data contains PII
  (owner/executive/contact records), privacy-law duties attach (CCPA "sale/share,"
  GDPR lawful basis) — fold into §4.
- **"Free"/scraped-data caveat.** If any external data is **scraped** rather than
  licensed, that is a separate and larger risk (source-site ToS, CFAA,
  copyright/database rights). Flag anything not covered by a paid license.

---

## 9. Regulatory / licensing exposure to screen

- **Not investment advice (Advisers Act).** The valuation + "worth ~Nx" framing
  must stay clearly on the side of decision-support, not investment advice or a
  securities valuation. Confirm we don't trip adviser-registration triggers.
- **Business-appraisal / valuation regulation.** Keep the estimate positioned as
  a **screening tool, not a USPAP appraisal** (§3).
- **Unauthorized practice of law (UPL).** Playbooks prescribe remediation that
  can touch legal matters (operating agreements, contracts). Keep them
  **educational**, not legal advice; add the not-legal-advice disclaimer.
- **Accounting.** We ingest QuickBooks/Xero-verified financials but issue no
  audit/accounting opinion — disclaim.
- **The advisors' own regulation.** M&A advisors may be regulated (e.g., the
  federal M&A-broker exemption). Confirm the platform doesn't pull us into
  broker-dealer/securities territory and that firms represent their own
  compliance.

---

## 10. AI-specific legal

- **Anthropic terms.** Confirm the contractual "no training on our data"
  position and data-handling terms hold at our tier; the sub-processor entry
  already represents this to customers.
- **Disclosure of AI use** to advisors and owners (already in the privacy/ToS
  drafts) — confirm sufficiency against emerging AI-transparency expectations.
- **Liability for AI errors/hallucinations** in narrative — allocate via the
  draft-labeling + human-review-required posture. Note the existing engineering
  guardrails counsel can rely on: the prompts hard-block the model from inventing
  numbers, stating valuations/multiples, or giving legal/tax advice (*"refer those
  questions to the advisor"*), and a numeral post-check rejects invented figures
  (`prompts/*.md`, docs/04). These reduce, but do not eliminate, reliance risk.
- **IP in model output** — ownership and any third-party-model term flow-through.

---

## 11. Advisor channel / distribution & white-label

- **Flow-down of terms to owners.** When an advisor invites an owner into the
  portal, how does the owner accept terms, and what are they bound to?
- **Liability between provider, advisor, and owner.** We supply the tool; the
  advisor supplies the professional advice. Make the boundary explicit and
  indemnify accordingly so we are not liable for an advisor's advice or misuse.
- **White-label / firm branding shipped 2026-07-21** (CLAUDE.md; firms brand the
  product). Counsel to address: trademark use/attribution ("powered by"),
  avoiding customer confusion about who is responsible, and preserving our marks
  under co-branding.
- **Firm-injected disclosures.** Branded PDFs render a firm-configurable
  `footer_disclosure_md` field (`server/pdf.ts`). Two issues: (a) firms can add
  their *own* disclaimer text, so our required disclaimers (§3) must be
  **non-removable** and render regardless of firm branding; and (b) allocate
  liability for whatever text a firm injects (their content, their
  responsibility).
- **Advisor as controller** of owner data — reconcile with the DPA roles (§4).

---

## 12. Beta-specific terms

- Beta / complimentary access terms: **"as is," no SLA**, right to change or
  discontinue features, a **feedback license**, and how beta terms convert to
  paid terms. Present in the scaffold as `COUNSEL_TODO` — close before onboarding
  the first paying firm.

---

## 13. Insurance (raise with counsel + broker)

- **Technology E&O / professional liability**, **cyber liability**, and general
  liability — sizing given the sensitivity of the data and the reliance-risk
  profile. Not legal drafting, but counsel should flag it as a go-live gate.

---

## 14. Suggested priority for go-live (exitblueprint.net, docs/29)

**Must-have before public go-live / first paying firm**

1. Finalized **Terms of Service** + **Privacy Policy** (§2, §4).
2. **In-product disclaimers** wording + placement signed off — score, valuation,
   AI narrative, report/PDF footers (§3).
3. **IP assignment + NDA** confirmed for all contributors; ToS
   confidentiality/anti-reverse-engineering clauses (§5).
4. **Data-use / benchmarking license** language in ToS/DPA so the moat is not
   forfeited (§7).
5. **Trademark clearance search** started; **DPA** ready to execute per firm.

**Fast-follow**

6. Trademark filings (§6); breach-notification deadline finalized in the DPA
   (§4); insurance placed (§13); white-label attribution terms (§11);
   **review of any external paid-data licenses** before that data is blended into
   the valuation engine or calibration corpus (§8).

---

*Cross-references: CLAUDE.md (architecture rules), `src/pages/legal/content.ts`
(the draft ToS/Privacy/DPA/sub-processor scaffold), `seed/subprocessors.csv`,
docs/09 (moats), docs/13 & docs/16 (security controls that back the reps),
docs/29/30 (go-live), `src/pages/ValuationPage.tsx` (existing valuation
disclaimer).*
