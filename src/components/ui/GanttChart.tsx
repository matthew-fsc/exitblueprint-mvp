import { Fragment } from 'react';

export interface GanttItem {
  id: string;
  label: string;
  sublabel?: string;
  track: 'business' | 'personal';
  kind: 'task' | 'milestone';
  start?: string | Date; // tasks: bar start; milestones ignore
  end: string | Date; // tasks: due date; milestones: target date
  status?: 'todo' | 'doing' | 'done' | 'blocked' | 'reached';
}

const MS_DAY = 86_400_000;
const toDate = (d: string | Date) => (typeof d === 'string' ? new Date(d) : d);

const TRACK_LABEL: Record<GanttItem['track'], string> = {
  business: 'Business readiness',
  personal: 'Personal & wealth planning',
};

const STATUS_WORD: Record<NonNullable<GanttItem['status']>, string> = {
  todo: 'not started',
  doing: 'in progress',
  done: 'done',
  blocked: 'blocked',
  reached: 'reached',
};

// A lightweight HTML/CSS Gantt: two swimlanes, month grid, task bars, milestone
// diamonds, and a "today" marker. Positions are percentages across the domain.
export function GanttChart({ items, today = new Date() }: { items: GanttItem[]; today?: Date }) {
  if (items.length === 0) return null;

  const dates: number[] = [];
  for (const it of items) {
    dates.push(toDate(it.end).getTime());
    if (it.start) dates.push(toDate(it.start).getTime());
  }
  dates.push(today.getTime());
  let min = Math.min(...dates);
  let max = Math.max(...dates);
  // pad the domain to whole months and give at least a 3-month window
  const pad = Math.max((max - min) * 0.04, 7 * MS_DAY);
  min -= pad;
  max += pad;
  if (max - min < 90 * MS_DAY) max = min + 90 * MS_DAY;
  const span = max - min;
  const pct = (t: number) => ((t - min) / span) * 100;

  // month ticks
  const ticks: { label: string; left: number }[] = [];
  const cur = new Date(min);
  cur.setDate(1);
  cur.setHours(0, 0, 0, 0);
  while (cur.getTime() <= max) {
    ticks.push({
      label: cur.toLocaleDateString('en-US', { month: 'short', year: '2-digit' }),
      left: pct(cur.getTime()),
    });
    cur.setMonth(cur.getMonth() + 1);
  }

  const tracks: GanttItem['track'][] = ['business', 'personal'];
  const todayLeft = pct(today.getTime());

  return (
    <div className="gantt">
      <div className="gantt-scroll">
        <div className="gantt-inner">
          {/* axis */}
          <div className="gantt-axis">
            <div className="gantt-rowlabel" />
            <div className="gantt-track">
              {ticks.map((t, i) => (
                <span key={i} className="gantt-tick" style={{ left: `${t.left}%` }}>
                  {t.label}
                </span>
              ))}
            </div>
          </div>

          {/* today line spans the body, offset past the fixed label column */}
          {todayLeft >= 0 && todayLeft <= 100 && (
            <div
              className="gantt-today"
              style={{ left: `calc(var(--gantt-label) + (100% - var(--gantt-label)) * ${(todayLeft / 100).toFixed(4)})` }}
            />
          )}

          {tracks.map((track) => {
            const rows = items.filter((it) => it.track === track);
            if (rows.length === 0) return null;
            return (
              <Fragment key={track}>
                <div className="gantt-swimlane">{TRACK_LABEL[track]}</div>
                {rows.map((it) => (
                  <div key={it.id} className="gantt-row">
                    <div className="gantt-rowlabel">
                      <span className="gantt-rowlabel-title" title={it.label}>
                        {it.label}
                      </span>
                      {it.sublabel && <span className="gantt-rowlabel-sub">{it.sublabel}</span>}
                    </div>
                    <div className="gantt-track">
                      {ticks.map((t, i) => (
                        <span key={i} className="gantt-gridline" style={{ left: `${t.left}%` }} />
                      ))}
                      {it.kind === 'task' ? (
                        <span
                          className={`gantt-bar gantt-${it.status ?? 'todo'}`}
                          style={{
                            left: `${pct(toDate(it.start ?? it.end).getTime())}%`,
                            width: `${Math.max(1.5, pct(toDate(it.end).getTime()) - pct(toDate(it.start ?? it.end).getTime()))}%`,
                          }}
                          role="img"
                          aria-label={`${it.label} — ${STATUS_WORD[it.status ?? 'todo']}, due ${toDate(it.end).toLocaleDateString()}`}
                          title={`${it.label} — due ${toDate(it.end).toLocaleDateString()}`}
                        />
                      ) : (
                        <span
                          className={`gantt-diamond ${it.status === 'reached' ? 'gantt-done' : ''}`}
                          style={{ left: `${pct(toDate(it.end).getTime())}%` }}
                          role="img"
                          aria-label={`Milestone: ${it.label} — ${it.status === 'reached' ? 'reached' : 'target'} ${toDate(it.end).toLocaleDateString()}`}
                          title={`${it.label} — ${toDate(it.end).toLocaleDateString()}`}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </Fragment>
            );
          })}
        </div>
      </div>
      <div className="gantt-legend">
        <span><span className="gantt-swatch gantt-todo" /> To do</span>
        <span><span className="gantt-swatch gantt-done" /> Done</span>
        <span><span className="gantt-swatch gantt-blocked" /> Blocked</span>
        <span><span className="gantt-diamond-legend" /> Milestone</span>
        <span><span className="gantt-today-legend" /> Today</span>
      </div>
    </div>
  );
}
