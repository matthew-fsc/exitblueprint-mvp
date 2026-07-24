import { useEffect, useRef } from 'react';
import { NavLink, useLocation } from 'react-router-dom';

// Engagement sub-navigation: one clean, evenly-spaced row of tabs. The tabs are
// ordered by the five sell-side preparation work streams (docs/17) — Readiness,
// Remediation, Evidence, Value, Deliverables — but the work-stream *grouping and
// labels* live in exactly one place, the WorkstreamRail on the Overview, not
// here. Encoding the grouping twice (rail labels + nav dividers) both duplicated
// the taxonomy and, once Evidence collapsed from three tabs to one, left the
// divider grouping separating mostly single tabs. So the nav is a flat row
// (navigation) and the rail carries the workflow state — one source of truth.
interface NavTab {
  to: string;
  label: string;
  stream: string; // the work stream this surface belongs to (ordering + docs)
  end?: boolean;
}

// Ordered by work stream; rendered as a single even row.
const TABS: NavTab[] = [
  { stream: 'Readiness', to: '', label: 'Overview', end: true },
  { stream: 'Readiness', to: '/buyer-lens', label: 'Buyer lens' },
  { stream: 'Readiness', to: '/diligence-qa', label: 'Diligence Q&A' },
  { stream: 'Remediation', to: '/roadmap', label: 'Roadmap' },
  { stream: 'Evidence', to: '/evidence', label: 'Evidence' },
  { stream: 'Value', to: '/valuation', label: 'Valuation' },
  { stream: 'Deliverables', to: '/deliverables', label: 'Deliverables' },
];

export function EngagementNav({ engagementId }: { engagementId: string }) {
  const base = `/engagement/${engagementId}`;
  // On a phone the tab bar is a horizontal-scroll strip (styles.css mobile pass).
  // Keep the current tab in view so deep tabs (Valuation, Delta report) aren't
  // scrolled off the right edge when you land on them. No-op on desktop.
  const navRef = useRef<HTMLElement>(null);
  const { pathname } = useLocation();
  useEffect(() => {
    const active = navRef.current?.querySelector<HTMLElement>('.eng-nav-link.active');
    active?.scrollIntoView({ block: 'nearest', inline: 'center' });
  }, [pathname]);
  return (
    <nav className="eng-nav" aria-label="Engagement" ref={navRef}>
      {TABS.map((t) => (
        <NavLink key={t.label} to={`${base}${t.to}`} end={t.end} className="eng-nav-link">
          {t.label}
        </NavLink>
      ))}
    </nav>
  );
}
