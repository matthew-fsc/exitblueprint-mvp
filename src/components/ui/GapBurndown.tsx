import { fmtDate } from '../../lib/format';

export interface BurndownDatum {
  seq: number;
  date: string | null;
  critical: number;
  high: number;
  med: number;
  low: number;
  total: number;
}

const SEVS = [
  { key: 'critical', label: 'Critical', varName: '--status-critical' },
  { key: 'high', label: 'High', varName: '--status-serious' },
  { key: 'med', label: 'Med', varName: '--status-warning' },
  { key: 'low', label: 'Low', varName: '--status-neutral' },
] as const;

// Gap burn-down: one stacked bar per assessment, segmented by severity, scaled
// to the worst assessment so the bars visibly shrink as gaps get resolved.
// Reads remediation progress at a glance — the counterpart to the score trend.
export function GapBurndown({ points }: { points: BurndownDatum[] }) {
  const max = Math.max(1, ...points.map((p) => p.total));
  return (
    <div className="burndown">
      <div className="burndown-rows">
        {points.map((p) => (
          <div className="burndown-row" key={p.seq}>
            <span className="burndown-tick">
              #{p.seq}
              {p.date && <span className="burndown-date">{fmtDate(p.date)}</span>}
            </span>
            <div className="burndown-bar-wrap">
              <div className="burndown-bar" style={{ width: `${(p.total / max) * 100}%` }}>
                {SEVS.map((s) => {
                  const v = p[s.key];
                  if (v === 0) return null;
                  return (
                    <div
                      key={s.key}
                      className="burndown-seg"
                      style={{ flex: v, background: `var(${s.varName})` }}
                      title={`${v} ${s.label}`}
                    />
                  );
                })}
              </div>
              <span className="burndown-total">{p.total === 0 ? 'all clear' : p.total}</span>
            </div>
          </div>
        ))}
      </div>
      <div className="burndown-legend">
        {SEVS.map((s) => (
          <span key={s.key}>
            <span className="burndown-swatch" style={{ background: `var(${s.varName})` }} /> {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}
