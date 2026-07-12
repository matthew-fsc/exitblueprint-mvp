import { fmtScore } from '../../lib/format';

export interface DimensionDatum {
  code: string;
  name: string;
  score: number;
}

// Horizontal bars for the six business dimensions. Bar length encodes the
// 0–100 score; the number is always shown. Status color by score band keeps it
// legible at a glance without implying tier semantics (tiers are DRS-only).
function band(score: number): string {
  return score >= 75
    ? 'var(--status-good)'
    : score >= 55
      ? 'var(--status-ok)'
      : score >= 40
        ? 'var(--status-warning)'
        : 'var(--status-critical)';
}

export function DimensionBars({ dimensions }: { dimensions: DimensionDatum[] }) {
  return (
    <div className="dimbars">
      {dimensions.map((d) => (
        <div key={d.code} className="dimbar-row">
          <span className="dimbar-name">{d.name}</span>
          <span className="dimbar-track">
            <span
              className="dimbar-fill"
              style={{ width: `${Math.max(0, Math.min(100, d.score))}%`, background: band(d.score) }}
            />
          </span>
          <span className="dimbar-val">{fmtScore(d.score)}</span>
        </div>
      ))}
    </div>
  );
}
