import { NavLink } from 'react-router-dom';

// Shared sub-navigation for every engagement-scoped page. Groups the five
// engagement surfaces into one coherent, always-visible tab bar so an advisor
// can move between Overview, Roadmap, Valuation, Buyer lens, and the Delta
// report without routing back through the overview. The active tab is driven by
// the route (NavLink), so pages don't pass an `active` prop.
export function EngagementNav({ engagementId }: { engagementId: string }) {
  const base = `/engagement/${engagementId}`;
  return (
    <nav className="eng-nav" aria-label="Engagement">
      <NavLink to={base} end className="eng-nav-link">
        Overview
      </NavLink>
      <NavLink to={`${base}/roadmap`} className="eng-nav-link">
        Roadmap
      </NavLink>
      <NavLink to={`${base}/valuation`} className="eng-nav-link">
        Valuation
      </NavLink>
      <NavLink to={`${base}/buyer-lens`} className="eng-nav-link">
        Buyer lens
      </NavLink>
      <NavLink to={`${base}/delta`} className="eng-nav-link">
        Delta report
      </NavLink>
    </nav>
  );
}
