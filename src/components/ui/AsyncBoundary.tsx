import type { ReactNode } from 'react';
import type { UseQueryResult } from '@tanstack/react-query';
import { describeError } from '../../lib/errors';
import { LoadingState } from './LoadingState';
import { ErrorState } from './ErrorState';

// A boundary stands in for a whole surface or block, so only the full-size
// variants apply (never the one-line inline form).
type BoundaryVariant = 'page' | 'section';

// Maps a TanStack Query result to the three canonical states so a page never
// hand-writes the loading/error/empty ladder (docs/26 §Loading & error states):
//
//   <AsyncBoundary query={engagementQ} variant="page">
//     {(engagement) => <EngagementView engagement={engagement} />}
//   </AsyncBoundary>
//
// - pending (and no data yet) → LoadingState
// - error                     → ErrorState (with a retry wired to refetch)
// - resolved                  → children(data); if isEmpty(data), render `empty`
//
// `variant` sizes the default loading/error surfaces; pass `loading`/`empty`
// nodes to override either. Data tables keep using <DataTable>'s built-in states.
export function AsyncBoundary<T>({
  query,
  children,
  variant = 'section',
  loading,
  loadingLabel,
  loadingLines,
  isEmpty,
  empty,
  onRetry,
}: {
  query: UseQueryResult<T>;
  children: (data: T) => ReactNode;
  variant?: BoundaryVariant;
  loading?: ReactNode;
  loadingLabel?: string;
  loadingLines?: number;
  isEmpty?: (data: T) => boolean;
  empty?: ReactNode;
  onRetry?: () => void;
}): ReactNode {
  // `isPending` (TanStack v5) is exactly "no data yet", covering first load and a
  // hard refetch with no cached value — show the loader.
  if (query.isPending) {
    return loading ?? <LoadingState variant={variant} label={loadingLabel} lines={loadingLines} />;
  }
  // Errored with nothing cached to fall back to — show the error. Only wire a
  // refetch retry when a retry could actually succeed: a non-retryable error
  // (e.g. an expired session) would just re-fail with the same dead token, so we
  // leave onRetry off and let ErrorState offer the right action (e.g. "Sign in
  // again") instead of a retry-of-death.
  if (query.isError) {
    const retryable = describeError(query.error).retryable;
    return (
      <ErrorState
        error={query.error}
        variant={variant}
        onRetry={onRetry ?? (retryable ? () => void query.refetch() : undefined)}
      />
    );
  }
  const data = query.data;
  if (isEmpty?.(data)) return empty ?? null;
  return children(data);
}
