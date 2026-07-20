import type { ReactNode } from 'react';
import { describeError } from '../../lib/errors';

// Canonical error surface. Pages never render a raw error string; they render an
// ErrorState, which runs a thrown value through describeError() so the user sees
// a structured, human message (with an actionable hint when we have one) instead
// of a Postgres/PostgREST dump (docs/26 §Loading & error states).
//
// Variants mirror LoadingState:
//   - page:    full-surface, for a route/gate that failed outright.
//   - section: a bordered card standing in for a block of content.
//   - inline:  a compact one-line message (replaces bare <p class="form-error">),
//              for a validation/action error next to a form or button.
export type ErrorVariant = 'page' | 'section' | 'inline';

export function ErrorState({
  error,
  title,
  message,
  hint,
  variant = 'section',
  onRetry,
  retryLabel = 'Try again',
  className = '',
}: {
  // A thrown value to describe. Optional if title+message are given directly.
  error?: unknown;
  title?: string;
  message?: ReactNode;
  hint?: ReactNode;
  variant?: ErrorVariant;
  onRetry?: () => void;
  retryLabel?: string;
  className?: string;
}) {
  const described = error !== undefined ? describeError(error) : null;
  const resolvedTitle = title ?? described?.title ?? 'Something went wrong';
  const resolvedMessage = message ?? described?.message ?? 'Please try again.';
  const resolvedHint = hint ?? described?.hint;

  if (variant === 'inline') {
    return (
      <p className={`inline-error ${className}`.trim()} role="alert">
        <WarningGlyph />
        <span>{resolvedMessage}</span>
        {onRetry && (
          <button type="button" className="inline-error-retry" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
      </p>
    );
  }

  return (
    <div className={`error-state error-state-${variant} ${className}`.trim()} role="alert">
      <span className="error-state-icon" aria-hidden>
        <WarningGlyph size={26} />
      </span>
      <span className="error-state-title">{resolvedTitle}</span>
      <p className="error-state-body">{resolvedMessage}</p>
      {resolvedHint && <p className="error-state-hint">{resolvedHint}</p>}
      {onRetry && (
        <button type="button" className="error-state-retry" onClick={onRetry}>
          {retryLabel}
        </button>
      )}
    </div>
  );
}

function WarningGlyph({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M12 4l9 16H3z" />
      <path d="M12 10v4" />
      <path d="M12 17.5v.5" />
    </svg>
  );
}
