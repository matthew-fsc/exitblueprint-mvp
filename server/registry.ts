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
import { beginLedgerConnect, completeLedgerConnect, disconnectLedger } from './ledger-oauth';
import { computeValuation } from './valuation';
import { recordDealOutcome, firmCalibration, type DealOutcomeInput } from './outcomes';
import { createCheckoutSession, createBillingPortalSession, getStripe, stripeConfigured } from './stripe';
import { inviteOwner } from './invite';
import { inviteAdvisor } from './invite-advisor';
import { inviteCollaborator, revokeCollaborator } from './collaborators';
import { createEngagementWithAgreement } from './agreements';
import { deleteEngagement } from './engagements';
import { exportEngagement } from './export';
import { firmAttention } from './attention';
import {
  getDocumentBytes,
  getDocumentDetail,
  listReviewQueue,
  submitDocumentReview,
  uploadDocument,
} from './documents/pipeline';
import { signDocumentToken } from './documents/signed-url';
import { runEngagementVerification } from './sellside';
import { attachDataRoomDocument, listDataRoom, setDataRoomItem } from './data-room';
import { buildCimCoverage } from './cim';
import { engagementComparables } from './comparables';
import {
  claimReviewItem,
  escalateReviewItem,
  resolveReviewItem,
  reviewMetrics,
  type ResolveInput,
} from './review-queue';
import { logAccess } from './audit';
import { seedMethodology } from './seed-methodology';
import { renderDocumentPdf } from './documents/catalog';

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
async function documentPdf(service: pg.ClientBase, docType: string, assessmentId: string): Promise<FunctionResult> {
  const result = await renderDocumentPdf(service, docType, assessmentId);
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
    scope: 'assessment',
    gated: true,
    handler: ({ service, body }) => scoreAssessment(service, body.assessment_id as string).then(ok),
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
  'generate-roadmap': {
    engine: 'rules',
    scope: 'engagement',
    gated: true,
    handler: ({ service, body }) =>
      instantiateTasksForGaps(service, body.engagement_id as string, (body.anchor_date as string) ?? null).then(ok),
  },
  'compute-valuation': {
    engine: 'rules',
    scope: 'engagement',
    gated: true,
    handler: ({ service, body }) => computeValuation(service, body.engagement_id as string).then(ok),
  },
  'engagement-comparables': {
    engine: 'rules',
    scope: 'engagement',
    // Firm-scoped "relevant historical cases" — the caller is already authorized
    // on this engagement; siblings are constrained to its firm.
    handler: ({ service, body }) => engagementComparables(service, body.engagement_id as string).then(ok),
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

  // ── Reasoning Engine — AI narratives & assembled documents (always draft)
  'generate-document': {
    engine: 'reasoning',
    scope: 'assessment',
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
    handler: ({ service, body }) =>
      documentPdf(service, (body.doc_type as string) ?? 'owner_report', body.assessment_id as string),
  },
  'render-owner-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body }) => documentPdf(service, 'owner_report', body.assessment_id as string),
  },
  'render-delta-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body }) => documentPdf(service, 'delta_report', body.assessment_id as string),
  },
  'render-cim-pdf': {
    engine: 'reasoning',
    scope: 'assessment',
    gated: true,
    handler: ({ service, body }) => documentPdf(service, 'cim', body.assessment_id as string),
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

  // ── Knowledge Engine — structured business knowledge (evidence, financials, outcomes)
  'sync-ledger': {
    engine: 'knowledge',
    scope: 'assessment',
    handler: ({ service, body }) => syncLedgerToAssessment(service, body.assessment_id as string).then(ok),
  },
  'enter-manual-financials': {
    engine: 'knowledge',
    scope: 'assessment',
    handler: ({ service, body }) =>
      enterManualFinancials(
        service,
        body.assessment_id as string,
        (body.entries as ManualFinancialEntry[]) ?? [],
        !!body.documented,
      ).then(ok),
  },
  'verification-summary': {
    engine: 'knowledge',
    scope: 'assessment',
    handler: ({ service, body }) => verificationSummary(service, body.assessment_id as string).then(ok),
  },
  'record-deal-outcome': {
    engine: 'knowledge',
    scope: 'engagement',
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
    scope: 'engagement',
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
  // Firm-staff invitation (self-serve team management, docs/archive/35 #1). Scope 'firm'
  // resolves the caller's own firm from their advisor/admin profile — a firm can
  // only grow its own team. NOT entitlement-gated: managing your team is never
  // blocked by billing state (seats are enforced inside the handler when billing
  // is on); the seat *usage* is always returned for the UI.
  'invite-advisor': {
    engine: 'collaboration',
    scope: 'firm',
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
