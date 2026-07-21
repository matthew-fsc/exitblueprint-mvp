// Fixed-window rate limiter for the unauthenticated webhook endpoints
// (server/http.ts; docs/24 item D2). Pure, dependency-free, and trivially
// unit-testable — an in-memory Map keyed by a caller identifier. Not scoring,
// not narrative: just transport hygiene, so no LLM is involved (CLAUDE.md rules
// 1 & 2 are about scores/narrative and don't apply here).
//
// The clock is INJECTABLE (defaults to Date.now). We recently shipped a
// time-drift test bug from reading the wall clock inside the unit under test;
// keeping `now` an argument makes window/reset behaviour deterministic in tests.
//
// Semantics: each key gets a rolling fixed window of `windowMs`. The first
// request opens the window; up to `limit` requests are allowed within it; the
// (limit+1)th is denied until the window elapses, after which it resets.
// Expired windows are evicted lazily when a key is next seen, plus an
// opportunistic sweep so a flood of one-off keys can't grow the Map unbounded.

export interface RateLimiterOptions {
  limit: number; // max allowed requests per window (must be > 0)
  windowMs: number; // window length in milliseconds
  now?: () => number; // injectable clock; defaults to () => Date.now()
}

export interface RateLimitResult {
  allowed: boolean; // false once the window's limit is exceeded
  retryAfterSec: number; // whole seconds until the window resets (0 when allowed)
}

export interface RateLimiter {
  check(key: string): RateLimitResult;
}

interface Window {
  start: number; // clock value when this window opened
  count: number; // requests counted in this window so far
}

// Beyond this many tracked keys, sweep expired windows before adding a new one.
// Bounds memory for a flood of distinct source IPs without paying the sweep on
// the common (few-callers) path.
const SWEEP_THRESHOLD = 10_000;

export function createRateLimiter(options: RateLimiterOptions): RateLimiter {
  const { limit, windowMs } = options;
  const now = options.now ?? (() => Date.now());
  const windows = new Map<string, Window>();

  function sweep(t: number): void {
    for (const [k, w] of windows) {
      if (t - w.start >= windowMs) windows.delete(k);
    }
  }

  function check(key: string): RateLimitResult {
    const t = now();
    let w = windows.get(key);
    // No open window, or the previous one has elapsed → open a fresh window.
    if (!w || t - w.start >= windowMs) {
      if (windows.size >= SWEEP_THRESHOLD) sweep(t);
      w = { start: t, count: 0 };
      windows.set(key, w);
    }
    if (w.count >= limit) {
      // At least 1s so a denied caller always gets a meaningful Retry-After.
      const retryAfterSec = Math.max(1, Math.ceil((w.start + windowMs - t) / 1000));
      return { allowed: false, retryAfterSec };
    }
    w.count += 1;
    return { allowed: true, retryAfterSec: 0 };
  }

  return { check };
}
