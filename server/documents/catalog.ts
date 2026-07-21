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
  renderOwnerReportHtml,
  renderReportPdf,
  type ReportBranding,
} from '../pdf';
import { documentType } from '../../shared/documents/catalog';

// A self-contained result so this module never imports the function registry
// (registry.ts imports this one — keeping the dependency one-way avoids a cycle).
// registry.ts maps this onto its FunctionResult union.
export type RenderResult =
  | { ok: true; filename: string; buffer: Buffer }
  | { ok: false; status: number; message: string };

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
async function latestNarrative(
  service: pg.ClientBase,
  assessmentId: string,
  docType: string,
): Promise<{ content_md: string; firm_id: string; completed_at: string | null } | null> {
  return (
    (
      await service.query(
        `select gd.content_md, e.firm_id, a.completed_at
         from generated_documents gd
         join engagements e on e.id = gd.engagement_id
         join assessments a on a.id = gd.assessment_id
         where gd.assessment_id = $1 and gd.doc_type = $2
         order by gd.created_at desc limit 1`,
        [assessmentId, docType],
      )
    ).rows[0] ?? null
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
};

// (assessmentId, docType) → a branded PDF, or a structured failure the caller maps
// to an HTTP status. The narrative must already exist (the studio generates it
// before offering the download); a missing one is a 404, not a crash.
export async function renderDocumentPdf(
  service: pg.ClientBase,
  docType: string,
  assessmentId: string,
): Promise<RenderResult> {
  const meta = documentType(docType);
  const build = HTML_BUILDERS[docType];
  if (!meta || !build) return { ok: false, status: 400, message: `unknown document type '${docType}'` };
  if (typeof assessmentId !== 'string' || !assessmentId) {
    return { ok: false, status: 400, message: 'assessment_id required' };
  }

  const doc = await latestNarrative(service, assessmentId, docType);
  if (!doc) return { ok: false, status: 404, message: `no ${meta.title} generated for this assessment yet` };

  const branding = await fetchBranding(service, doc.firm_id);
  const html = await build(service, assessmentId, doc.content_md, branding, doc.completed_at);
  const buffer = await renderReportPdf(html, { footerLeft: branding?.display_name ?? '' });
  return { ok: true, filename: meta.filename, buffer };
}
