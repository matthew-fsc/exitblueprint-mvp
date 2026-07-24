import { NavLink } from 'react-router-dom';
import type { WorkstreamStatus } from '../../lib/workstreams';

// The five sell-side preparation work streams as a first-class progress rail on
// the engagement Overview (docs/17 follow-up; docs/archive/22). Each chip shows where the
// engagement stands in one core workflow and deep-links to that stream's tab.
// Purely presentational — it renders the model buildWorkstreamProgress() returns.

const STATE_LABEL: Record<WorkstreamStatus['state'], string> = {
  done: 'Done',
  active: 'In motion',
  todo: 'To start',
  blocked: 'Blocked',
};

export function WorkstreamRail({
  streams,
  engagementId,
}: {
  streams: WorkstreamStatus[];
  engagementId: string;
}) {
  const base = `/engagement/${engagementId}`;
  return (
    <nav className="ws-rail" aria-label="Preparation work streams">
      {streams.map((s, idx) => (
        <NavLink
          key={s.key}
          to={`${base}${s.to}`}
          end={s.to === ''}
          className={`ws-chip ws-state-${s.state}`}
          title={s.detail}
          aria-label={`${s.label}: ${STATE_LABEL[s.state]}. ${s.headline}`}
        >
          <span className="ws-chip-step" aria-hidden>
            {idx + 1}
          </span>
          <span className="ws-chip-body">
            <span className="ws-chip-top">
              <span className="ws-chip-label">{s.label}</span>
              <span className={`ws-chip-dot ws-dot-${s.state}`} aria-hidden />
            </span>
            <span className="ws-chip-headline">{s.headline}</span>
          </span>
        </NavLink>
      ))}
    </nav>
  );
}
