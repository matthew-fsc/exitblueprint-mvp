import { DocumentCurator, BrandedSheet } from '../components/DocumentCurator';
import { renderMarkdown } from '../lib/markdown';

// The owner report deliverable, rendered as a panel inside the Deliverables
// studio (src/pages/DeliverablesPage.tsx). All of the generate → edit → finalize
// → download machinery lives in DocumentCurator; this panel supplies only the
// owner-report copy and its branded preview body.
export function OwnerReportPanel({ assessmentId }: { assessmentId: string | undefined }) {
  return (
    <DocumentCurator
      assessmentId={assessmentId}
      docType="owner_report"
      emptyHint={
        <p className="muted">
          The report is built server-side from this assessment’s scores and flagged gaps — every figure
          traces back to an answer, and no number is invented.
        </p>
      }
      generatingHint={
        <p className="muted">Composing the report from this assessment’s scores and flagged gaps…</p>
      }
    >
      {(md) => <BrandedSheet>{renderMarkdown(md)}</BrandedSheet>}
    </DocumentCurator>
  );
}
