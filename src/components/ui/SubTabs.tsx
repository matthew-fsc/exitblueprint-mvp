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

// Id helpers so a consumer can wire the visible panel back to its tab:
//   <div role="tabpanel" id={subTabPanelId(key)} aria-labelledby={subTabId(key)} />
export const subTabId = (key: string) => `subtab-${key}`;
export const subTabPanelId = (key: string) => `subtabpanel-${key}`;

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
  // Left/Right/Home/End move between tabs (the ARIA tabs keyboard contract);
  // only the active tab is in the tab order (roving tabindex).
  const onKeyDown = (e: React.KeyboardEvent) => {
    const idx = tabs.findIndex((t) => t.key === activeKey);
    if (idx < 0) return;
    let next = idx;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (idx + 1) % tabs.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (idx - 1 + tabs.length) % tabs.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = tabs.length - 1;
    else return;
    e.preventDefault();
    onSelect(tabs[next].key);
  };

  return (
    <div className="subtabs" role="tablist" aria-label={ariaLabel} onKeyDown={onKeyDown}>
      {tabs.map((t) => {
        const active = t.key === activeKey;
        return (
          <button
            key={t.key}
            id={subTabId(t.key)}
            type="button"
            role="tab"
            aria-selected={active}
            aria-controls={subTabPanelId(t.key)}
            tabIndex={active ? 0 : -1}
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
