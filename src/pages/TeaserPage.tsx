import { DocumentCurator, BrandedSheet } from '../components/DocumentCurator';
import { renderMarkdown } from '../lib/markdown';

// The teaser (blind profile) deliverable, rendered as a panel inside the
// Deliverables studio. It is the anonymized one-pager a sell-side process sends
// to the buyer universe before an NDA — built from the same strengths-only
// payload as the CIM, but the narrative never names the company. The generate →
// edit → finalize → branded-PDF flow is the shared DocumentCurator.
export function TeaserPanel({ assessmentId }: { assessmentId: string | undefined }) {
  return (
    <DocumentCurator
      assessmentId={assessmentId}
      docType="teaser"
      emptyHint={
        <p className="muted">
          The teaser is an anonymized blind profile: it presents the strengths and a headline financial
          figure without naming the company, so it can go out to prospective buyers before an NDA. It is a
          buyer-facing marketing draft; review and edit it before sharing. No number is invented; no weakness
          is surfaced.
        </p>
      }
      generatingHint={
        <p className="muted">Composing the anonymized teaser from the strengths and financial summary…</p>
      }
    >
      {(md) => <BrandedSheet>{renderMarkdown(md)}</BrandedSheet>}
    </DocumentCurator>
  );
}
