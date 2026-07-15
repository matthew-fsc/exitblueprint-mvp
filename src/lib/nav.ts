// Shared breadcrumb builders so the app's navigation hierarchy is defined once.
// The engagement sub-pages (roadmap, valuation, buyer lens, delta report) all
// hang off Portfolio > Company, and previously each hand-built that array.

export interface Crumb {
  label: string;
  to?: string;
}

// Portfolio > <company> > <current sub-page>. The company crumb links back to
// the engagement overview.
export function engagementCrumbs(
  engagementId: string | undefined,
  companyName: string,
  current: string,
): Crumb[] {
  return [
    { label: 'Portfolio', to: '/' },
    { label: companyName, to: `/engagement/${engagementId}` },
    { label: current },
  ];
}
