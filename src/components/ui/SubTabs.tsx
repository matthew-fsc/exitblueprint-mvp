import type { ReactNode } from 'react';

// A segmented sub-tab bar for switching between panels *within* one page — used
// where a surface has several related views that shouldn't each be their own
// route (the merged Evidence surface) or a deep stack of collapsibles (the
// Overview analysis section). One view is visible at a time; the rest are one
// click away, not a scroll-and-expand hunt.
//
// Purely presentational and controlled: the parent owns the active key and
// decides whether selecting a tab sets in-page state or navigates. A tab may
// carry a small count badge.
export interface SubTab {
  key: string;
  label: string;
  badge?: ReactNode;
}

export function SubTabs({
  tabs,
  activeKey,
  onSelect,
  ariaLabel = 'Sections',
}: {
  tabs: SubTab[];
  activeKey: string;
  onSelect: (key: string) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="subtabs" role="tablist" aria-label={ariaLabel}>
      {tabs.map((t) => {
        const active = t.key === activeKey;
        return (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={active}
            className={`subtab ${active ? 'subtab-active' : ''}`}
            onClick={() => onSelect(t.key)}
          >
            {t.label}
            {t.badge != null && <span className="subtab-badge">{t.badge}</span>}
          </button>
        );
      })}
    </div>
  );
}
