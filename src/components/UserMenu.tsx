// Account menu in the app bar. Folds account-level concerns (Security / MFA
// setup, Sign out) out of the primary navigation, which should carry only
// daily-workflow destinations (docs/archive/34 MEDIUM: "Security" was a once-only setup
// screen sitting as a peer of Engagements/Review/Library — Hick's Law load).
//
// Accessible menu button pattern (WAI-ARIA): the trigger has aria-haspopup +
// aria-expanded; the panel is role="menu" with role="menuitem" children. Opening
// focuses the first item; Escape closes and returns focus to the trigger; a click
// outside or focus leaving the menu closes it; Up/Down move between items.
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';

export interface UserMenuLink {
  to: string;
  label: string;
}

function initials(email?: string | null): string {
  const base = (email ?? '').trim();
  if (!base) return '?';
  const name = base.split('@')[0];
  const parts = name.split(/[.\-_]+/).filter(Boolean);
  const chars = parts.length >= 2 ? parts[0][0] + parts[1][0] : name.slice(0, 2);
  return chars.toUpperCase();
}

export function UserMenu({
  email,
  links,
  onSignOut,
}: {
  email?: string | null;
  links: UserMenuLink[];
  onSignOut: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLElement | null>>([]);

  const close = useCallback((returnFocus: boolean) => {
    setOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, []);

  // Focus the first item when the menu opens.
  useEffect(() => {
    if (open) itemRefs.current[0]?.focus();
  }, [open]);

  // Close on a click anywhere outside the menu.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  // Roving focus between items; Escape closes and returns focus to the trigger.
  const onItemKeyDown = (e: React.KeyboardEvent, index: number) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      itemRefs.current[(index + 1) % itemRefs.current.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      itemRefs.current[(index - 1 + itemRefs.current.length) % itemRefs.current.length]?.focus();
    }
  };

  // Close if focus leaves the menu entirely (Tab past the last item).
  const onBlur = (e: React.FocusEvent) => {
    if (!rootRef.current?.contains(e.relatedTarget as Node)) setOpen(false);
  };

  const itemCount = links.length + 1; // links + Sign out
  itemRefs.current.length = itemCount;

  return (
    <div className="user-menu" ref={rootRef} onBlur={onBlur}>
      <button
        ref={triggerRef}
        type="button"
        className="user-menu-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="user-avatar" aria-hidden>
          {initials(email)}
        </span>
        <span className="user-email" title={email ?? undefined}>
          {email}
        </span>
        <svg className="user-menu-caret" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div className="user-menu-panel" role="menu" aria-label="Account">
          {email && <div className="user-menu-header">{email}</div>}
          {links.map((link, i) => (
            <Link
              key={link.to}
              to={link.to}
              role="menuitem"
              className="user-menu-item"
              ref={(el) => (itemRefs.current[i] = el)}
              onClick={() => close(false)}
              onKeyDown={(e) => onItemKeyDown(e, i)}
            >
              {link.label}
            </Link>
          ))}
          <button
            type="button"
            role="menuitem"
            className="user-menu-item user-menu-item-danger"
            ref={(el) => (itemRefs.current[links.length] = el)}
            onClick={() => {
              close(false);
              onSignOut();
            }}
            onKeyDown={(e) => onItemKeyDown(e, links.length)}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}
