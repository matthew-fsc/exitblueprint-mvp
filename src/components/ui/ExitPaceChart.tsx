import { useId } from 'react';
import { tierForScore, tierColor, type TierName } from '../../lib/tokens';
import { useTheme } from '../../lib/theme';

export interface PacePoint {
  date: string | Date; // when this assessment completed
  score: number; // 0–100 DRS
  tier?: string;
  superseded?: boolean;
}

const MS_DAY = 86_400_000;
const toDate = (d: string | Date) => (typeof d === 'string' ? new Date(d) : d);

// Calendar-anchored DRS trajectory. Unlike the plain TrajectoryChart (spaced by
// assessment index), this plots assessments on a real time axis running to the
// owner's target exit date, and draws two forward lines:
//   • required pace — the slope needed to reach the target score by that date
//   • projected — where the DRS lands if the open roadmap is completed
// It answers the CFP's actual question: "are we on track to sell when you want to?"
export function ExitPaceChart({
  points,
  targetScore = 85,
  targetDate,
  projectedScore,
  today = new Date(),
  height = 240,
  width = 720,
}: {
  points: PacePoint[];
  targetScore?: number;
  targetDate: string | Date;
  projectedScore?: number | null;
  today?: Date;
  height?: number;
  width?: number;
}) {
  const uid = useId().replace(/:/g, '');
  const { theme } = useTheme();
  const mode = theme === 'dark' ? 'dark' : 'light';

  const padL = 34;
  const padR = 60; // room for the target label on the right
  const padT = 22;
  const padB = 30;
  const innerW = width - padL - padR;
  const innerH = height - padT - padB;

  const sorted = [...points].sort((a, b) => toDate(a.date).getTime() - toDate(b.date).getTime());
  const last = sorted[sorted.length - 1];
  const tgt = toDate(targetDate);

  // Time domain: earliest of (first assessment, today) → target date, padded.
  const times = sorted.map((p) => toDate(p.date).getTime());
  let minT = Math.min(today.getTime(), ...(times.length ? times : [today.getTime()]));
  let maxT = tgt.getTime();
  if (maxT <= (last ? toDate(last.date).getTime() : minT)) {
    // target already in the past relative to the latest point — extend 3 months.
    maxT = (last ? toDate(last.date).getTime() : today.getTime()) + 90 * MS_DAY;
  }
  const pad = Math.max((maxT - minT) * 0.03, 5 * MS_DAY);
  minT -= pad;
  maxT += pad;
  const span = maxT - minT || 1;

  const x = (t: number) => padL + (innerW * (t - minT)) / span;
  const y = (score: number) => padT + innerH * (1 - Math.max(0, Math.min(100, score)) / 100);

  const linePath = sorted
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${x(toDate(p.date).getTime()).toFixed(1)} ${y(p.score).toFixed(1)}`)
    .join(' ');
  const areaPath =
    sorted.length > 0
      ? `${linePath} L ${x(toDate(last.date).getTime()).toFixed(1)} ${(padT + innerH).toFixed(1)} L ${x(
          toDate(sorted[0].date).getTime(),
        ).toFixed(1)} ${(padT + innerH).toFixed(1)} Z`
      : '';

  const gridScores = [0, 25, 50, 75, 100];

  // Month ticks across the domain.
  const ticks: { t: number; label: string }[] = [];
  const cur = new Date(minT);
  cur.setDate(1);
  cur.setHours(0, 0, 0, 0);
  while (cur.getTime() <= maxT) {
    if (cur.getTime() >= minT) {
      ticks.push({
        t: cur.getTime(),
        label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      });
    }
    cur.setMonth(cur.getMonth() + 1);
  }
  // Thin dense tick sets so labels don't collide.
  const maxLabels = Math.floor(innerW / 60);
  const stride = ticks.length > maxLabels ? Math.ceil(ticks.length / maxLabels) : 1;

  const lastX = last ? x(toDate(last.date).getTime()) : padL;
  const lastY = last ? y(last.score) : y(0);
  const tgtX = x(tgt.getTime());
  const behindTarget = last != null && last.score < targetScore;
  const todayX = x(today.getTime());

  const projTier: TierName = projectedScore != null ? tierForScore(projectedScore) : 'Needs Work';

  return (
    <div className="pace-chart">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Readiness trajectory against the target exit date">
        {gridScores.map((s) => (
          <g key={s}>
            <line className="tc-grid" x1={padL} x2={width - padR} y1={y(s)} y2={y(s)} />
            <text className="tc-axis-label" x={padL - 6} y={y(s)} textAnchor="end" dominantBaseline="central">
              {s}
            </text>
          </g>
        ))}

        {/* month ticks */}
        {ticks.map((tk, i) =>
          i % stride === 0 ? (
            <text key={tk.t} className="tc-axis-label" x={x(tk.t)} y={height - 8} textAnchor="middle">
              {tk.label}
            </text>
          ) : null,
        )}

        {/* target level line */}
        <line className="tc-target" x1={padL} x2={width - padR} y1={y(targetScore)} y2={y(targetScore)} />

        {/* today marker */}
        {todayX >= padL && todayX <= width - padR && (
          <g>
            <line className="pace-today" x1={todayX} x2={todayX} y1={padT} y2={padT + innerH} />
            <text className="pace-today-label" x={todayX} y={padT - 8} textAnchor="middle">
              Today
            </text>
          </g>
        )}

        {/* required-pace line: last actual → (target date, target score) */}
        {last && behindTarget && (
          <line
            className="pace-required"
            x1={lastX}
            y1={lastY}
            x2={tgtX}
            y2={y(targetScore)}
          />
        )}

        {/* projected-completion line: last actual → (target date, projected score) */}
        {last && projectedScore != null && (
          <line
            className="pace-projected"
            x1={lastX}
            y1={lastY}
            x2={tgtX}
            y2={y(projectedScore)}
            style={{ stroke: tierColor(projTier, mode) }}
          />
        )}

        {/* actual area + line */}
        {sorted.length > 0 && <path className="tc-area" d={areaPath} />}
        {sorted.length > 1 && <path className="tc-line" d={linePath} />}

        {/* target marker */}
        <g>
          <circle className="pace-target-dot" cx={tgtX} cy={y(targetScore)} r={5} />
          <text className="pace-target-label" x={tgtX + 8} y={y(targetScore)} dominantBaseline="central">
            Target {targetScore}
          </text>
          <text className="pace-target-sub" x={tgtX + 8} y={y(targetScore) + 13} dominantBaseline="central">
            {tgt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })}
          </text>
        </g>

        {/* projected marker */}
        {projectedScore != null && (
          <circle
            className="pace-proj-dot"
            cx={tgtX}
            cy={y(projectedScore)}
            r={4}
            style={{ stroke: tierColor(projTier, mode) }}
          />
        )}

        {/* actual points */}
        {sorted.map((p, i) => {
          const tier = (p.tier as TierName) ?? tierForScore(p.score);
          const color = tierColor(tier, mode);
          const px = x(toDate(p.date).getTime());
          return (
            <g key={`${uid}-${i}`}>
              <circle
                className={`tc-point-outer ${p.superseded ? 'tc-point-superseded' : ''}`.trim()}
                cx={px}
                cy={y(p.score)}
                r={6}
                style={{ stroke: color }}
              />
              <text className="tc-point-label" x={px} y={y(p.score) - 12} textAnchor="middle">
                {Number.isInteger(p.score) ? p.score : p.score.toFixed(1)}
              </text>
            </g>
          );
        })}
      </svg>

      <div className="tc-legend">
        <span><span className="tc-legend-swatch" /> Assessment</span>
        <span><span className="pace-legend-line pace-legend-required" /> Required pace</span>
        {projectedScore != null && (
          <span><span className="pace-legend-line pace-legend-projected" /> Projected if roadmap done</span>
        )}
        <span>
          <span style={{ width: '1rem', borderTop: '1.5px dashed var(--accent)', display: 'inline-block' }} /> Target {targetScore}
        </span>
      </div>
    </div>
  );
}
