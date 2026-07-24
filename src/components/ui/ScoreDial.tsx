import { useEffect, useState } from 'react';
import { fmtScore } from '../../lib/format';
import { tierForScore } from '../../lib/tokens';
import { tierClass } from './tier';

// The DRS score instrument — the app's signature. A full circular ring rendered
// on a forest-dark panel (the one deliberate dark moment on the light app),
// reused wherever a score appears (dashboard, results, report). The number is
// always printed immediately in Schibsted Grotesk; only the ring sweeps, and
// only on first load, respecting prefers-reduced-motion. The ring color (tier)
// is a reinforcement — the printed number is the real cue.

// Sweep runs once per page load, not on every remount / route return.
let sweptOnce = false;

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
  const target = Math.max(0, Math.min(1, value / max));
  const resolvedTier = tier ?? tierForScore(value);

  const stroke = size < 100 ? 9 : 12;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;

  // Start at the target unless this is the first eligible sweep of the load.
  const [progress, setProgress] = useState(() => {
    if (typeof window === 'undefined') return target;
    const reduce = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    return reduce || sweptOnce ? target : 0;
  });
  const animating = progress !== target;

  useEffect(() => {
    if (progress === target) return;
    sweptOnce = true;
    // Two rAFs so the browser paints the 0 state before transitioning.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setProgress(target));
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className={`score-gauge ${tierClass(resolvedTier)}`}
      role="img"
      aria-label={`${label ?? 'Score'}: ${fmtScore(value)} of ${max}`}
    >
      <svg
        className="score-gauge-svg"
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        aria-hidden="true"
      >
        <circle
          className="score-gauge-track"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
        />
        <circle
          className="score-gauge-fill"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - progress)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
          style={{ transition: animating ? undefined : 'none' }}
        />
        <text
          className="score-gauge-value"
          x="50%"
          y="50%"
          dominantBaseline="central"
          textAnchor="middle"
          fontSize={size * 0.3}
        >
          {fmtScore(value)}
        </text>
      </svg>
      {label && <span className="score-gauge-label">{label}</span>}
    </div>
  );
}
