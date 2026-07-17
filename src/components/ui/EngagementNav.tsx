import { NavLink } from 'react-router-dom';

// Engagement sub-navigation, organized around the five sell-side preparation
// work streams (docs/17) rather than a flat list of features. The routes are
// unchanged; grouping them under work-stream labels makes the arc legible and,
// in particular, collapses the three Evidence tabs (data room, documents,
// verification) into the one binder-building job they actually are.
interface NavTab {
  to: string;
  label: string;
  end?: boolean;
}
interface WorkStream {
  stream: string;
  tabs: NavTab[];
}

const WORK_STREAMS: WorkStream[] = [
  { stream: 'Readiness', tabs: [
    { to: '', label: 'Overview', end: true },
    { to: '/buyer-lens', label: 'Buyer lens' },
  ] },
  { stream: 'Remediation', tabs: [
    { to: '/roadmap', label: 'Roadmap' },
  ] },
  { stream: 'Evidence', tabs: [
    { to: '/data-room', label: 'Data room' },
    { to: '/documents', label: 'Documents' },
    { to: '/verification', label: 'Verification' },
  ] },
  { stream: 'Value', tabs: [
    { to: '/valuation', label: 'Valuation' },
  ] },
  { stream: 'Deliverables', tabs: [
    { to: '/delta', label: 'Delta report' },
  ] },
];

export function EngagementNav({ engagementId }: { engagementId: string }) {
  const base = `/engagement/${engagementId}`;
  return (
    <nav className="eng-nav" aria-label="Engagement">
      {WORK_STREAMS.map((ws) => (
        <div className="eng-nav-group" key={ws.stream}>
          <span className="eng-nav-group-label">{ws.stream}</span>
          <div className="eng-nav-links">
            {ws.tabs.map((t) => (
              <NavLink key={t.label} to={`${base}${t.to}`} end={t.end} className="eng-nav-link">
                {t.label}
              </NavLink>
            ))}
          </div>
        </div>
      ))}
    </nav>
  );
}
