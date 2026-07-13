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
  | { kind: 'pdf'; filename: string; buffer: Uint8Array };

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
    return await dispatch(name, body, ctx.service, authz.firmId);
  } catch (e) {
    return err(400, (e as Error).message);
  }
}
