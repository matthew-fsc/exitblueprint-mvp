import { NavLink } from 'react-router-dom';

// Engagement sub-navigation. The tabs are ordered by the five sell-side
// preparation work streams (docs/17) and separated into those groups by a subtle
// divider — but the work-stream *labels* live only on the WorkstreamRail below,
// not here: repeating them in both places duplicated the taxonomy and, because
// each tab group was as wide as its uppercase label, stranded short tabs with
// uneven gaps. The tab bar is now a clean, evenly-spaced row (institutional
// convention: tabs are navigation; the rail carries the workflow state).
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
          {ws.tabs.map((t) => (
            <NavLink key={t.label} to={`${base}${t.to}`} end={t.end} className="eng-nav-link">
              {t.label}
            </NavLink>
          ))}
        </div>
      ))}
    </nav>
  );
}
