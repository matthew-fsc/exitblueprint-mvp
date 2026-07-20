// One place that turns a raw thrown value (a Supabase/PostgREST error, a server
// function's message, a network failure, or anything else) into a small,
// structured, human-readable shape the UI can render consistently. Pages must
// never show a raw Postgres string to a user; they render an ErrorState, which
// runs the value through here first.
//
// Reads work off the error *message* because the data layer (src/lib/queries.ts)
// rethrows `new Error(error.message)`, so the PostgREST `code`/`status` are gone
// by the time a component sees it. We still parse a raw PostgrestError-like
// object when one is thrown directly, so both paths are covered.

export type ErrorKind = 'auth' | 'permission' | 'network' | 'notFound' | 'unknown';

export interface DescribedError {
  kind: ErrorKind;
  title: string;
  message: string;
  // An actionable next step, when we can name one (e.g. a config pointer).
  hint?: string;
  // Whether a retry could plausibly succeed without the user changing anything.
  retryable: boolean;
}

// Pull a best-effort message string out of anything that might be thrown.
export function errorMessage(err: unknown): string {
  if (err == null) return '';
  if (typeof err === 'string') return err;
  if (err instanceof Error) return err.message;
  if (typeof err === 'object') {
    const o = err as { message?: unknown; error?: unknown; details?: unknown };
    if (typeof o.message === 'string') return o.message;
    if (typeof o.error === 'string') return o.error;
    if (typeof o.details === 'string') return o.details;
  }
  return String(err);
}

// A PostgREST error code, when the raw object (not a rethrown Error) reaches us.
function errorCode(err: unknown): string | undefined {
  if (err && typeof err === 'object') {
    const c = (err as { code?: unknown }).code;
    if (typeof c === 'string') return c;
  }
  return undefined;
}

const has = (haystack: string, ...needles: string[]) =>
  needles.some((n) => haystack.includes(n.toLowerCase()));

// The pointer we surface when a signed-in caller is refused at the data layer.
// The usual cause in production is the Clerk→Supabase link missing the
// `role: authenticated` claim, which makes every `to authenticated` RLS policy
// deny. /health has a live check; docs/30 §2 is the fix.
const AUTH_CONFIG_HINT =
  'If this started right after go-live or affects everything, the Clerk→Supabase ' +
  'auth link is likely missing the `role: authenticated` claim. Open /health to ' +
  'confirm, then see docs/30 §2.';

export function describeError(err: unknown): DescribedError {
  const raw = errorMessage(err).trim();
  const code = errorCode(err);
  const lower = raw.toLowerCase();

  // Network / transport: the request never got a real answer.
  if (
    err instanceof TypeError ||
    has(lower, 'failed to fetch', 'networkerror', 'network request failed', 'load failed', 'fetch failed')
  ) {
    return {
      kind: 'network',
      title: 'Connection problem',
      message: 'We couldn’t reach the server. Check your connection and try again.',
      retryable: true,
    };
  }

  // Expired / invalid session token — the caller is signed in but the JWT is stale.
  if (
    code === 'PGRST301' ||
    has(lower, 'jwt expired', 'token is expired', 'invalid jwt', 'jwt', 'jwserror', 'invalid authentication', 'invalid claim')
  ) {
    return {
      kind: 'auth',
      title: 'Your session expired',
      message: 'Please sign in again to continue.',
      retryable: false,
    };
  }

  // Authorization: signed in, but not allowed to read/write this. Under RLS a
  // pervasive version of this is the auth-config gap above, so we name it.
  if (
    code === '42501' ||
    has(lower, 'permission denied', 'row-level security', 'row level security', 'not authorized', 'forbidden', 'rls')
  ) {
    return {
      kind: 'permission',
      title: 'Not authorized',
      message: 'Your account isn’t authorized to view this.',
      hint: AUTH_CONFIG_HINT,
      retryable: false,
    };
  }

  // Nothing found — a real empty result surfaced as an error (e.g. `.single()`).
  if (code === 'PGRST116' || has(lower, 'results contain 0 rows', 'no rows returned', 'not found')) {
    return {
      kind: 'notFound',
      title: 'Not found',
      message: 'We couldn’t find what you were looking for.',
      retryable: false,
    };
  }

  // Fallback: show the real message (it may be a meaningful server error) but in
  // a structured frame, never as a bare paragraph.
  return {
    kind: 'unknown',
    title: 'Something went wrong',
    message: raw || 'An unexpected error occurred. Please try again.',
    retryable: true,
  };
}
