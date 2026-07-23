// The one place client-facing PDFs are assembled. Every deliverable is the same
// shape — deterministic facts + the generated narrative (the latest saved
// generated_documents row) + firm branding → a branded PDF — so the wiring lives
// once here, keyed by doc_type, instead of three near-identical handlers in the
// function registry. registry.ts exposes it as the single `render-document-pdf`
// endpoint (plus the legacy render-owner/delta/cim-pdf aliases that call straight
// through), so adding a document type is one entry here, not a new endpoint.
//
// The shared metadata (title, filename, audience) lives in
// shared/documents/catalog.ts so the advisor's Deliverables studio and this
// renderer never disagree on what a document is called or where it downloads.
import type pg from 'pg';
import { explainAssessment } from '../scoring';
import { buildDeltaReportPayload, buildOwnerReportPayload } from '../narrative';
import { buildCimPayload } from '../cim';
import {
  renderCimReportHtml,
  renderDeltaReportHtml,
  renderManagementPresentationHtml,
  renderOwnerReportHtml,
  renderReportPdf,
  renderTeaserHtml,
  type ReportBranding,
} from '../pdf';
import { documentType } from '../../shared/documents/catalog';

// A self-contained result so this module never imports the function registry
// (registry.ts imports this one — keeping the dependency one-way avoids a cycle).
// registry.ts maps this onto its FunctionResult union.
export type RenderResult =
  | { ok: true; filename: string; buffer: Buffer }
  | { ok: false; status: number; message: string };

// An RLS-scoped query runner (queries execute AS the caller, so row-level
// security applies). Mirrors FunctionContext.asUser. The document ROW is fetched
// through this — never the service-role client — so the renderer can only ever
// return a narrative the caller is authorized to read: a collaborator/owner is
// walled off from doc types RLS doesn't grant them, and an owner's CIM read stays
// gated on finalized_at. Deterministic-fact assembly (branding, payloads) still
// runs on the service-role client below.
export type AsUser = <T>(fn: (db: pg.ClientBase) => Promise<T>) => Promise<T>;

// Firm branding for a report, resolved once for every document type.
async function fetchBranding(service: pg.ClientBase, firmId: string): Promise<ReportBranding | null> {
  return (
    (
      await service.query(
        `select display_name, logo_url, accent_color, report_from_line, footer_disclosure_md
         from firm_branding where firm_id = $1`,
        [firmId],
      )
    ).rows[0] as ReportBranding | undefined
  ) ?? null;
}

// The most recent generated narrative for a document type, with the fields each
// renderer needs alongside it (firm_id for branding, completed_at for the cover).
//
// Fetched AS THE CALLER (asUser) so RLS is the authorization boundary: the query
// can only return a row the caller may read. Firm staff (advisor_firm_all) see
// every doc type; an owner sees owner_report anytime and cim only once finalized
// (owner_cim_read); a collaborator sees owner_report only. So a portal user
// requesting a doc type RLS doesn't grant them — a teaser, an unfinalized CIM —
// gets no row and a clean 404, never the service-role bypass the render path used
// to grant. The `finalized_at is not null` gate on the owner CIM read applies to
// the fetched row itself, so a newer unfinalized draft can't shadow the signed-off
// one for an owner.
async function latestNarrative(
  asUser: AsUser,
  assessmentId: string,
  docType: string,
): Promise<{ content_md: string; firm_id: string; completed_at: string | null } | null> {
  return asUser(async (db) =>
    (
      await db.query(
        `select gd.content_md, e.firm_id, a.completed_at
         from generated_documents gd
         join engagements e on e.id = gd.engagement_id
         join assessments a on a.id = gd.assessment_id
         where gd.assessment_id = $1 and gd.doc_type = $2
         order by gd.created_at desc limit 1`,
        [assessmentId, docType],
      )
    ).rows[0] ?? null,
  );
}

type HtmlBuilder = (
  service: pg.ClientBase,
  assessmentId: string,
  narrativeMd: string,
  branding: ReportBranding | null,
  completedAt: string | null,
) => Promise<string>;

// Per-type HTML assembly — the payload each document reads, then the matching
// institutional scaffold from server/pdf.ts. Unchanged from the prior registry
// handlers; only relocated so all three sit next to each other.
const HTML_BUILDERS: Record<string, HtmlBuilder> = {
  owner_report: async (service, assessmentId, narrativeMd, branding, completedAt) => {
    const explain = await explainAssessment(service, assessmentId);
    const payload = await buildOwnerReportPayload(service, assessmentId);
    return renderOwnerReportHtml(
      {
        companyName: payload.company.name,
        industry: payload.company.industry,
        targetWindow: payload.engagement_target_window,
        date: completedAt,
        drs: explain.drsScore,
        tier: explain.drsTier,
        ori: explain.oriScore,
        dimensions: explain.dimensions.map((d) => ({ name: d.name, score: d.score })),
        topGaps: payload.top_gaps,
        flags: explain.flags,
      },
      narrativeMd,
      branding,
    );
  },
  delta_report: async (service, assessmentId, narrativeMd, branding) => {
    const payload = await buildDeltaReportPayload(service, assessmentId);
    return renderDeltaReportHtml(payload, narrativeMd, branding);
  },
  cim: async (service, assessmentId, narrativeMd, branding, completedAt) => {
    const payload = await buildCimPayload(service, assessmentId);
    return renderCimReportHtml(
      { companyName: payload.company.name, industry: payload.company.industry, date: completedAt },
      narrativeMd,
      branding,
    );
  },
  // The teaser and the management presentation both read the CIM's strengths-only
  // payload; the teaser cover withholds the company name (blind profile), the
  // management presentation names it (post-NDA meeting material).
  teaser: async (service, assessmentId, narrativeMd, branding, completedAt) => {
    const payload = await buildCimPayload(service, assessmentId);
    return renderTeaserHtml(
      { industry: payload.company.industry, state: payload.company.state, date: completedAt },
      narrativeMd,
      branding,
    );
  },
  management_presentation: async (service, assessmentId, narrativeMd, branding, completedAt) => {
    const payload = await buildCimPayload(service, assessmentId);
    return renderManagementPresentationHtml(
      { companyName: payload.company.name, industry: payload.company.industry, date: completedAt },
      narrativeMd,
      branding,
    );
  },
};

// (assessmentId, docType) → a branded PDF, or a structured failure the caller maps
// to an HTTP status. The narrative must already exist (the studio generates it
// before offering the download); a missing one is a 404, not a crash.
export async function renderDocumentPdf(
  service: pg.ClientBase,
  docType: string,
  assessmentId: string,
  asUser: AsUser,
): Promise<RenderResult> {
  const meta = documentType(docType);
  const build = HTML_BUILDERS[docType];
  if (!meta || !build) return { ok: false, status: 400, message: `unknown document type '${docType}'` };
  if (typeof assessmentId !== 'string' || !assessmentId) {
    return { ok: false, status: 400, message: 'assessment_id required' };
  }

  // Authorization boundary: the document row is read AS THE CALLER, so RLS decides
  // whether this caller may render this doc type for this assessment. A missing row
  // (walled off, or an owner's CIM not yet finalized) is a 404, never a bypass.
  const doc = await latestNarrative(asUser, assessmentId, docType);
  if (!doc) return { ok: false, status: 404, message: `no ${meta.title} generated for this assessment yet` };

  const branding = await fetchBranding(service, doc.firm_id);
  const html = await build(service, assessmentId, doc.content_md, branding, doc.completed_at);
  const buffer = await renderReportPdf(html, { footerLeft: branding?.display_name ?? '' });
  return { ok: true, filename: meta.filename, buffer };
}
