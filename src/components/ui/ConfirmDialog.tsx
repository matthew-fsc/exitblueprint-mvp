import { useEffect, useRef, type ReactNode } from 'react';

// A focused confirm modal for destructive or consequential actions (e.g.
// supersede, finalize). Escape and backdrop click cancel. Focus is moved into
// the dialog on open, trapped while open (Tab cycles within it), and restored
// to the triggering element on close — the dialog contract a keyboard or
// screen-reader user expects (WCAG 2.4.3).
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // remember where focus was so we can return it when the dialog closes
    const previouslyFocused = document.activeElement as HTMLElement | null;
    // default focus to Cancel — the safe choice for a destructive prompt
    cancelRef.current?.focus();

    const focusable = () =>
      Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? [],
      );

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      // wrap focus at the ends so Tab never escapes the dialog
      if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (!dialogRef.current?.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      previouslyFocused?.focus?.();
    };
  }, [open, onCancel]);

  if (!open) return null;
  return (
    <div className="ui-modal-backdrop" onClick={onCancel} role="presentation">
      <div
        ref={dialogRef}
        className="ui-modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
      >
        <h3>{title}</h3>
        {children && <div className="ui-modal-body">{children}</div>}
        <div className="ui-modal-actions">
          <button ref={cancelRef} className="btn-ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button className={danger ? 'btn-danger' : undefined} onClick={onConfirm} disabled={busy}>
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
