// Fixed-window rate limiter (server/ratelimit.ts). The clock is injected so the
// window/reset behaviour is deterministic — no real time passes in these tests.
import { describe, expect, it } from 'vitest';
import { createRateLimiter } from '../server/ratelimit';

describe('createRateLimiter', () => {
  it('allows requests up to the limit within a window', () => {
    const rl = createRateLimiter({ limit: 3, windowMs: 1000, now: () => 0 });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    const third = rl.check('a');
    expect(third.allowed).toBe(true);
    expect(third.retryAfterSec).toBe(0);
  });

  it('blocks requests over the limit and reports Retry-After', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 2, windowMs: 1000, now: () => t });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(true);
    // 300ms into the window, the 3rd request is denied; 700ms remain → 1s.
    t = 300;
    const denied = rl.check('a');
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSec).toBe(1);
  });

  it('resets after the window elapses (using the injectable clock)', () => {
    let t = 0;
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => t });
    expect(rl.check('a').allowed).toBe(true);
    expect(rl.check('a').allowed).toBe(false);
    // Advance past the window boundary → a fresh window opens.
    t = 1000;
    expect(rl.check('a').allowed).toBe(true);
    // ...and the new window enforces the limit again.
    expect(rl.check('a').allowed).toBe(false);
  });

  it('isolates keys from each other', () => {
    const rl = createRateLimiter({ limit: 1, windowMs: 1000, now: () => 0 });
    expect(rl.check('a').allowed).toBe(true);
    // 'a' is now exhausted, but 'b' has its own independent window.
    expect(rl.check('a').allowed).toBe(false);
    expect(rl.check('b').allowed).toBe(true);
    expect(rl.check('b').allowed).toBe(false);
  });
});
