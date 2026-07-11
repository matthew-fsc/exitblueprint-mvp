import type { ReactNode } from 'react';

// Every empty state names the next action (spec §3.5).
export function EmptyState({
  icon = '◇',
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden>
        {icon}
      </span>
      <span className="empty-state-title">{title}</span>
      {children && <p className="empty-state-body">{children}</p>}
      {action}
    </div>
  );
}
