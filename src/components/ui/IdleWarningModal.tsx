import { useEffect, useRef } from 'react';

// The warning shown shortly before an inactive session is signed out (the
// vendor-DD "automatic shutdown of inactive sessions" control, src/lib/auth.tsx).
// An institutional app never yanks a user to /login mid-task with no notice — it
// warns, counts down, and offers a one-click "stay". Reuses the shared .ui-modal
// surface so it matches ConfirmDialog. Rendered as an alertdialog because it
// interrupts to demand attention.
export function IdleWarningModal({
  open,
  secondsLeft,
  onStay,
  onSignOut,
}: {
  open: boolean;
  secondsLeft: number;
  onStay: () => void;
  onSignOut: () => void;
}) {
  const stayRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (open) stayRef.current?.focus();
  }, [open]);

  if (!open) return null;

  return (
    <div className="ui-modal-backdrop" role="presentation">
      <div
        className="ui-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="idle-warning-title"
        aria-describedby="idle-warning-body"
      >
        <h3 id="idle-warning-title">Still there?</h3>
        <div className="ui-modal-body" id="idle-warning-body">
          To protect your workspace, you’ll be signed out in{' '}
          {/* Tabular numerals so the countdown doesn't jitter in width as it ticks. */}
          <strong style={{ fontFeatureSettings: 'var(--num)' }}>{secondsLeft}s</strong> unless you
          continue.
        </div>
        <div className="ui-modal-actions">
          <button type="button" className="btn-ghost" onClick={onSignOut}>
            Sign out now
          </button>
          <button ref={stayRef} type="button" onClick={onStay}>
            Stay signed in
          </button>
        </div>
      </div>
    </div>
  );
}
