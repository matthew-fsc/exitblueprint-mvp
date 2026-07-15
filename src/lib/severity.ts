// Severity is a shared vocabulary across gaps, advisory items, and flags. This
// module is the single source of truth for turning a severity string into the
// design-system status/class it maps to, so the mapping never drifts between
// pages (it was previously re-inlined in six of them).

// Gap severity -> the status token used by .gap-chip / .status-* on the
// results, engagement, workbench, owner-portal, and verify surfaces.
const GAP_STATUS: Record<string, string> = {
  critical: 'critical',
  high: 'serious',
  med: 'warning',
  low: 'neutral',
};

export function gapSeverityStatus(severity: string | null | undefined): string {
  return GAP_STATUS[severity ?? ''] ?? 'neutral';
}

// Ordering for "most severe first" sorts.
export const SEVERITY_RANK: Record<string, number> = { critical: 0, high: 1, med: 2, low: 3 };

export function bySeverity<T extends { severity: string }>(a: T, b: T): number {
  return (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
}

// Advisory-item severity -> the .sev-* class used by the buyer lens and library.
export function advisorySevClass(severity: string | null | undefined): string {
  switch (severity) {
    case 'critical':
      return 'sev-critical';
    case 'high':
      return 'sev-high';
    case 'med':
      return 'sev-med';
    default:
      return 'sev-low';
  }
}
