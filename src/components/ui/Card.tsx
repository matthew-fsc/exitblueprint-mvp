import type { ReactNode } from 'react';

export function Card({
  children,
  pad = 'md',
  className = '',
}: {
  children: ReactNode;
  pad?: 'md' | 'lg' | 'flush';
  className?: string;
}) {
  const padClass = pad === 'lg' ? 'ui-card-pad-lg' : pad === 'flush' ? 'ui-card-flush' : '';
  return <div className={`ui-card ${padClass} ${className}`.trim()}>{children}</div>;
}
