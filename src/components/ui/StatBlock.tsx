import type { ReactNode } from 'react';

// A single KPI: label, big value, optional hint or delta beside the value.
export function StatBlock({
  label,
  value,
  aside,
  hint,
}: {
  label: string;
  value: ReactNode;
  aside?: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="stat-block">
      <span className="stat-block-label">{label}</span>
      <span className="stat-block-value">
        {value}
        {aside}
      </span>
      {hint && <span className="stat-block-hint">{hint}</span>}
    </div>
  );
}

export function StatRow({ children }: { children: ReactNode }) {
  return <div className="stat-row">{children}</div>;
}
