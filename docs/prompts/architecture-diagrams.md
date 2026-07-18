# Prompt — ExitBlueprint: 3 Technical Architecture Diagrams

Paste the block below into a Claude chat. It is **self-contained** — a fresh chat
with no repo access can produce accurate diagrams from the embedded facts. (If the
target session *does* have the repo, add: "You may also consult
`docs/01-architecture.md`, `docs/02-data-model.md`, `docs/03-scoring-engine-spec.md`,
and `server/functions.ts`.")

The three diagrams are chosen to cover what people most need to understand the
bigger system: (1) the **runtime topology** and trust boundary, (2) the **domain
data model** and its rules, and (3) the **two flows** — the deterministic-scoring
vs. AI-narrative separation that is ExitBlueprint's defining architectural principle.

---

```text
You are a senior software architect. Produce THREE technical architecture diagrams,
each followed by a concise explanation, that let a new engineer or technical
stakeholder understand the ExitBlueprint system end to end. Render everything as
Mermaid diagrams inside a SINGLE self-contained HTML artifact that is theme-aware
(legible in light and dark). Be strictly accurate to the facts below — do not
invent components. Where a fact is an architectural *rule*, make the diagram show
it visually (a trust boundary, a separation line, an "immutable" marker, etc.).

════════════════════════════════════════════════════════════════════════
WHAT EXITBLUEPRINT IS
════════════════════════════════════════════════════════════════════════
An exit-readiness platform for lower-middle-market business owners, sold THROUGH
M&A advisors (CEPA/CFP). It measures a deterministic "Deal Readiness Score" (DRS)
and a separate "Owner Readiness Index" (ORI), diagnoses named gaps, prescribes
remediation playbooks/tasks, builds a document-verified diligence binder, and
generates advisor deliverables — over a 12–36 month pre-deal engagement.

════════════════════════════════════════════════════════════════════════
NON-NEGOTIABLE ARCHITECTURE RULES  (make these visible in the diagrams)
════════════════════════════════════════════════════════════════════════
1. Deterministic scoring: the DRS/ORI is produced by rule-based, VERSIONED code
   (a reference implementation, reference_scorer.py, is the source of truth). No
   LLM ever computes, adjusts, or influences a score.
2. AI is narrative-only: Claude writes reports/briefs FROM structured data, always
   labeled draft. It NEVER writes TO scoring tables.
3. Rubric lives in DATA, not code: dimensions, questions, sub-scores, weights,
   bands, gap definitions are rows (rubric_versions). Methodology changes ship as
   a new rubric_version, never edited engine logic.
4. Engagement is the unit: assessments are IMMUTABLE snapshots tied to a
   rubric_version; corrections supersede (new row), never mutate. History/deltas
   are first-class.
5. Multi-tenant from day one: every domain table carries firm_id; Postgres
   row-level security (RLS) enforces firm isolation.
6. Two score groups, never mixed: business_readiness dimensions → DRS;
   owner_readiness dimensions → the separate ORI.
7. Versioning everywhere: rubric_version (assessments), prompt_version (AI docs),
   playbook_version (task sets), valuation_rules_version (valuations).

════════════════════════════════════════════════════════════════════════
GROUNDING FACTS
════════════════════════════════════════════════════════════════════════
STACK & RUNTIME
- Frontend: React + Vite single-page app (advisor workspace + a lighter owner
  portal), hosted on Vercel.
- Backend compute: a single PORTABLE FUNCTION ROUTER (handleFunctionCall) that
  authorizes every call through RLS (queries run AS the caller) and then dispatches
  with a service-role client. It has NO dependency on the HTTP transport. In dev a
  Vite plugin mounts it as an emulator; in prod the same logic mounts on a host
  (Vercel serverless / a small Node service). Contract: FunctionContext { userId,
  asUser<T>(RLS-scoped runner), service (service-role client) }.
- Data/auth/storage: Supabase (Postgres + Auth + RLS + Storage).
- AI: Anthropic Claude API, called ONLY from the server-side narrative service
  (the API key never reaches the browser). Every call is logged to an llm_calls
  cost ledger with a versioned prompt registry; a "narrative guard" rejects any
  drafted number not present in the source structured data.
- Scheduled workflows: external n8n calls authenticated webhook endpoints
  (stale-engagements, stalled-tasks, reassessment-due) — this repo only exposes
  the endpoints.
- Pluggable seams (no vendor hard-coded): ParserAdapter (document extraction —
  manual default; fixture/Reducto/LlamaParse selectable) and StorageAdapter
  (document bytes — DB blob now, object storage later).

SECURITY & MULTI-TENANCY
- RLS helpers: app.user_role(), app.user_firm_id(), app.user_company_id().
- Roles: admin, advisor, reviewer, owner.
- Documents: AES-256-GCM encrypted at rest; served only via short-expiry
  HMAC-signed URLs; append-only data_access_log; MFA (TOTP) for advisor/admin;
  30-min idle-session timeout.
- Sub-processors: Supabase, Vercel, Anthropic.

DATA MODEL (core entities; all firm_id + RLS unless noted)
- Tenancy/people: firms, profiles (roles), companies, engagements.
- Rubric (GLOBAL methodology, not firm-scoped): rubric_versions → dimensions →
  questions, sub_scores, gap_definitions; playbooks + playbook_task_templates;
  content_modules; gap_playbook_map, gap_content_map; advisory_library_items.
- Assessment lifecycle: assessments (immutable, rubric_version, record_status
  active|superseded, sequence_number) → answers, sub_score_results,
  dimension_scores; gaps (open→resolved) → tasks.
- Value: valuation_rules_versions, valuation_inputs, ebitda_recasts/addbacks
  (EV, wealth gap, net-to-owner).
- Evidence: documents → document_blobs (+ enc_algo) + document_fields (verified
  facts) + field_corrections; data_room_sections/items (global) +
  engagement_data_room_items.
- Sell-side intelligence (document-verified graph): graph_nodes, graph_edges
  (ontology in data), assessment_values (self-reported vs verified reconciliation),
  findings, jobs (resumable pipeline), review_items, llm_calls.
- Institutional memory / outcomes: engagement_log (advisor meetings/decisions/
  rationale, staff-only), engagement_outcomes + outcome_events + deal_outcomes
  (outcome calibration substrate), usage_events (instrumentation).
- AI output: generated_documents (owner_report | advisor_brief | delta_report;
  prompt_version; finalized_at — draft until an advisor finalizes).
- Data rights: agreement_versions + engagement_agreements (consent gate — a
  BEFORE-INSERT trigger blocks any assessment without a recorded acceptance).

THE PIPELINES
- Deterministic scoring: answers → scoreAssessment(assessment_id) (rule-based
  engine, matches reference_scorer exactly) → sub_score_results + dimension_scores
  → DRS (business dims) + ORI (owner dims) + tier → open/resolve gaps → gaps map to
  playbooks → instantiate tasks. NO LLM anywhere on this path.
- Evidence/verification (resumable jobs): upload → virus scan → classify →
  parse (ParserAdapter) → extract fields → populate graph → reconcile
  (self-reported vs document-verified, conflicts → review queue) → findings.
- AI narrative: structured data (scores, gaps, valuation) → server narrative
  service → Claude (prompt_version, llm_calls, narrative guard) →
  generated_documents (labeled DRAFT) → advisor edits & finalizes.

════════════════════════════════════════════════════════════════════════
THE THREE DIAGRAMS TO PRODUCE
════════════════════════════════════════════════════════════════════════
DIAGRAM 1 — System context & runtime topology (a C4-style container diagram).
  Use a Mermaid `flowchart`. Show: the browser SPA (advisor + owner) → the portable
  function router (note "dev: Vite emulator / prod: Vercel or Node host") → Supabase
  (Postgres+RLS, Auth, Storage) → Anthropic API; plus n8n → webhooks; plus the
  ParserAdapter/StorageAdapter seams. EMPHASIZE the trust boundary (browser vs
  server), that the Anthropic key and service-role client live only server-side,
  that RLS is enforced IN Postgres, and that authorize() runs AS the caller while
  dispatch() uses service-role. Add a legend for the boundary.

DIAGRAM 2 — Domain data model (a Mermaid `erDiagram`).
  Show the core entities and relationships grouped as: Tenancy, Rubric (global),
  Assessment lifecycle, Evidence, Intelligence graph, Outcomes/Institutional memory,
  AI output. Annotate: firm_id + RLS on domain tables; rubric tables are GLOBAL;
  assessments are IMMUTABLE and carry rubric_version + record_status; the DRS vs ORI
  split; the consent-gate trigger on assessments. Keep it readable — include the
  ~20 most important tables, not every column.

DIAGRAM 3 — The two flows: deterministic scoring vs. evidence → AI narrative.
  Use a Mermaid `flowchart` with a clear DIVIDING LINE (e.g., two subgraphs) between
  the DETERMINISTIC engine and the AI/evidence side. Left/top: answers → rule-based
  scoreAssessment (reference_scorer parity) → sub_score_results/dimension_scores →
  DRS + ORI → gaps → playbooks → tasks. Right/bottom: document upload → parse →
  extract → graph → reconcile → findings; and structured-data → Claude
  (prompt_version, narrative guard, llm_calls) → generated_documents (DRAFT) →
  advisor finalize. EMPHASIZE with an explicit annotated arrow/barrier that AI reads
  FROM structured data but NEVER writes TO scoring tables (rules 1 & 2).

════════════════════════════════════════════════════════════════════════
OUTPUT REQUIREMENTS
════════════════════════════════════════════════════════════════════════
- One self-contained artifact, theme-aware, three Mermaid diagrams in order, each
  followed by a 4–6 sentence explanation written for an engineer.
- Diagram 1 & 3: `flowchart`; Diagram 2: `erDiagram`.
- Make the non-negotiable rules legible in the visuals (trust boundary, immutability,
  rubric-in-data, the deterministic/AI separation, firm-level RLS).
- Include a one-line legend per diagram. Keep labels accurate to the facts above;
  if you must simplify, note the simplification rather than inventing detail.
```
