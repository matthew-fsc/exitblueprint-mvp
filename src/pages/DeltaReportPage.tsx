import { useMemo } from 'react';
import {
  useAssessmentsByEngagement,
  useCompany,
  useCompare,
  useEngagement,
} from '../lib/queries';
import { DataTable, DeltaChip, TierBadge, type Column } from '../components/ui';
import { DocumentCurator, BrandedSheet } from '../components/DocumentCurator';
import { fmtDate, fmtScore } from '../lib/format';

// The delta report deliverable, rendered as a panel inside the Deliverables
// studio. Unlike the owner report and CIM, the delta is a comparison: it reads
// the studio's selected assessment as the "current" and derives the prior
// completed assessment on the same rubric version. The figures (headline
// movement, per-dimension change, resolved/opened gap counts) come straight from
// the deterministic compare-assessments engine; only the narrative prose is
// editable — the shared DocumentCurator owns generate → edit → finalize →
// download.
export function DeltaReportPanel({
  assessmentId,
  engagementId,
}: {
  assessmentId: string | undefined;
  engagementId: string | undefined;
}) {
  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const companyName = companyQ.data?.name ?? '';
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const completed = (assessmentsQ.data ?? []).filter((a) => a.status === 'completed' && a.drs_score != null);

  const current = completed.find((a) => a.id === assessmentId) ?? null;
  const prior = useMemo(() => {
    if (!current) return null;
    const earlier = completed.filter((a) => a.sequence_number < current.sequence_number);
    return earlier.length ? earlier[earlier.length - 1] : null;
  }, [completed, current]);

  const comparable = !!prior && prior.rubric_version_id === current?.rubric_version_id;
  const isBaseline = !prior || !comparable;

  const compareQ = useCompare(comparable ? prior!.id : undefined, comparable ? assessmentId : undefined);
  const cmp = compareQ.data;

  const dimCols: Column<{ code: string; name: string; prior: number; current: number; delta: number }>[] = [
    { key: 'name', header: 'Business area' },
    { key: 'prior', header: 'Prior', numeric: true, render: (r) => fmtScore(r.prior) },
    { key: 'current', header: 'Current', numeric: true, render: (r) => fmtScore(r.current) },
    { key: 'delta', header: 'Change', numeric: true, render: (r) => <DeltaChip value={r.delta} digits={2} /> },
  ];

  const aside = (
    <p className="muted no-print delta-compared-against">
      {prior ? (
        comparable ? (
          <>
            Compared against assessment #{prior.sequence_number}
            {prior.completed_at ? ` · ${fmtDate(prior.completed_at)}` : ''}.
          </>
        ) : (
          <>
            The prior assessment uses a different methodology version, so this renders as a{' '}
            <strong>baseline report</strong> (current levels, not changes) rather than a misleading delta.
          </>
        )
      ) : (
        <>No prior assessment. This renders as a baseline report.</>
      )}
    </p>
  );

  return (
    <DocumentCurator
      assessmentId={assessmentId}
      docType="delta_report"
      aside={aside}
      emptyHint={
        <p className="muted">
          Generate the report to preview it, edit the narrative, and download a branded PDF. Every figure is
          fixed by the scoring engine; only the prose is editable.
        </p>
      }
      generatingHint={<p className="muted">Composing the branded report from the deterministic comparison…</p>}
    >
      {(md) => (
        <BrandedSheet wrap={false} articleClassName="delta-preview">
          <h1 className="mt-0">
            {isBaseline ? 'Baseline readiness' : 'Progress this period'}: {companyName}
          </h1>

          {!isBaseline && cmp && cmp.comparable ? (
            <div className="delta-headline">
              <span className="delta-prior tnum">{fmtScore(cmp.prior.drsScore)}</span>
              <span className="compare-arrow">→</span>
              <span className="delta-current tnum">{fmtScore(cmp.current.drsScore)}</span>
              <DeltaChip value={cmp.drsDelta} />
              <TierBadge tier={cmp.current.drsTier} />
            </div>
          ) : (
            current && (
              <div className="delta-headline">
                <span className="delta-current tnum">{fmtScore(Number(current.drs_score))}</span>
                {current.drs_tier && <TierBadge tier={current.drs_tier} />}
              </div>
            )
          )}

          <div className="delta-narrative">{renderProse(md)}</div>

          {!isBaseline && cmp && cmp.comparable && (
            <>
              <h2>Where the business moved</h2>
              <DataTable
                columns={dimCols}
                rows={cmp.dimensions.map((d) => ({
                  code: d.code,
                  name: dimName(d.code),
                  prior: d.prior,
                  current: d.current,
                  delta: d.delta,
                }))}
                keyFor={(r) => r.code}
              />
              <div className="compare-gap-summary" style={{ marginTop: '0.9rem' }}>
                <span className="delta delta-up">▼ {cmp.gapsResolved.length} resolved</span>
                <span className="delta delta-down">▲ {cmp.gapsOpened.length} newly opened</span>
              </div>
            </>
          )}
        </BrandedSheet>
      )}
    </DocumentCurator>
  );
}

// Dimension code → display name (the six business dimensions).
const DIM_NAMES: Record<string, string> = {
  REV: 'Revenue Quality',
  FIN: 'Financial Integrity',
  OPS: 'Operational Independence',
  CUS: 'Customer Risk',
  MGT: 'Management and Team',
  GRW: 'Growth Drivers',
};
const dimName = (code: string) => DIM_NAMES[code] ?? code;

// Very small markdown-ish renderer for the preview prose (bold + headings +
// bullets), matching the owner-report renderer's subset.
function renderProse(md: string) {
  return md.split('\n').map((line, i) => {
    if (line.startsWith('## ')) return <h2 key={i}>{line.slice(3)}</h2>;
    if (line.startsWith('# ')) return null; // title already shown
    if (line.startsWith('- ')) return <li key={i}>{bold(line.slice(2))}</li>;
    if (line.trim() === '') return <div key={i} className="report-gap" />;
    return <p key={i}>{bold(line)}</p>;
  });
}
function bold(text: string) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p));
}
