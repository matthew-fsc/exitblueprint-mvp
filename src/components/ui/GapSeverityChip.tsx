import type { ReactNode } from 'react';
import { gapSeverityStatus } from '../../lib/severity';

// The severity pill shown next to a gap. Wraps the .gap-chip + severity->status
// mapping so every gap list renders it identically. Defaults its label to the
// severity word; pass children to override.
export function GapSeverityChip({
  severity,
  children,
}: {
  severity: string | null | undefined;
  children?: ReactNode;
}) {
  return <span className={`gap-chip gap-${gapSeverityStatus(severity)}`}>{children ?? severity}</span>;
}
