import { DocumentCurator, BrandedSheet } from '../components/DocumentCurator';
import { renderMarkdown } from '../lib/markdown';

// The management presentation deliverable, rendered as a panel inside the
// Deliverables studio. It is the equity-story talking-point outline the owner
// walks serious buyers through in a management meeting, after the CIM and behind
// an NDA — built from the same strengths-only payload as the CIM (so it names the
// company, unlike the teaser). The generate → edit → finalize → branded-PDF flow
// is the shared DocumentCurator.
export function ManagementPresentationPanel({ assessmentId }: { assessmentId: string | undefined }) {
  return (
    <DocumentCurator
      assessmentId={assessmentId}
      docType="management_presentation"
      emptyHint={
        <p className="muted">
          The management presentation is the equity story as a talking-point outline for the buyer meeting —
          an agenda and speaking points drawn from the assessment strengths. It is buyer-facing material the
          advisor controls; review and edit it before the meeting. No number is invented; no weakness is
          surfaced.
        </p>
      }
      generatingHint={
        <p className="muted">Assembling the management-meeting outline from the company profile and strengths…</p>
      }
    >
      {(md) => <BrandedSheet>{renderMarkdown(md)}</BrandedSheet>}
    </DocumentCurator>
  );
}
