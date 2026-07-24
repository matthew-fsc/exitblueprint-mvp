import { Link } from 'react-router-dom';
import { useCimCoverage } from '../lib/queries';
import { Collapsible } from '../components/ui';
import { DocumentCurator, BrandedSheet } from '../components/DocumentCurator';
import { renderMarkdown } from '../lib/markdown';

// The CIM (Confidential Information Memorandum) deliverable, rendered as a panel
// inside the Deliverables studio. It leads with a CIM Readiness panel (passed to
// DocumentCurator as `aside`) that shows which sections are backed by
// Ready/verified evidence and routes the advisor back to Evidence to collect the
// rest — the surface that postures evidence collection toward the CIM. The
// generate → edit → finalize → branded-PDF flow is the shared DocumentCurator.
export function CimPanel({
  assessmentId,
  engagementId,
}: {
  assessmentId: string | undefined;
  engagementId: string | undefined;
}) {
  const coverageQ = useCimCoverage(engagementId);
  const coverage = coverageQ.data ?? null;
  const evidenceHref = engagementId ? `/engagement/${engagementId}/evidence` : '#';

  const aside = coverage ? (
    <section className="cim-readiness no-print">
      <div className="cim-readiness-head">
        <div>
          <span className="cim-readiness-eyebrow">CIM readiness</span>
          <p className="cim-readiness-sub muted">
            How much of the memorandum is backed by evidence already assembled in the data room. Collect
            the rest in <Link to={evidenceHref}>Evidence</Link>.
          </p>
        </div>
        <div className="cim-readiness-figure">
          <span className="cim-readiness-pct">{coverage.summary.pct}%</span>
          <span className="muted">
            {coverage.summary.itemsReady} of {coverage.summary.itemsTotal} items ready
          </span>
        </div>
      </div>
      <div className="cim-section-grid">
        {coverage.sections.map((s) => (
          <div key={s.code} className={`cim-section-row ${s.narrative ? 'cim-section-narrative' : ''}`}>
            <span className="cim-section-name">{s.name}</span>
            {s.narrative ? (
              <span className="cim-section-tag muted">Narrative</span>
            ) : (
              <>
                <span className="cim-section-track" title={`${s.itemsReady} of ${s.itemsTotal} ready`}>
                  <span
                    className={`cim-section-fill ${s.pct >= 100 ? 'is-full' : s.pct > 0 ? 'is-partial' : 'is-empty'}`}
                    style={{ width: `${s.pct}%` }}
                  />
                </span>
                <span className="cim-section-count">
                  {s.itemsReady}/{s.itemsTotal}
                  {s.itemsVerified > 0 && <span className="cim-verified"> · {s.itemsVerified} verified</span>}
                </span>
              </>
            )}
          </div>
        ))}
      </div>
      {coverage.sections.some((s) => s.missing.length > 0) && (
        <Collapsible title="What's still needed" hint="Evidence items to collect before the CIM is fully backed">
          <ul className="cim-missing-list">
            {coverage.sections
              .filter((s) => s.missing.length > 0)
              .flatMap((s) =>
                s.missing.map((m) => (
                  <li key={`${s.code}-${m.item_code}`}>
                    <span className="cim-missing-section">{s.name}</span>
                    <span className="cim-missing-label">{m.label}</span>
                    <Link className="button-link" to={evidenceHref}>
                      Collect →
                    </Link>
                  </li>
                )),
              )}
          </ul>
        </Collapsible>
      )}
    </section>
  ) : null;

  return (
    <DocumentCurator
      assessmentId={assessmentId}
      docType="cim"
      aside={aside}
      emptyHint={
        <p className="muted">
          The CIM is drafted server-side from the company profile, the assessment’s strengths, and the
          evidence already collected. It is a buyer-facing marketing draft. Review and edit it before
          sharing. No number is invented; no weakness is surfaced.
        </p>
      }
      generatingHint={
        <p className="muted">
          Assembling the memorandum from the company profile, strengths, and verified evidence…
        </p>
      }
    >
      {(md) => <BrandedSheet>{renderMarkdown(md)}</BrandedSheet>}
    </DocumentCurator>
  );
}
