import type { ReactNode } from 'react';

// A small set of line icons (24px, currentColor) so empty states read as part of
// one designed system rather than improvised glyphs. Pass a name for a built-in
// icon, or any node for a custom one.
export type EmptyIcon = 'empty' | 'documents' | 'check' | 'warning' | 'clock' | 'search';

const ICONS: Record<EmptyIcon, ReactNode> = {
  empty: (
    <>
      <path d="M3 7l2-3h14l2 3" />
      <path d="M3 7v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7" />
      <path d="M3 7h6l1.5 2h3L15 7h6" />
    </>
  ),
  documents: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
    </>
  ),
  check: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </>
  ),
  warning: (
    <>
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </>
  ),
};

function isIconName(v: unknown): v is EmptyIcon {
  return typeof v === 'string' && v in ICONS;
}

// Every empty state names the next action (spec §3.5).
export function EmptyState({
  icon = 'empty',
  title,
  children,
  action,
}: {
  icon?: EmptyIcon | ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <span className="empty-state-icon" aria-hidden>
        {isIconName(icon) ? (
          <svg
            width="26"
            height="26"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {ICONS[icon]}
          </svg>
        ) : (
          icon
        )}
      </span>
      <span className="empty-state-title">{title}</span>
      {children && <p className="empty-state-body">{children}</p>}
      {action}
    </div>
  );
}
