import type { ReactNode } from 'react';
import { Card } from './Card';

// A Card with the standard section header the app repeats everywhere: an
// uppercase label, an optional muted subtitle, and an optional right-aligned
// action (a link or button). Consolidates the hand-rolled
// `<Card><span className="stat-block-label">…</span><p className="muted">…` so
// every titled card shares one spacing and typographic rhythm.
export function SectionCard({
  title,
  subtitle,
  action,
  pad = 'md',
  className = '',
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  pad?: 'md' | 'lg' | 'flush';
  className?: string;
  children: ReactNode;
}) {
  return (
    <Card pad={pad} className={className}>
      <div className="section-card-head">
        <div className="section-card-titles">
          <span className="stat-block-label">{title}</span>
          {subtitle && <p className="section-card-sub muted">{subtitle}</p>}
        </div>
        {action && <div className="section-card-action">{action}</div>}
      </div>
      {children}
    </Card>
  );
}
