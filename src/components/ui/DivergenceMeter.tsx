// Business readiness (DRS) vs. owner readiness (ORI) on one 0–100 track. The
// gap between them is itself a finding in the methodology (docs/07): a ready
// business with an unready owner — or the reverse — means the plan has to move
// both. When the two are ≥15 apart the meter calls it out.
export function DivergenceMeter({
  drs,
  ori,
  threshold = 15,
}: {
  drs: number;
  ori: number;
  threshold?: number;
}) {
  const gap = Math.abs(drs - ori);
  const divergent = gap >= threshold;
  const lo = Math.min(drs, ori);
  const hi = Math.max(drs, ori);

  return (
    <div className="diverge">
      <div className="diverge-heads">
        <div className="diverge-head">
          <span className="diverge-num" style={{ color: 'var(--accent-strong)' }}>{Math.round(drs)}</span>
          <span className="diverge-cap">Business · DRS</span>
        </div>
        <div className="diverge-head diverge-head-right">
          <span className="diverge-num" style={{ color: 'var(--status-serious)' }}>{Math.round(ori)}</span>
          <span className="diverge-cap">Owner · ORI</span>
        </div>
      </div>
      <div className="diverge-track">
        {/* span between the two markers */}
        <div
          className={`diverge-span ${divergent ? 'diverge-span-wide' : ''}`}
          style={{ left: `${lo}%`, width: `${hi - lo}%` }}
        />
        <div className="diverge-marker diverge-marker-drs" style={{ left: `${drs}%` }} title={`DRS ${drs}`} />
        <div className="diverge-marker diverge-marker-ori" style={{ left: `${ori}%` }} title={`ORI ${ori}`} />
      </div>
      <p className={`diverge-note ${divergent ? 'diverge-note-alert' : ''}`}>
        {divergent
          ? `${gap.toFixed(0)} points apart — the business and the owner are at different stages. The plan has to move both, not just one.`
          : `${gap.toFixed(0)} points apart — business and owner readiness are broadly aligned.`}
      </p>
    </div>
  );
}
