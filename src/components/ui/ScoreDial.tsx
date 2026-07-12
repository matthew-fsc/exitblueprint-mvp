import { fmtScore } from '../../lib/format';
import { tierForScore } from '../../lib/tokens';
import { tierClass } from './tier';

// A radial score meter (0–100) colored by the score's tier. The number is
// always printed inside, so the ring color is a reinforcement, not the only
// cue. Used for DRS on results, dashboard, and reports.
export function ScoreDial({
  value,
  label,
  size = 132,
  max = 100,
  tier,
}: {
  value: number;
  label?: string;
  size?: number;
  max?: number;
  tier?: string;
}) {
  const stroke = size < 90 ? 8 : 11;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value / max));
  const resolvedTier = tier ?? tierForScore(value);

  return (
    <div className={`score-dial ${tierClass(resolvedTier)}`}>
      <svg
        className="score-dial-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={`${label ?? 'Score'}: ${fmtScore(value)} of ${max}`}
      >
        <circle
          className="score-dial-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="score-dial-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - pct)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        <text
          className="score-dial-value"
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={size * 0.3}
        >
          {fmtScore(value)}
        </text>
      </svg>
      {label && <span className="score-dial-label">{label}</span>}
    </div>
  );
}
