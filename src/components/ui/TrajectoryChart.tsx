import { useId } from 'react';
import { tierForScore, tierColor, type TierName } from '../../lib/tokens';
import { useTheme } from '../../lib/theme';

export interface TrajectoryPoint {
  label: string; // x-axis label, e.g. "#1" or a date
  score: number; // 0–100 DRS
  tier?: string;
  superseded?: boolean;
}

// The signature visualization: DRS over the life of an engagement. One axis
// (DRS 0–100), a single accent line + soft area, tier-colored point rings, an
// optional dashed target line, and direct value labels on each point. This is
// the visual embodiment of the longitudinal thesis and appears on the
// dashboard, engagement view, and printed report.
export function TrajectoryChart({
  points,
  targetScore,
  height = 200,
  width = 640,
}: {
  points: TrajectoryPoint[];
  targetScore?: number | null;
  height?: number;
  width?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const { theme } = useTheme();
  const mode = theme === 'dark' ? 'dark' : 'light';

  const padL = 34;
  const padR = 18;
  const padT = 22;
  const padB = 28;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const x = (i: number) =>
    padL + (points.length <= 1 ? innerW / 2 : (innerW * i) / (points.length - 1));
  const y = (score: number) => padT + innerH * (1 - Math.max(0, Math.min(100, score)) / 100);

  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(i).toFixed(1)} ${y(p.score).toFixed(1)}`)
    .join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L ${x(points.length - 1).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(0).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`
      : '';

  const gridScores = [0, 25, 50, 75, 100];

  return (
    <div className="trajectory-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Diligence Readiness Score over time">
        {/* gridlines + y labels */}
        {gridScores.map((s) => (
          <g key={s}>
            <line className="tc-grid" x1={padL} x2={width - padR} y1={y(s)} y2={y(s)} />
            <text className="tc-axis-label" x={padL - 6} y={y(s)} textAnchor="end" dominantBaseline="central">
              {s}
            </text>
          </g>
        ))}

        {/* target line */}
        {targetScore != null && (
          <line className="tc-target" x1={padL} x2={width - padR} y1={y(targetScore)} y2={y(targetScore)} />
        )}

        {/* area + line */}
        {points.length > 0 && <path className="tc-area" d={areaPath} />}
        {points.length > 1 && <path className="tc-line" d={linePath} />}

        {/* points */}
        {points.map((p, i) => {
          const tier = (p.tier as TierName) ?? tierForScore(p.score);
          const color = tierColor(tier, mode);
          return (
            <g key={`${uid}-${i}`}>
              <circle
                className={`tc-point-outer ${p.superseded ? 'tc-point-superseded' : ''}`.trim()}
                cx={x(i)}
                cy={y(p.score)}
                r={6}
                style={{ stroke: color }}
              />
              <text
                className="tc-point-label"
                x={x(i)}
                y={y(p.score) - 12}
                textAnchor="middle"
              >
                {Number.isInteger(p.score) ? p.score : p.score.toFixed(1)}
              </text>
              <text className="tc-axis-label" x={x(i)} y={height - 8} textAnchor="middle">
                {p.label}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="tc-legend">
        <span>
          <span className="tc-legend-swatch" /> Assessment
        </span>
        <span>
          <span className="tc-legend-swatch dashed" /> Superseded
        </span>
        {targetScore != null && (
          <span>
            <span
              style={{
                width: '1rem',
                borderTop: '1.5px dashed var(--accent)',
                display: 'inline-block',
              }}
            />{' '}
            Target {targetScore}
          </span>
        )}
      </div>
    </div>
  );
}
