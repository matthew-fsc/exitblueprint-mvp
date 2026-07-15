import type { ReactNode } from 'react';

// A design-system disclosure built on native <details> — keyboard accessible,
// no JS state to manage. Used to fold secondary/administrative sections away so
// they don't compete with the primary content on a dense page.
export function Collapsible({
  title,
  hint,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  hint?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="ui-collapsible" open={defaultOpen}>
      <summary className="ui-collapsible-summary">
        <span className="ui-collapsible-chevron" aria-hidden>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </span>
        <span className="ui-collapsible-title">{title}</span>
        {hint && <span className="ui-collapsible-hint muted">{hint}</span>}
      </summary>
      <div className="ui-collapsible-body">{children}</div>
    </details>
  );
}
