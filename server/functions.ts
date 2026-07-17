// Portable function router — the deployable heart of the compute layer.
//
// Every `/functions/v1/<name>` endpoint the frontend calls is authorized and
// dispatched here, with NO dependency on the HTTP transport or on Vite. The dev
// emulator (dev/supabase-dev-server.ts) mounts this; a production host — a Supabase
// Edge Function or a small Node service — mounts the exact same logic by supplying
// a FunctionContext. This is Phase 1 of docs/10-production-readiness.md: making the
// compute layer deployable without prejudging the Edge-vs-Node runtime decision.
//
// The only runtime coupling left is the Postgres client shape (`pg.ClientBase`,
// i.e. anything with `.query`). Node hosts pass a real pg client; a Deno/Edge port
// passes an npm:pg (or compatible) client with the same `.query` surface — the
// business logic below does not change.
import type pg from 'pg';
import { compareAssessments, explainAssessment, scoreAssessment } from './scoring';
import { buildDeltaReportPayload, buildOwnerReportPayload, generateDocument } from './narrative';
import { instantiateTasksForGaps } from './roadmap';
import { fireAdvisoryItems, educationModules } from './advisory';
import { verificationSummary } from './verification';
import { syncLedgerToAssessment, enterManualFinancials, type ManualFinancialEntry } from './ledger';
import { beginLedgerConnect, completeLedgerConnect, disconnectLedger } from './ledger-oauth';
import { computeValuation } from './valuation';
import { recordDealOutcome, firmCalibration, type DealOutcomeInput } from './outcomes';
import { inviteOwner } from './invite';
import { createEngagementWithAgreement } from './agreements';
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
import {
  claimReviewItem,
  escalateReviewItem,
  resolveReviewItem,
  reviewMetrics,
  type ResolveInput,
} from './review-queue';
import { logAccess } from './audit';
import {
  renderDeltaReportHtml,
  renderOwnerReportHtml,
  renderReportPdf,
  type ReportBranding,
} from './pdf';

// Company-scoped connection functions; firm-scoped readouts; everything else is
// authorized by the engagement or the assessment ids it references.
const LEDGER_FNS = new Set(['ledger-connect-begin', 'ledger-connect-complete', 'ledger-disconnect']);
const FIRM_FNS = new Set(['deal-calibration']);

// What the host must provide: the caller's id, an RLS-scoped runner (queries run
// AS the caller so real row-level security applies), and a service-role client
// (RLS bypassed) for the privileged work an edge function would do.
export interface FunctionContext {
  userId: string;
  asUser<T>(fn: (db: pg.ClientBase) => Promise<T>): Promise<T>;
  service: pg.ClientBase;
}

export type FunctionResult =
  | { kind: 'json'; status: number; body: unknown }
  | { kind: 'pdf'; filename: string; buffer: Uint8Array }
  | { kind: 'binary'; mime: string; filename: string; buffer: Uint8Array };

// Document functions are authorized for staff (advisor + reviewer); the review
// queue is firm-scoped, the rest are gated on the engagement/document being
// visible to the caller under RLS.
const DOC_FNS = new Set([
  'upload-document',
  'list-review-queue',
  'get-document',
  'get-document-detail',
  'submit-document-review',
  'sign-document-url',
]);

// Sell-side verification: staff-only (advisor + reviewer), firm-scoped. Engagement
// actions gate on the engagement id; review-item actions gate on the item's
// engagement (resolved from the item, never trusted from the body).
const SELLSIDE_ENGAGEMENT_FNS = new Set(['run-verification', 'verification-metrics']);
const SELLSIDE_ITEM_FNS = new Set(['claim-review-item', 'resolve-review-item', 'escalate-review-item']);

const ok = (body: unknown): FunctionResult => ({ kind: 'json', status: 200, body });
const err = (status: number, message: string): FunctionResult => ({ kind: 'json', status, body: { message } });

// Authorize the call through RLS, returning the caller's firm id when relevant.
// Returns a FunctionResult on failure (to short-circuit), or null on success.
async function authorize(
  name: string,
  body: Record<string, unknown>,
  ctx: FunctionContext,
): Promise<{ error: FunctionResult } | { firmId: string | null }> {
  if (FIRM_FNS.has(name)) {
    // Firm-scoped readouts: resolve the caller's own firm from their advisor
    // profile — never trust a firm_id from the body.
    const firmId = await ctx.asUser(async (c) => {
      const r = await c.query(
        `select firm_id from profiles where user_id = $1 and role in ('advisor', 'admin')`,
        [ctx.userId],
      );
      return (r.rows[0]?.firm_id as string | undefined) ?? null;
    });
    if (!firmId) return { error: err(403, 'advisor profile required') };
    return { firmId };
  }
  if (name === 'create-engagement') {
    // Resolve the caller's own advisor firm (never trust a firm_id from the
    // body), then confirm the target company is visible to them under RLS. The
    // engagement doesn't exist yet, so it can't be authorized by its own id.
    const firmId = await ctx.asUser(async (c) => {
      const r = await c.query(
        `select firm_id from profiles where user_id = $1 and role = 'advisor'`,
        [ctx.userId],
      );
      return (r.rows[0]?.firm_id as string | undefined) ?? null;
    });
    if (!firmId) return { error: err(403, 'advisor profile required') };
    const companyId = typeof body.company_id === 'string' ? body.company_id : null;
    if (!companyId) return { error: err(400, 'company_id required') };
    const visible = await ctx.asUser(async (c) => {
      const r = await c.query(`select id from companies where id = $1`, [companyId]);
      return r.rowCount === 1;
    });
    if (!visible) return { error: err(404, 'company not found') };
    return { firmId };
  }
  if (DOC_FNS.has(name)) {
    // Staff = advisor or reviewer. Resolve the caller's firm from their profile
    // (never the body), then confirm the referenced engagement/document is
    // visible to them under RLS.
    const firmId = await ctx.asUser(async (c) => {
      const r = await c.query(
        `select firm_id from profiles where user_id = $1 and role in ('advisor', 'reviewer')`,
        [ctx.userId],
      );
      return (r.rows[0]?.firm_id as string | undefined) ?? null;
    });
    if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
    if (name === 'upload-document') {
      const engId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engId) return { error: err(400, 'engagement_id required') };
      const visible = await ctx.asUser(
        async (c) => (await c.query(`select id from engagements where id = $1`, [engId])).rowCount === 1,
      );
      if (!visible) return { error: err(404, 'engagement not found') };
    } else if (name !== 'list-review-queue') {
      const docId = typeof body.document_id === 'string' ? body.document_id : null;
      if (!docId) return { error: err(400, 'document_id required') };
      const visible = await ctx.asUser(
        async (c) => (await c.query(`select id from documents where id = $1`, [docId])).rowCount === 1,
      );
      if (!visible) return { error: err(404, 'document not found') };
    }
    return { firmId };
  }
  if (SELLSIDE_ENGAGEMENT_FNS.has(name) || SELLSIDE_ITEM_FNS.has(name)) {
    // Staff = advisor or reviewer; resolve the firm from the profile, never the body.
    const firmId = await ctx.asUser(async (c) => {
      const r = await c.query(
        `select firm_id from profiles where user_id = $1 and role in ('advisor', 'reviewer')`,
        [ctx.userId],
      );
      return (r.rows[0]?.firm_id as string | undefined) ?? null;
    });
    if (!firmId) return { error: err(403, 'advisor or reviewer profile required') };
    // Resolve the engagement the call touches: directly for engagement actions,
    // via the review item for item actions.
    let engagementId: string | null = null;
    if (SELLSIDE_ENGAGEMENT_FNS.has(name)) {
      engagementId = typeof body.engagement_id === 'string' ? body.engagement_id : null;
      if (!engagementId) return { error: err(400, 'engagement_id required') };
    } else {
      const itemId = typeof body.review_item_id === 'string' ? body.review_item_id : null;
      if (!itemId) return { error: err(400, 'review_item_id required') };
      engagementId =
        (await ctx.service.query(`select engagement_id from review_items where id = $1`, [itemId]))
          .rows[0]?.engagement_id ?? null;
      if (!engagementId) return { error: err(404, 'review item not found') };
    }
    const visible = await ctx.asUser(
      async (c) => (await c.query(`select id from engagements where id = $1`, [engagementId])).rowCount === 1,
    );
    if (!visible) return { error: err(404, 'engagement not found') };
    return { firmId };
  }
  if (LEDGER_FNS.has(name)) {
    // Resolve the company this action touches (complete() carries only the
    // opaque state, so read the company from the pending row), then confirm the
    // caller can see that company under RLS.
    let companyId: string | null = typeof body.company_id === 'string' ? body.company_id : null;
    if (name === 'ledger-connect-complete') {
      companyId =
        (await ctx.service.query(`select company_id from ledger_oauth_states where state = $1`, [body.state]))
          .rows[0]?.company_id ?? null;
      // Unknown state: skip company auth and let the function return the proper
      // "invalid or expired" error rather than a misleading 404.
    }
    if (name !== 'ledger-connect-complete' && !companyId) return { error: err(400, 'company_id required') };
    if (companyId) {
      const visible = await ctx.asUser(async (c) => {
        const r = await c.query(`select id from companies where id = $1`, [companyId]);
        return r.rowCount === 1;
      });
      if (!visible) return { error: err(404, 'company not found') };
    }
    return { firmId: null };
  }
  if (typeof body.engagement_id === 'string') {
    const visible = await ctx.asUser(async (c) => {
      const r = await c.query(`select id from engagements where id = $1`, [body.engagement_id]);
      return r.rowCount === 1;
    });
    if (!visible) return { error: err(404, 'engagement not found') };
    return { firmId: null };
  }
  const ids = [body.assessment_id, body.prior_assessment_id, body.current_assessment_id].filter(
    (v): v is string => typeof v === 'string',
  );
  const visible = await ctx.asUser(async (c) => {
    const r = await c.query(`select id from assessments where id = any($1)`, [ids]);
    return ids.length > 0 && r.rowCount === ids.length;
  });
  if (!visible) return { error: err(404, 'assessment not found') };
  return { firmId: null };
}

async function ownerReportPdf(service: pg.ClientBase, assessmentId: string): Promise<FunctionResult> {
  const explain = await explainAssessment(service, assessmentId);
  const payload = await buildOwnerReportPayload(service, assessmentId);
  const doc = (
    await service.query(
      `select gd.content_md, e.firm_id, a.completed_at
       from generated_documents gd
       join engagements e on e.id = gd.engagement_id
       join assessments a on a.id = gd.assessment_id
       where gd.assessment_id = $1 and gd.doc_type = 'owner_report'
       order by gd.created_at desc limit 1`,
      [assessmentId],
    )
  ).rows[0];
  if (!doc) return err(404, 'no owner report generated for this assessment yet');
  const branding = (
    await service.query(
      `select display_name, logo_url, accent_color, report_from_line, footer_disclosure_md
       from firm_branding where firm_id = $1`,
      [doc.firm_id],
    )
  ).rows[0] as ReportBranding | undefined;
  const html = renderOwnerReportHtml(
    {
      companyName: payload.company.name,
      industry: payload.company.industry,
      targetWindow: payload.engagement_target_window,
      date: doc.completed_at,
      drs: explain.drsScore,
      tier: explain.drsTier,
      ori: explain.oriScore,
      dimensions: explain.dimensions.map((d) => ({ name: d.name, score: d.score })),
      topGaps: payload.top_gaps,
      flags: explain.flags,
    },
    doc.content_md,
    branding ?? null,
  );
  const pdf = await renderReportPdf(html, { footerLeft: branding?.display_name ?? '' });
  return { kind: 'pdf', filename: 'exit-readiness-report.pdf', buffer: pdf };
}

async function deltaReportPdf(service: pg.ClientBase, assessmentId: string): Promise<FunctionResult> {
  const payload = await buildDeltaReportPayload(service, assessmentId);
  const doc = (
    await service.query(
      `select gd.content_md, e.firm_id
       from generated_documents gd join engagements e on e.id = gd.engagement_id
       where gd.assessment_id = $1 and gd.doc_type = 'delta_report'
       order by gd.created_at desc limit 1`,
      [assessmentId],
    )
  ).rows[0];
  if (!doc) return err(404, 'no delta report generated for this assessment yet');
  const branding = (
    await service.query(
      `select display_name, logo_url, accent_color, report_from_line, footer_disclosure_md
       from firm_branding where firm_id = $1`,
      [doc.firm_id],
    )
  ).rows[0] as ReportBranding | undefined;
  const html = renderDeltaReportHtml(payload, doc.content_md, branding ?? null);
  const pdf = await renderReportPdf(html, { footerLeft: branding?.display_name ?? '' });
  return { kind: 'pdf', filename: 'delta-report.pdf', buffer: pdf };
}

// Dispatch an already-authorized call with the service-role client.
async function dispatch(
  name: string,
  body: Record<string, unknown>,
  service: pg.ClientBase,
  firmId: string | null,
  userId: string,
): Promise<FunctionResult> {
  const assessmentId = body.assessment_id as string;
  switch (name) {
    case 'score-assessment':
      return ok(await scoreAssessment(service, assessmentId));
    case 'explain-assessment':
      return ok(await explainAssessment(service, assessmentId));
    case 'compare-assessments':
      return ok(await compareAssessments(service, body.prior_assessment_id as string, body.current_assessment_id as string));
    case 'generate-document':
      return ok(await generateDocument(service, assessmentId, (body.doc_type as string) ?? 'owner_report'));
    case 'generate-roadmap':
      return ok(await instantiateTasksForGaps(service, body.engagement_id as string, (body.anchor_date as string) ?? null));
    case 'advisory-items':
      return ok(await fireAdvisoryItems(service, body.engagement_id as string));
    case 'education-modules':
      return ok(await educationModules(service, body.engagement_id as string));
    case 'compute-valuation':
      return ok(await computeValuation(service, body.engagement_id as string));
    case 'invite-owner':
      return ok(await inviteOwner(service, body.engagement_id as string, body.email as string, body.full_name as string));
    case 'create-engagement':
      return ok(await createEngagementWithAgreement(service, userId, firmId as string, body));
    case 'upload-document': {
      const actor = (
        await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
      ).rows[0]?.id ?? null;
      return ok(await uploadDocument(service, firmId as string, actor, body as never));
    }
    case 'list-review-queue':
      return ok({ items: await listReviewQueue(service, firmId as string) });
    case 'get-document-detail': {
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
    }
    case 'submit-document-review': {
      const actor = (
        await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
      ).rows[0]?.id ?? null;
      return ok(await submitDocumentReview(service, firmId as string, actor, body as never));
    }
    case 'sign-document-url':
      // Short-expiry signed URL for the source (R5): the GET download route
      // verifies the token, so bytes are never served from a durable link.
      return ok({ document_id: body.document_id, ...signDocumentToken(body.document_id as string) });
    case 'get-document': {
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
    }
    case 'record-deal-outcome':
      return ok(await recordDealOutcome(service, body.engagement_id as string, (body.input as DealOutcomeInput) ?? ({} as DealOutcomeInput)));
    case 'deal-calibration':
      return ok(await firmCalibration(service, firmId as string));
    case 'verification-summary':
      return ok(await verificationSummary(service, assessmentId));
    case 'sync-ledger':
      return ok(await syncLedgerToAssessment(service, assessmentId));
    case 'enter-manual-financials':
      return ok(
        await enterManualFinancials(
          service,
          assessmentId,
          (body.entries as ManualFinancialEntry[]) ?? [],
          !!body.documented,
        ),
      );
    case 'ledger-connect-begin':
      return ok(
        await beginLedgerConnect(service, {
          companyId: body.company_id as string,
          provider: body.provider as 'quickbooks' | 'xero',
          connectedBy: (body.connected_by as string) ?? null,
          returnTo: (body.return_to as string) ?? null,
        }),
      );
    case 'ledger-connect-complete':
      return ok(
        await completeLedgerConnect(service, {
          state: body.state as string,
          code: (body.code as string) ?? null,
          realmId: (body.realm_id as string) ?? null,
        }),
      );
    case 'ledger-disconnect': {
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
    }
    case 'list-data-room':
      // Authorized via the generic engagement path (staff by firm, owner by
      // company). Read-only view of the template + this engagement's states.
      return ok(await listDataRoom(service, body.engagement_id as string));
    case 'set-data-room-item': {
      // The caller's profile records who last touched the item (provenance);
      // owners have no firm_id, so resolve by user_id alone (role-agnostic).
      const actor = (await service.query(`select id from profiles where user_id = $1`, [userId]))
        .rows[0]?.id ?? null;
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
    }
    case 'attach-data-room-document': {
      const actor = (await service.query(`select id from profiles where user_id = $1`, [userId]))
        .rows[0]?.id ?? null;
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
    }
    case 'run-verification':
      return ok(await runEngagementVerification(service, firmId as string, body.engagement_id as string));
    case 'verification-metrics':
      return ok(await reviewMetrics(service, body.engagement_id as string));
    case 'claim-review-item': {
      const actor = (
        await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
      ).rows[0]?.id ?? null;
      return ok(await claimReviewItem(service, body.review_item_id as string, actor));
    }
    case 'resolve-review-item': {
      const actor = (
        await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
      ).rows[0]?.id ?? null;
      return ok(
        await resolveReviewItem(
          service,
          body.review_item_id as string,
          actor,
          (body.resolution as ResolveInput) ?? {},
        ),
      );
    }
    case 'escalate-review-item': {
      const actor = (
        await service.query(`select id from profiles where user_id = $1 and firm_id = $2`, [userId, firmId])
      ).rows[0]?.id ?? null;
      return ok(
        await escalateReviewItem(service, body.review_item_id as string, actor, body.note as string | undefined),
      );
    }
    case 'render-owner-pdf':
      return ownerReportPdf(service, assessmentId);
    case 'render-delta-pdf':
      return deltaReportPdf(service, assessmentId);
    default:
      return err(404, `unknown function '${name}'`);
  }
}

// The single entry point a host mounts. Authorizes through RLS, then dispatches
// with the service-role client. Business errors surface as 400s, matching the
// dev emulator's prior behavior.
export async function handleFunctionCall(
  name: string,
  body: Record<string, unknown>,
  ctx: FunctionContext,
): Promise<FunctionResult> {
  const authz = await authorize(name, body, ctx);
  if ('error' in authz) return authz.error;
  try {
    return await dispatch(name, body, ctx.service, authz.firmId, ctx.userId);
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
