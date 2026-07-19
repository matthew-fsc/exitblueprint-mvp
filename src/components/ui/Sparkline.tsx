import { tierForScore, tierColor } from '../../lib/tokens';
import { useTheme } from '../../lib/theme';

// A tiny inline trajectory for a table row — the DRS trend at a glance,
// colored by the latest point's tier. No axes; the full chart lives on the
// engagement view.
export function Sparkline({
  points,
  width = 96,
  height = 28,
}: {
  points: { drs: number }[];
  width?: number;
  height?: number;
}) {
  const { theme } = useTheme();
  const mode = theme === 'dark' ? 'dark' : 'light';
  if (points.length === 0) {
    return <span className="muted text-sm">—</span>;
  }
  const pad = 3;
  const xs = (i: number) =>
    points.length <= 1 ? width / 2 : pad + ((width - 2 * pad) * i) / (points.length - 1);
  const ys = (v: number) => pad + (height - 2 * pad) * (1 - Math.max(0, Math.min(100, v)) / 100);
  const color = tierColor(tierForScore(points[points.length - 1].drs), mode);
  const d = points.map((p, i) => `${i === 0 ? 'M' : 'L'} ${xs(i).toFixed(1)} ${ys(p.drs).toFixed(1)}`).join(' ');
  const last = points[points.length - 1];
  // Area fill under the line — a soft gradient to the baseline — so the trend
  // reads as a chart, not a stray line (institutional data surfaces).
  const gid = `spark-${Math.round(xs(points.length - 1))}-${Math.round(ys(last.drs))}`;
  const area = `${d} L ${xs(points.length - 1).toFixed(1)} ${(height - pad).toFixed(1)} L ${xs(0).toFixed(1)} ${(height - pad).toFixed(1)} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
      {points.length > 1 && (
        <>
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.16} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path d={area} fill={`url(#${gid})`} stroke="none" />
          <path d={d} fill="none" stroke={color} strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" />
        </>
      )}
      <circle cx={xs(points.length - 1)} cy={ys(last.drs)} r={2.4} fill={color} />
      <circle cx={xs(points.length - 1)} cy={ys(last.drs)} r={2.4} fill="none" stroke="var(--surface-1)" strokeWidth={1} />
    </svg>
  );
}
