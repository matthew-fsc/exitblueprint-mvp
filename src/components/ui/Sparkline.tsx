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

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden style={{ display: 'block' }}>
      {points.length > 1 && <path d={d} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />}
      <circle cx={xs(points.length - 1)} cy={ys(last.drs)} r={2.6} fill={color} />
    </svg>
  );
}
