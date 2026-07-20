import { SkeletonLines } from './Skeleton';

// Canonical loading indicator. Three variants so every surface loads the same
// way instead of ad-hoc "Loading…" text (docs/26 §Loading & error states):
//   - page:    full-surface spinner + label, for a route/gate that has nothing
//              to show yet. Reserves height so the layout doesn't jump.
//   - section: shimmer lines that stand in for content of roughly the right
//              shape (no layout shift on load).
//   - inline:  a small spinner + label, for a spot inside otherwise-loaded UI.
export type LoadingVariant = 'page' | 'section' | 'inline';

export function LoadingState({
  label = 'Loading…',
  variant = 'section',
  lines = 3,
}: {
  label?: string;
  variant?: LoadingVariant;
  lines?: number;
}) {
  if (variant === 'section') {
    return (
      <div className="loading-state loading-state-section" role="status" aria-live="polite">
        <SkeletonLines lines={lines} />
        <span className="sr-only">{label}</span>
      </div>
    );
  }

  return (
    <div className={`loading-state loading-state-${variant}`} role="status" aria-live="polite">
      <Spinner />
      <span className="loading-state-label">{label}</span>
    </div>
  );
}

// A single accessible spinner, currentColor so it inherits context. Honors
// prefers-reduced-motion via CSS.
export function Spinner({ size = 20 }: { size?: number }) {
  return (
    <svg
      className="ui-spinner"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      aria-hidden
    >
      <path d="M12 3a9 9 0 1 0 9 9" />
    </svg>
  );
}
