// The six-engine function registry — one declarative table for every
// `/functions/v1/<name>` compute endpoint. This is the structural spine that
// makes the platform-architecture engine model (docs/28-architecture-map.md,
// ExitBlueprintPlatformArchitecture §01) a property of the code rather than a
// picture in a doc: every endpoint declares which ENGINE it belongs to, which
// AUTH SCOPE gates it, whether it is billing-GATED, and its HANDLER — in one
// place, next to its siblings in the same engine.
//
// Why a registry (the "declarative function registry" consolidation in
// docs/27-engineering-patterns.md): the old router wired each function in three
// separate places — an authorize Set, a dispatch `case`, and the handler. Three
// edits, three chances to forget one, and the engine a function belonged to was
// nowhere in the code. A new function is now a single REGISTRY entry, and it is
// *impossible* to add one without assigning it an engine and an explicit,
// auditable auth scope. functions.ts stays the guarded gateway; it reads this
// table instead of a hand-maintained switch.
//
// The engines are NOT services — they are a way of reading a single codebase
// (architecture doc §01). Identity is the authorize/RLS layer itself
// (functions.ts + Postgres), which is why no endpoint is tagged `identity`: the
// gateway that reads this registry *is* the Identity Engine.
import type pg from 'pg';
import { compareAssessments, explainAssessment, scoreAssessment } from './scoring';
import { generateDocument } from './narrative';
import { instantiateTasksForGaps } from './roadmap';
import { fireAdvisoryItems, educationModules } from './advisory';
import { verificationSummary } from './verification';
import { syncLedgerToAssessment, enterManualFinancials, type ManualFinancialEntry } from './ledger';
import { extractFinancials } from './pl-extract';
import { beginLedgerConnect, completeLedgerConnect, disconnectLedger } from './ledger-oauth';
import { computeValuation } from './valuation';
import { recordDealOutcome, firmCalibration, type DealOutcomeInput } from './outcomes';
import { computeCalibration, readCalibration } from './calibration';
import { recordBenchRun } from './bench-metrics';
import { engagementGraph } from './engagement-graph';
import { generateEngagementGraphBrief } from './engagement-brief';
import { generateInstitutionalReview } from './institutional-review';
import { runDiligenceSimulation, latestDiligenceSimulation } from './diligence-simulation';
import { answerDiligenceQuestion, listDiligenceQa } from './diligence-qa';
import { createCheckoutSession, createBillingPortalSession, getStripe, stripeConfigured } from './stripe';
import { inviteOwner } from './invite';
import { inviteAdvisor } from './invite-advisor';
import { inviteCollaborator, revokeCollaborator } from './collaborators';
import { shareAssessmentWithClient, submitClientIntake } from './client-portal';
import { assignEngagement } from './organization';
import { createEngagementWithAgreement } from './agreements';
import { deleteEngagement } from './engagements';
import { exportEngagement } from './export';
import { firmAttention } from './attention';
import {
  listPlanTemplates,
  createPlan,
  updatePlan,
  applyPlan,
  autoApplyQualifyingPlans,
  engagementPlanProgress,
  recommendPlans,
} from './plans';
import {
  getDocumentBytes,
  getDocumentDetail,
  listReviewQueue,
  submitDocumentReview,
  uploadDocument,
} from './documents/pipeline';
import { signDocumentToken } from './documents/signed-url';
import { runEngagementVerification } from './sellside';
import { attachDataRoomDocument, evidenceCoverage, listDataRoom, setDataRoomItem } from './data-room';
import { buildCimCoverage } from './cim';
import { engagementComparables } from './comparables';
import { retrieveMarketContext } from './market-retrieval';
import { marketIndustryKey, marketSizeBand } from '../shared/market-keys';
import { rankEngagementBuyers } from './buyer-matching';
import {
  claimReviewItem,
  escalateReviewItem,
  resolveReviewItem,
  reviewMetrics,
  type ResolveInput,
} from './review-queue';
import { logAccess } from './audit';
import { seedMethodology } from './seed-methodology';
import { listPromptTemplates, setPromptTemplate, resetPromptTemplate } from './prompt-registry';
import { renderDocumentPdf } from './documents/catalog';
import { extractAnswerCandidates, confirmAnswerCandidate } from './answer-extraction';
import { advisorCopilot } from './copilot';

// ── The six engines (architecture doc §01) ────────────────────────────────────
// Every endpoint belongs to exactly one. `identity` is intentionally never used
// by an endpoint: it is the cross-cutting gateway (authorize + RLS), not a set of
// features. Keeping it in the union documents that the taxonomy is complete.
export const ENGINES = [
  'identity', // WHO & WHAT — authn/authz/tenancy/permissions/audit (the gateway itself)
  'knowledge', // WHAT WE KNOW — assessments, evidence, financials, outcomes (the IP substrate)
  'workflow', // WHAT HAPPENS NEXT — engagement lifecycle & progression
  'rules', // THE FACTS — deterministic scoring, valuation, roadmap, calibration
  'reasoning', // THE EXPLANATION — AI narratives & assembled documents (draft-only)
  'collaboration', // WHO PARTICIPATES — invites, review queue, verification hand-offs
] as const;
export type Engine = (typeof ENGINES)[number];

// ── Auth scopes ───────────────────────────────────────────────────────────────
// Each scope names one authorization strategy that functions.ts's authorize()
// implements. Declaring the scope per function (rather than inferring it from
// whatever id happens to be in the body) makes every endpoint's gate explicit and
// auditable — the security-critical property CLAUDE.md asks for.
// One scope == one unambiguous authorization procedure in functions.ts. Scopes
// are deliberately fine-grained (upload vs. queue vs. document; connect vs.
// complete) so each carries exactly one auditable gate — never a name-switch or a
// body-shape guess inside the gateway.
export type AuthScope =
  | 'firm' // firm-scoped readout; firm resolved from the advisor/admin profile
  | 'admin' // firm-scoped ORG administration; firm resolved from an admin-only profile
  | 'create-engagement' // advisor firm + the target company visible under RLS
  | 'delete-engagement' // advisor/admin firm + the target engagement visible under RLS
  | 'export-engagement' // advisor/admin firm + the target engagement visible under RLS (read-only)
  | 'document-upload' // staff (advisor+reviewer); engagement id visible under RLS
  | 'review-queue' // staff; firm-scoped, no id (the queue is the whole firm)
  | 'document' // staff; the referenced document is visible under RLS
  | 'sellside-engagement' // staff; engagement id must be visible under RLS
  | 'sellside-item' // staff; engagement resolved FROM the review item, then RLS
  | 'ledger-connect' // company id in the body must be visible under RLS
  | 'ledger-complete' // company resolved from the pending oauth state (may pass through)
  | 'engagement' // the referenced engagement is visible to the caller under RLS
  | 'manage-engagement' // firm staff (advisor/admin) + the target engagement visible under RLS
  | 'assessment' // the referenced assessment(s) are visible to the caller under RLS
  | 'assessment-staff' // firm staff (advisor/admin) + the referenced assessment(s) visible under RLS
  | 'platform-admin'; // cross-tenant governance; caller's id in the superadmin allowlist

export type FunctionResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'pdf'; filename: string; buffer: Uint8Array }
  | { kind: 'binary'; mime: string; filename: string; buffer: Uint8Array };

// What every handler receives once authorize() and the billing gate have passed:
// the service-role client (RLS bypassed — the privileged work an edge function
// does), the request body, the caller's resolved firm (null for engagement/
// assessment-scoped calls), and the caller's user id.
export interface HandlerArgs {
  service: pg.ClientBase;
  body: Record<string, unknown>;
  firmId: string | null;
  userId: string;
  // An RLS-scoped query runner (queries execute AS the caller). Most handlers do
  // their privileged work on `service` (RLS bypassed) and never need this; the
  // document renderers use it so the narrative row they return is one RLS grants
  // the caller — the authorization boundary for client-facing PDFs.
  asUser: <T>(fn: (db: pg.ClientBase) => Promise<T>) => Promise<T>;
}

export interface FunctionSpec {
  engine: Engine;
  scope: AuthScope;
  gated?: boolean; // a paid action (docs/24 §5.3); billing gate refuses if unentitled
  handler: (args: HandlerArgs) => Promise<FunctionResult>;
}

export const ok = (body: unknown): FunctionResult => ({ kind: 'json', status: 200, body });
export const err = (status: number, message: string): FunctionResult => ({
  kind: 'json',
  status,
  body: { message },
});

// ── Reasoning Engine: assembled PDF documents ─────────────────────────────────
// Facts (deterministic) + narrative (AI, draft) + branding → a rendered PDF. The
// assembly for every document type lives in one place, server/documents/catalog.ts,
// keyed by doc_type; this thin adapter maps its result onto a FunctionResult. The
// document reads the structured result and the generated narrative; it never
// authors a number (architecture doc §10).
async function documentPdf(
  service: pg.ClientBase,
  docType: string,
  assessmentId: string,
  asUser: HandlerArgs['asUser'],
): Promise<FunctionResult> {
  const result = await renderDocumentPdf(service, docType, assessmentId, asUser);
  if (!result.ok) return err(result.status, result.message);
  return { kind: 'pdf', filename: result.filename, buffer: result.buffer };
}

// Resolve the caller's profile id in one firm (provenance for staff actions).
async function staffActorId(service: pg.ClientBase, userId: string, firmId: string): Promise<string | null> {
  return (
    (await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId]))
      .rows[0]?.id ?? null
  );
}

// Resolve the caller's profile id regardless of firm (owners carry no firm_id).
async function anyActorId(service: pg.ClientBase, userId: string): Promise<string | null> {
  return (await service.query(`select id from profiles where user_id = $1`, [userId])).rows[0]?.id ?? null;
}

// ── The registry ──────────────────────────────────────────────────────────────
// Grouped by engine. Handlers are unchanged from the prior dispatch() switch —
// same queries, same behavior — now keyed by name with their engine and scope
// declared alongside.
export const REGISTRY: Record<string, FunctionSpec> = {
  // ── Rules Engine — deterministic facts (scoring, valuation, roadmap, calibration)
  'score-assessment': {
    engine: 'rules',
    scope: 'assessment-staff', // advisor-only submit: an owner may see a shared draft but never score it
    gated: true,
    handler: async ({ service, body, userId }) => {
      const assessmentId = body.assessment_id as string;
      const result = await scoreAssessment(service, assessmentId);
      // Prescribe automatically (docs/37): with the scored gaps committed,
      // auto-apply the qualifying system/firm Plans so the roadmap is populated
      // the moment an assessment is scored — the software is useful out of the box
      // without a manual "generate roadmap" step. Best-effort: a prescription
      // hiccup must never fail an otherwise-successful score (the advisor can
      // still generate the roadmap by hand). Idempotent and safe on re-assessment.
      try {
        const eng = (
          await service.query(`select engagement_id from assessments where id = $1`, [assessmentId])
        ).rows[0];
        if (eng) await autoApplyQualifyingPlans(service, eng.engagement_id as string, userId ?? null);
      } catch (err) {
        console.error(
          `auto-apply plans after scoring ${assessmentId} failed: ${(err as Error).message}`,
        );
      }
      return ok(result);
    },
  },
  'explain-assessment': {
    engine: 'rules',
    scope: 'assessment',
    handler: ({ service, body }) => explainAssessment(service, body.assessment_id as string).then(ok),
  },
  'compare-assessments': {
    engine: 'rules',
    scope: 'assessment',
    handler: ({ service, body }) =>
      compareAssessments(
        service,
        body.prior_assessment_id as string,
        body.current_assessment_id as string,
      ).then(ok),
  },
  // Build the roadmap from gaps (docs/37 Q5b): auto-apply every Plan whose
  // content is majority-applicable to the engagement's open gaps. Playbooks are
  // retired — applying a Plan is the sole path that lays tasks onto the roadmap,
  // reusing applyPlan's once-per-engagement idempotency (a claimed task is never
  // doubled). The applied-Plan summaries ride back so the UI can report what it
  // added.
  'generate-roadmap': {
    engine: 'rules',
    // Materializes tasks/plans on the engagement — a staff write, so
    // manage-engagement (advisor/admin only) rather than the read-open
    // 'engagement' scope, which any owner/collaborator who can see the
    // engagement would pass.
    scope: 'manage-engagement',
    gated: true,
    handler: async ({ service, body, userId }) => {
      const engagementId = body.engagement_id as string;
      const anchorDate = (body.anchor_date as string) ?? null;
      const roadmap = await instantiateTasksForGaps(service, engagementId, anchorDate, userId);
      return ok({ tasksCreated: roadmap.tasksCreated, plansApplied: roadmap.plansApplied });
    },
  },
  'compute-valuation': {
    engine: 'rules',
    scope: 'engagement',
    gated: true,
    handler: ({ service, body }) => computeValuation(service, body.engagement_id as string).then(ok),
  },
  'engagement-comparables': {
    engine: 'rules',
    // Returns SIBLING engagements across the firm (other clients' names, DRS
    // scores, outcomes) as "relevant historical cases". That is firm-staff
    // intelligence, not engagement-scoped data: the read-open 'engagement' scope
    // would let an owner-client — or a view-only external collaborator pinned to
    // one engagement — enumerate the firm's whole client book. Requires
    // advisor/admin staff (manage-engagement).
    scope: 'manage-engagement',
    handler: ({ service, body }) => engagementComparables(service, body.engagement_id as string).then(ok),
  },
  'engagement-buyer-matches': {
    engine: 'rules',
    // Ranks the FIRM'S OWN buyer book against this engagement (buyer names,
    // mandates, relationship strength). Like engagement-comparables this is
    // firm-staff intelligence, not engagement-scoped data — the read-open
    // 'engagement' scope would let an owner or a pinned collaborator enumerate the
    // firm's buyer book. Requires advisor/admin staff (manage-engagement).
    scope: 'manage-engagement',
    handler: ({ service, body }) => rankEngagementBuyers(service, body.engagement_id as string).then(ok),
  },
  'advisory-items': {
    engine: 'rules',
    scope: 'engagement',
    handler: ({ service, body }) => fireAdvisoryItems(service, body.engagement_id as string).then(ok),
  },
  'education-modules': {
    engine: 'rules',
    scope: 'engagement',
    handler: ({ service, body }) => educationModules(service, body.engagement_id as string).then(ok),
  },
  'deal-calibration': {
    engine: 'rules',
    scope: 'firm',
    handler: ({ service, firmId }) => firmCalibration(service, firmId as string).then(ok),
  },
  // Cross-engagement gap-remediation effectiveness (docs/09 moat 3, "the
  // engagement graph"): which cleared gaps moved the score, across the firm's
  // engagements. Deterministic, read-only descriptive analytics over existing
  // rows (same-rubric deltas only, mirroring compare-assessments); no LLM, no
  // write. Firm-scoped; not a paid action, so ungated.
  'engagement-graph': {
    engine: 'rules',
    scope: 'firm',
    handler: ({ service, firmId }) => engagementGraph(service, firmId as string).then(ok),
  },
  // The narrative half of the engagement graph (WS-GRAPH, docs/09 moat 3): drafts a
  // labeled brief FROM the deterministic engagement graph (+ optional firm
  // calibration) so an advisor reads back "gaps like these moved the DRS by about X,
  // and their deals closed around Y." Reasoning Engine, narrative-only (rules 1-2):
  // every figure is the graph's, the model only frames the pattern; output is always
  // a draft. Firm-scoped and read-only (persist 'none'); not a paid action, so ungated.
  'engagement-graph-brief': {
    engine: 'reasoning',
    scope: 'firm',
    handler: ({ service, firmId }) => generateEngagementGraphBrief(service, firmId as string).then(ok),
  },
  // Platform administration — load the canonical /seed methodology (rubric,
  // playbooks, valuation rules, data-room template, …) into the DB from inside
  // the system, so a hosted beta seeds itself without anyone running the CLI
  // against a production connection string. Superadmin-gated (`platform-admin`
  // scope — cross-tenant, above firm admin), runs the SAME validated pipeline as
  // `npm run db:seed` with the service-role client, and is idempotent. Belongs to
  // the Rules Engine: the rubric IS the deterministic facts (CLAUDE.md rules 1 & 3).
  'seed-methodology': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: async ({ service }) => ok(await seedMethodology(service)),
  },
  // Narrative prompt registry (docs/04). The bundled prompts/<key>.md files are
  // the versioned default; a platform superadmin may override a prompt's body
  // in-system (no code deploy) and reset back to the file. Superadmin-gated
  // (`platform-admin` — cross-tenant governance, above firm admin). The numeral
  // firewall + rule-based composer fallback (server/narrative.ts) are code,
  // independent of prompt text, so an edited/empty prompt can never inject
  // invented numbers or hard-fail a delivery (rules 1/2). Reads/writes the walled,
  // service-role-only analytics.prompt_templates (tenant-invisible, no firm_id).
  'list-prompts': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service }) => listPromptTemplates(service).then(ok),
  },
  'set-prompt': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service, body, userId }) => setPromptTemplate(service, body, userId ?? null).then(ok),
  },
  'reset-prompt': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service, body }) => resetPromptTemplate(service, body).then(ok),
  },
  // Outcome Calibration Engine — the "FICO moat" (docs/09 moat 1, docs/40 §3).
  // compute-calibration reads the cross-firm deal_outcomes corpus and PERSISTS a
  // new, versioned calibration artifact: DRS/ORI score band → close rate, realized
  // multiple (median + interquartile), time-to-close, within-range hit rate, EV
  // variance, retrade rate. Deterministic rule-based code (shared/calibration/
  // compute.ts), never an LLM (rule #1); it appends an immutable snapshot and never
  // edits a score or a rubric in place (rules #3, #4). CROSS-FIRM aggregate
  // intelligence, so it is superadmin-gated (`platform-admin` scope) and runs on the
  // service-role connection ONLY — the artifact it writes is de-identified (no
  // firm_id, no PII), mirroring seed-methodology and the analytics rail (rule #5).
  'compute-calibration': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service, body }) =>
      computeCalibration(service, {
        band_width: (body.band_width as number) ?? undefined,
        min_sample: (body.min_sample as number) ?? undefined,
      }).then(ok),
  },
  // Read the latest persisted calibration snapshot. Same superadmin gate — the
  // artifact is cross-firm aggregate intelligence, never a firm-facing read.
  'read-calibration': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service }) => readCalibration(service).then(ok),
  },
  // Deliverable-quality bench (docs/sellside-ai/02, docs/09). run-bench grades the
  // generated deliverables — static tier over frozen fixtures + generated tier over
  // the real deterministic composer for a completed assessment — and PERSISTS the
  // per-case answer/source grades as a new run in the service-role-only analytics
  // schema. The grader is pure rule-based code (server/llm/evals/bench.ts), never an
  // LLM (rule #1); it grades deliverable quality and never writes to a scoring table
  // (rule #2). PLATFORM-QUALITY telemetry (not client data), so superadmin-gated
  // (`platform-admin` scope) on the service-role connection ONLY — mirroring
  // compute-calibration; the rows it writes are de-identified (no firm_id, no PII).
  'run-bench': {
    engine: 'rules',
    scope: 'platform-admin',
    handler: ({ service }) => recordBenchRun(service).then(ok),
  },

  // ── Reasoning Engine — AI narratives & assembled documents (always draft)
  'generate-document': {
    engine: 'reasoning',
    scope: 'assessment-staff', // staff-only: owners render finalized docs, never generate drafts
    gated: true,
    handler: ({ service, body }) =>
      generateDocument(service, body.assessment_id as string, (body.doc_type as string) ?? 'owner_report').then(ok),
  },
  // The one endpoint the Deliverables studio renders through: it names the
  // document type in the body, and the catalog assembles the matching branded
  // PDF. The three render-<type>-pdf entries below are thin, stable aliases kept
  // so existing links (owner portal, bookmarks) and callers keep working.
  'render-document-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body, asUser }) =>
      documentPdf(service, (body.doc_type as string) ?? 'owner_report', body.assessment_id as string, asUser),
  },
  'render-owner-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body, asUser }) => documentPdf(service, 'owner_report', body.assessment_id as string, asUser),
  },
  'render-delta-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body, asUser }) => documentPdf(service, 'delta_report', body.assessment_id as string, asUser),
  },
  'render-cim-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body, asUser }) => documentPdf(service, 'cim', body.assessment_id as string, asUser),
  },
  // AI-as-institutional-reviewer (docs/20 "AI as an intelligence layer", docs/04).
  // Reviews the assembled structured data — scores, gaps, evidence posture, fired
  // buyer-lens items — and drafts blind spots / missing evidence / likely
  // diligence questions. Narrative-only (CLAUDE.md rules 1-2): it surfaces
  // patterns FROM deterministic output, never computes/adjusts/grades a score;
  // output is always labeled draft and prompt_version'd. Assessment-scoped, gated
  // like the other reasoning deliverables.
  'institutional-review': {
    engine: 'reasoning',
    scope: 'assessment-staff', // staff-only AI reviewer, not owner-consumed
    gated: true,
    handler: ({ service, body }) =>
      generateInstitutionalReview(service, body.assessment_id as string).then(ok),
  },
  // Diligence Simulation (docs/20, docs/40 §3) — the proactive extension of the
  // institutional reviewer. Reuses buildInstitutionalReviewPayload, turns it into a
  // RANKED, severity-keyed blind-spot report with remediation pointers, persists it
  // as an immutable run, and drafts the (labeled) narrative that frames it.
  // Narrative-only (CLAUDE.md rules 1-2): findings and their severity come from the
  // engine + catalog, never the model; the model never grades a score and its output
  // is always draft and prompt_version'd. The run WRITES firm-scoped rows, so it is
  // manage-engagement (staff; firm resolved from the profile) and gated like the
  // other reasoning deliverables. The read counterpart is engagement-scoped.
  'simulate-diligence': {
    engine: 'reasoning',
    scope: 'manage-engagement',
    gated: true,
    handler: ({ service, body, firmId }) =>
      runDiligenceSimulation(service, firmId as string, body.engagement_id as string).then(ok),
  },
  'diligence-simulation': {
    engine: 'reasoning',
    scope: 'engagement',
    handler: ({ service, body }) =>
      latestDiligenceSimulation(service, body.engagement_id as string).then(ok),
  },

  // Diligence Q&A (docs/sellside-ai/05 §4): answer a buyer's diligence question
  // FROM the engagement's own cited knowledge. The answer WRITES an immutable,
  // firm-scoped row, so it is manage-engagement (staff; firm resolved from the
  // profile) and gated like the other reasoning deliverables. It degrades to
  // retrieval-only when the AI call fails (no credit) — the same fallback the
  // deliverables path uses. The read counterpart is engagement-scoped.
  'answer-diligence-question': {
    engine: 'reasoning',
    scope: 'manage-engagement',
    gated: true,
    handler: ({ service, body, firmId }) =>
      answerDiligenceQuestion(
        service,
        firmId as string,
        body.engagement_id as string,
        body.question as string,
      ).then((qa) => ok({ qa })),
  },
  'list-diligence-qa': {
    engine: 'reasoning',
    scope: 'engagement',
    handler: ({ service, body }) =>
      listDiligenceQa(service, body.engagement_id as string).then((items) => ok({ items })),
  },

  // Advisor copilot (WS-COPILOT): a READ-ONLY natural-language assistant over the
  // firm's own book. It runs a bounded Anthropic tool-use loop over a CURATED subset
  // of registry READ functions (server/copilot-tools.ts — never a write or gated
  // action) and returns a DRAFT-LABELED synthesis. Narrative-only (rules 1-2): the
  // numeral firewall grounds every figure in a tool result and the model authors no
  // number; it degrades to raw tool results when AI is unavailable (no credit).
  // Firm-scoped (firm resolved from the profile) and NOT gated — asking questions
  // about your own book is free; the copilot cannot reach any paid action. v1 is
  // stateless (no persistence, no migration), so it is not an AgentSpec.
  'advisor-copilot': {
    engine: 'reasoning',
    scope: 'firm',
    handler: ({ service, firmId, userId, body }) =>
      advisorCopilot(service, firmId as string, userId, body.question as string).then((result) =>
        ok({ result }),
      ),
  },

  // ── Workflow Engine — Plans (docs/37): reusable initiative bundles
  // Authoring is firm-scoped and ungated (composing methodology is core, not a
  // paid action; applying a Plan to an engagement — PL3 — is where gating lands).
  'list-plans': {
    engine: 'workflow',
    scope: 'firm',
    handler: ({ service, firmId }) => listPlanTemplates(service, firmId as string).then(ok),
  },
  'create-plan': {
    engine: 'workflow',
    scope: 'firm',
    handler: ({ service, firmId, userId, body }) =>
      createPlan(service, firmId as string, body, userId).then(ok),
  },
  'update-plan': {
    engine: 'workflow',
    scope: 'firm',
    handler: ({ service, firmId, userId, body }) =>
      updatePlan(service, firmId as string, body, userId).then(ok),
  },
  // Applied-Plan progress for an engagement (PL4). Read-open 'engagement' scope so
  // owners can see their plans too (docs/37 Q3); the engagement is RLS-checked.
  'list-engagement-plans': {
    engine: 'workflow',
    scope: 'engagement',
    handler: ({ service, body }) =>
      engagementPlanProgress(service, body.engagement_id as string).then((plans) => ok({ plans })),
  },
  // Score-driven Plan recommendation (docs/37 Q5): Plans whose playbooks target
  // the engagement's open gaps, not yet applied. Read-only; staff-facing.
  'recommend-plans': {
    engine: 'workflow',
    scope: 'manage-engagement',
    handler: ({ service, body }) => recommendPlans(service, body.engagement_id as string).then(ok),
  },
  // Apply a Plan to an engagement — materializes tasks/milestones (PL3). Staff
  // write, so manage-engagement (advisor/admin only, resolves the caller's firm),
  // not the read-open 'engagement' scope. Gated: it drives remediation work, a
  // paid action (docs/24 §5.3).
  'apply-plan': {
    engine: 'workflow',
    scope: 'manage-engagement',
    gated: true,
    handler: ({ service, firmId, userId, body }) =>
      applyPlan(service, firmId as string, body, userId).then(ok),
  },

  // ── Workflow Engine — the engagement lifecycle
  'create-engagement': {
    engine: 'workflow',
    scope: 'create-engagement',
    gated: true,
    handler: ({ service, body, firmId, userId }) =>
      createEngagementWithAgreement(service, userId, firmId as string, body).then(ok),
  },
  // Hard-delete an engagement and its entire subtree. Deliberately NOT gated:
  // removing data (or undoing a mis-created engagement) must never be blocked by
  // a lapsed subscription. Restricted to advisor/admin by the delete-engagement
  // scope — owners and reviewers can see an engagement but must not delete it.
  'delete-engagement': {
    engine: 'workflow',
    scope: 'delete-engagement',
    handler: ({ service, body, firmId, userId }) =>
      deleteEngagement(service, firmId as string, userId, body.engagement_id as string).then(ok),
  },
  // Read-only, full data export of an engagement (docs/archive/35 Phase 9). Deliberately
  // NOT gated: a firm taking a copy of its own data out must never be blocked by a
  // lapsed subscription (same posture as delete-engagement).
  'export-engagement': {
    engine: 'workflow',
    scope: 'export-engagement',
    handler: ({ service, body, firmId }) =>
      exportEngagement(service, firmId as string, body.engagement_id as string).then(ok),
  },
  // In-app "Needs attention" worklist for the caller's firm (docs/archive/35 Phase 9).
  // Read-only firm-scoped readout; not gated (viewing your own worklist is free).
  'firm-attention': {
    engine: 'workflow',
    scope: 'firm',
    handler: ({ service, firmId }) => firmAttention(service, firmId as string).then(ok),
  },
  // Reassign which advisor owns an engagement — an admin org control. Scope 'admin'
  // rejects non-admins; the handler validates the engagement + target advisor are
  // in the caller's firm and writes as service_role (the only path past the
  // advisor_id reassignment guard trigger). NOT gated: org administration is never
  // blocked by billing state.
  'assign-engagement': {
    engine: 'workflow',
    scope: 'admin',
    handler: ({ service, body, firmId }) =>
      assignEngagement(
        service,
        firmId as string,
        body.engagement_id as string,
        (body.advisor_id as string | null) ?? null,
      ).then(ok),
  },

  // ── Knowledge Engine — structured business knowledge (evidence, financials, outcomes)
  'sync-ledger': {
    engine: 'knowledge',
    scope: 'assessment-staff', // writes verified financial answers — advisor tool
    handler: async ({ service, body, userId }) => {
      const actor = await anyActorId(service, userId);
      return syncLedgerToAssessment(service, body.assessment_id as string, actor).then(ok);
    },
  },
  'enter-manual-financials': {
    engine: 'knowledge',
    scope: 'assessment-staff', // writes answers + provenance — advisor tool
    handler: async ({ service, body, userId }) => {
      const actor = await anyActorId(service, userId);
      return enterManualFinancials(
        service,
        body.assessment_id as string,
        (body.entries as ManualFinancialEntry[]) ?? [],
        !!body.documented,
        {
          // The stored P&L this claim is attested against; enforced server-side —
          // a `documented` claim with no resolvable document downgrades to
          // self_reported (server/ledger.ts).
          evidenceDocumentId: (body.evidence_document_id as string) ?? null,
          actorProfileId: actor,
        },
      ).then(ok);
    },
  },
  'extract-financials-from-file': {
    engine: 'knowledge',
    scope: 'assessment-staff', // advisor P&L-import tool, keeps the financial group staff-only
    // Read-only: parse an uploaded P&L / financials export into PROPOSED answers
    // for the derivable financial questions. Deterministic, no LLM, writes
    // nothing — the advisor reviews the proposals and applies them through
    // enter-manual-financials, which stamps `document` provenance.
    handler: async ({ body }) => {
      const bytes = Buffer.from((body.content_base64 as string) ?? '', 'base64');
      return ok(
        extractFinancials({
          bytes,
          filename: (body.filename as string) ?? '',
          mimeType: (body.mime_type as string) ?? null,
        }),
      );
    },
  },
  // Answer extraction (docs/sellside-ai WS-EXTRACT). Reads a data-room document
  // and PROPOSES candidate answers into the answer_candidates STAGING queue — the
  // AI never writes to a scoring table (rules 1 & 2). Writes firm-scoped rows and
  // materializes proposals on the engagement's open assessment, so it is
  // manage-engagement (advisor/admin staff; firm resolved from the profile), like
  // the other engagement-writing knowledge endpoints. The economy model tier does
  // the mechanical, values-only extraction; the strict schema rejects bad output.
  'extract-answer-candidates': {
    engine: 'knowledge',
    scope: 'manage-engagement',
    handler: ({ service, body, firmId }) =>
      extractAnswerCandidates(service, {
        firmId: firmId as string,
        engagementId: body.engagement_id as string,
        documentId: body.document_id as string,
      }).then(ok),
  },
  // Confirm a pending candidate → promote it to a real assessment answer through
  // the EXISTING deterministic answer-writing path (so scoring stays rule-based +
  // human-gated). Staff action (advisor/reviewer/admin) — a reviewer confirming an
  // extracted answer is exactly the review-hand-off shape — so the staff
  // sellside-engagement scope (firm from profile, engagement visible under RLS).
  // The candidate id names WHICH proposal; the engagement id gates authorization.
  'confirm-answer-candidate': {
    engine: 'knowledge',
    scope: 'sellside-engagement',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return confirmAnswerCandidate(service, body.candidate_id as string, actor).then(ok);
    },
  },
  'verification-summary': {
    engine: 'knowledge',
    scope: 'assessment',
    handler: ({ service, body }) => verificationSummary(service, body.assessment_id as string).then(ok),
  },
  'record-deal-outcome': {
    engine: 'knowledge',
    // Records/overwrites the final deal result (an upsert on engagement_id) — an
    // advisor action that feeds the firm's calibration corpus and the cross-firm
    // calibration moat. Must be staff-only: the read-open 'engagement' scope let
    // an owner set or overwrite outcome/final_ev/multiple on their own engagement.
    scope: 'manage-engagement',
    handler: ({ service, body }) =>
      recordDealOutcome(
        service,
        body.engagement_id as string,
        (body.input as DealOutcomeInput) ?? ({} as DealOutcomeInput),
      ).then(ok),
  },
  'list-data-room': {
    engine: 'knowledge',
    scope: 'engagement',
    // Authorized via the generic engagement path (staff by firm, owner by
    // company). Read-only view of the template + this engagement's states.
    handler: ({ service, body }) => listDataRoom(service, body.engagement_id as string).then(ok),
  },
  'cim-coverage': {
    engine: 'knowledge',
    scope: 'engagement',
    // Read-only: which CIM sections are backed by Ready/verified evidence.
    handler: ({ service, body }) => buildCimCoverage(service, body.engagement_id as string).then(ok),
  },
  'evidence-coverage': {
    engine: 'knowledge',
    scope: 'engagement',
    // Read-only: the single "diligence binder" figure — how many applicable
    // items are proven (Ready + a verified document). Powers the Evidence
    // masthead headline; the caller is already authorized on the engagement.
    handler: ({ service, body }) => evidenceCoverage(service, body.engagement_id as string).then(ok),
  },
  // Market-context retrieval (docs/sellside-ai/01, build order step 2) — the read
  // side of the reasoning lane's market RAG, structured + full-text (NO pgvector;
  // semantic embeddings are a documented follow-on). Resolves THIS engagement's
  // company industry → industry_key (marketIndustryKey, the same key-space as the
  // valuation table + own-book) and revenue_band → size_band, then returns the top
  // licensed passages, EACH with its citation, as an input to the narrative
  // payloads. Knowledge engine (the IP substrate it reads from), read-open
  // 'engagement' scope: the engagement is RLS-checked and the industry/size keys are
  // derived from its OWN company row — firm_id is NEVER trusted from the body (the
  // market schema is non-tenant, so there is no firm filter anyway). Requests the
  // most restrictive exposure ('aggregate_only'); a display-tier consumer passes a
  // stricter exposure. Deterministic plumbing — no LLM in the retrieval loop.
  'retrieve-market-context': {
    engine: 'knowledge',
    scope: 'engagement',
    handler: async ({ service, body }) => {
      const engagementId = body.engagement_id as string;
      const eng = (
        await service.query(
          `select c.industry, c.revenue_band
             from engagements e join companies c on c.id = e.company_id
            where e.id = $1`,
          [engagementId],
        )
      ).rows[0] as { industry: string | null; revenue_band: string | null } | undefined;
      if (!eng) return err(404, 'engagement not found');
      const industryKey = marketIndustryKey(eng.industry);
      const sizeBand = marketSizeBand(eng.revenue_band);
      const { passages } = await retrieveMarketContext(service, {
        industryKey,
        sizeBand,
        exposure: 'aggregate_only',
        query: (body.query as string) ?? undefined,
      });
      return ok({ passages });
    },
  },
  'set-data-room-item': {
    engine: 'knowledge',
    scope: 'engagement',
    handler: async ({ service, body, userId }) => {
      // The caller's profile records who last touched the item (provenance);
      // owners have no firm_id, so resolve by user_id alone (role-agnostic).
      const actor = await anyActorId(service, userId);
      return ok(
        await setDataRoomItem(service, {
          engagementId: body.engagement_id as string,
          itemCode: body.item_code as string,
          readinessState: body.readiness_state as string,
          note: (body.note as string) ?? null,
          documentId: (body.document_id as string) ?? null,
          updatedBy: actor,
        }),
      );
    },
  },
  'attach-data-room-document': {
    engine: 'knowledge',
    scope: 'engagement',
    handler: async ({ service, body, userId }) => {
      const actor = await anyActorId(service, userId);
      return ok(
        await attachDataRoomDocument(service, {
          engagementId: body.engagement_id as string,
          itemCode: body.item_code as string,
          filename: body.filename as string,
          mimeType: (body.mime_type as string) ?? 'application/octet-stream',
          contentBase64: body.content_base64 as string,
          actorProfileId: actor,
        }),
      );
    },
  },
  'upload-document': {
    engine: 'knowledge',
    scope: 'document-upload',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return ok(await uploadDocument(service, firmId as string, actor, body as never));
    },
  },
  'get-document-detail': {
    engine: 'knowledge',
    scope: 'document',
    handler: async ({ service, body, firmId, userId }) => {
      const detail = await getDocumentDetail(service, body.document_id as string);
      await logAccess(service, {
        firmId: firmId as string,
        actorUserId: userId,
        action: 'document.read_detail',
        resourceType: 'document',
        resourceId: body.document_id as string,
        engagementId: (detail.document as { engagement_id?: string }).engagement_id ?? null,
      });
      return ok(detail);
    },
  },
  'get-document': {
    engine: 'knowledge',
    scope: 'document',
    handler: async ({ service, body, firmId, userId }) => {
      const d = await getDocumentBytes(service, body.document_id as string);
      if (!d) return err(404, 'document not found');
      await logAccess(service, {
        firmId: firmId as string,
        actorUserId: userId,
        action: 'document.read',
        resourceType: 'document',
        resourceId: body.document_id as string,
        detail: { filename: d.filename },
      });
      return { kind: 'binary', mime: d.mime, filename: d.filename, buffer: d.bytes };
    },
  },
  'sign-document-url': {
    engine: 'knowledge',
    scope: 'document',
    // Short-expiry signed URL for the source (R5): the GET download route
    // verifies the token, so bytes are never served from a durable link.
    handler: ({ body }) =>
      Promise.resolve(ok({ document_id: body.document_id, ...signDocumentToken(body.document_id as string) })),
  },

  // ── Collaboration Engine — participants, review queue, verification hand-offs
  'invite-owner': {
    engine: 'collaboration',
    // Provisions a new owner account against the engagement — a staff action
    // (mirrors invite-collaborator below). The read-open 'engagement' scope let
    // any principal who could see the engagement invite arbitrary owner accounts
    // (spam/abuse vector); require advisor/admin staff (manage-engagement).
    scope: 'manage-engagement',
    gated: true,
    handler: ({ service, body }) =>
      inviteOwner(service, body.engagement_id as string, body.email as string, body.full_name as string).then(ok),
  },
  // Invite a view-only external collaborator (CPA, attorney, …) to ONE engagement
  // — the owner-portal invite workflow extended to a client's outside advisors.
  // Scope 'manage-engagement' confirms the caller is firm staff who can see the
  // engagement; firmId is trusted (never from the body). NOT gated: assembling a
  // client's deal team is never blocked by billing state (mirrors invite-advisor).
  'invite-collaborator': {
    engine: 'collaboration',
    scope: 'manage-engagement',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return inviteCollaborator(
        service,
        firmId as string,
        body.engagement_id as string,
        body.email as string,
        (body.full_name as string) ?? null,
        (body.kind as string) ?? null,
        actor,
      ).then(ok);
    },
  },
  // Revoke a collaborator's access (deletes their profile, marks the roster row
  // revoked). Same staff+engagement gate; the roster row must belong to the firm.
  'revoke-collaborator': {
    engine: 'collaboration',
    scope: 'manage-engagement',
    handler: ({ service, body, firmId }) =>
      revokeCollaborator(service, firmId as string, body.collaborator_id as string).then(ok),
  },
  // Send an in-progress assessment to the business owner: invite them if needed
  // (idempotent) + mark it shared so the client can fill the questionnaire in their
  // portal (owner_shared_intake_* RLS). Scope 'assessment-staff' keeps this
  // advisor/admin-only even though owners can now see a shared draft. NOT gated:
  // assembling client access mirrors ungated invite-collaborator; the paid surface
  // is scoring/generation, not the hand-off.
  'share-assessment-with-client': {
    engine: 'collaboration',
    scope: 'assessment-staff',
    handler: ({ service, body }) =>
      shareAssessmentWithClient(service, body.assessment_id as string, {
        email: (body.email as string) ?? null,
        fullName: (body.full_name as string) ?? null,
      }).then(ok),
  },
  // The owner (or advisor) signals the client's first pass is done — "ready for
  // review". Read-open 'assessment' scope: anyone who can SEE the assessment may
  // mark it submitted (for an owner that means it's shared to them); the handler
  // re-verifies shared + in_progress and writes only the flag, never scoring data.
  'submit-client-intake': {
    engine: 'workflow',
    scope: 'assessment',
    handler: ({ service, body }) => submitClientIntake(service, body.assessment_id as string).then(ok),
  },
  // Firm-staff invitation (self-serve team management, docs/archive/35 #1). Scope
  // 'admin' resolves the caller's own firm from an admin-only profile — growing
  // the team is an org control, so advisors can no longer invite staff. NOT
  // entitlement-gated: managing your team is never blocked by billing state (seats
  // are enforced inside the handler when billing is on); the seat *usage* is always
  // returned for the UI.
  'invite-advisor': {
    engine: 'collaboration',
    scope: 'admin',
    handler: ({ service, body, firmId }) =>
      inviteAdvisor(
        service,
        firmId as string,
        body.email as string,
        (body.full_name as string) ?? null,
        (body.role as string) ?? 'advisor',
      ).then(ok),
  },
  'run-verification': {
    engine: 'collaboration',
    scope: 'sellside-engagement',
    handler: ({ service, body, firmId }) =>
      runEngagementVerification(service, firmId as string, body.engagement_id as string).then(ok),
  },
  'verification-metrics': {
    engine: 'collaboration',
    scope: 'sellside-engagement',
    handler: ({ service, body }) => reviewMetrics(service, body.engagement_id as string).then(ok),
  },
  'list-review-queue': {
    engine: 'collaboration',
    scope: 'review-queue',
    handler: ({ service, firmId }) => listReviewQueue(service, firmId as string).then((items) => ok({ items })),
  },
  'submit-document-review': {
    engine: 'collaboration',
    scope: 'document',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return ok(await submitDocumentReview(service, firmId as string, actor, body as never));
    },
  },
  'claim-review-item': {
    engine: 'collaboration',
    scope: 'sellside-item',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return ok(await claimReviewItem(service, body.review_item_id as string, actor));
    },
  },
  'resolve-review-item': {
    engine: 'collaboration',
    scope: 'sellside-item',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return ok(
        await resolveReviewItem(
          service,
          body.review_item_id as string,
          actor,
          (body.resolution as ResolveInput) ?? {},
        ),
      );
    },
  },
  'escalate-review-item': {
    engine: 'collaboration',
    scope: 'sellside-item',
    handler: async ({ service, body, firmId, userId }) => {
      const actor = await staffActorId(service, userId, firmId as string);
      return ok(
        await escalateReviewItem(service, body.review_item_id as string, actor, body.note as string | undefined),
      );
    },
  },

  // ── Knowledge Engine — verified financial connection (ledger OAuth)
  // Company-scoped rather than engagement/assessment (see the `ledger-company`
  // auth scope): the connection is made against a company, before any assessment.
  'ledger-connect-begin': {
    engine: 'knowledge',
    scope: 'ledger-connect',
    handler: ({ service, body }) =>
      beginLedgerConnect(service, {
        companyId: body.company_id as string,
        provider: body.provider as 'quickbooks' | 'xero',
        connectedBy: (body.connected_by as string) ?? null,
        returnTo: (body.return_to as string) ?? null,
      }).then(ok),
  },
  'ledger-connect-complete': {
    engine: 'knowledge',
    scope: 'ledger-complete',
    handler: ({ service, body }) =>
      completeLedgerConnect(service, {
        state: body.state as string,
        code: (body.code as string) ?? null,
        realmId: (body.realm_id as string) ?? null,
      }).then(ok),
  },
  'ledger-disconnect': {
    engine: 'knowledge',
    scope: 'ledger-connect',
    handler: async ({ service, body }) => {
      // Confirm the target connection belongs to the authorized company.
      const owns =
        (
          await service.query(`select id from ledger_connections where id = $1 and company_id = $2`, [
            body.connection_id,
            body.company_id,
          ])
        ).rowCount === 1;
      if (!owns) return err(404, 'connection not found');
      return ok(await disconnectLedger(service, { connectionId: body.connection_id as string }));
    },
  },

  // ── Billing (Stripe) — checkout + self-serve portal. Deliberately NOT gated:
  // a lapsed firm MUST be able to reach checkout/portal to restore access
  // (entitlement gate lives in functions.ts for paid *work* endpoints). The
  // firm's Stripe customer id is resolved server-side from its own row, never
  // the body. Engine 'workflow' — this keeps the engagement's account active so
  // work can continue (billing has no dedicated engine; see docs/06).
  'create-checkout-session': {
    engine: 'workflow',
    scope: 'firm',
    handler: async ({ service, body, firmId }) => {
      if (!stripeConfigured()) return err(503, 'billing not configured');
      const cust =
        (await service.query(`select stripe_customer_id from firms where id = $1`, [firmId])).rows[0]
          ?.stripe_customer_id ?? null;
      return createCheckoutSession(
        {
          firmId: firmId as string,
          planCode: body.plan_code as string,
          stripeCustomerId: cust,
          successUrl: body.success_url as string,
          cancelUrl: body.cancel_url as string,
        },
        { stripe: getStripe(), db: service },
      ).then(ok);
    },
  },
  'create-billing-portal-session': {
    engine: 'workflow',
    scope: 'firm',
    handler: async ({ service, body, firmId }) => {
      if (!stripeConfigured()) return err(503, 'billing not configured');
      const cust =
        (await service.query(`select stripe_customer_id from firms where id = $1`, [firmId])).rows[0]
          ?.stripe_customer_id ?? null;
      if (!cust) return err(400, 'no Stripe customer for this firm yet');
      return createBillingPortalSession(
        { stripeCustomerId: cust, returnUrl: body.return_url as string },
        { stripe: getStripe() },
      ).then(ok);
    },
  },
};

// The billing-gated function names, derived from the registry so there is one
// source of truth (consumed by server/entitlements.ts). Viewing existing data is
// never gated — only actions that produce new work / deliverables carry `gated`.
export function gatedFunctionNames(): string[] {
  return Object.entries(REGISTRY)
    .filter(([, spec]) => spec.gated)
    .map(([name]) => name);
}
