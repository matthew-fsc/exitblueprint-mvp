import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  consumeSignoutReason,
  markSignoutReason,
  notifySessionExpired,
  registerSessionExpiredHandler,
} from '../src/lib/sessionExpiry';

// A minimal sessionStorage stand-in for the jsdom-free unit env.
beforeEach(() => {
  const store = new Map<string, string>();
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.useFakeTimers();
});

afterEach(() => {
  // Flush the module's re-arm timer so the `notifying` guard resets between
  // tests (it's module-level state, shared across cases in this file).
  vi.runOnlyPendingTimers();
  registerSessionExpiredHandler(null);
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('session expiry bridge', () => {
  it('invokes the registered handler and marks the reason as expired', () => {
    const handler = vi.fn();
    registerSessionExpiredHandler(handler);

    notifySessionExpired();

    expect(handler).toHaveBeenCalledTimes(1);
    expect(consumeSignoutReason()).toBe('expired');
  });

  it('is a no-op when no handler is registered', () => {
    expect(() => notifySessionExpired()).not.toThrow();
  });

  it('collapses a storm of concurrent expiries into a single sign-out', () => {
    const handler = vi.fn();
    registerSessionExpiredHandler(handler);

    // Several in-flight queries fail at once on a dropped token.
    notifySessionExpired();
    notifySessionExpired();
    notifySessionExpired();

    expect(handler).toHaveBeenCalledTimes(1);

    // Re-arms after the propagation window so a genuinely later expiry is handled.
    vi.advanceTimersByTime(2000);
    notifySessionExpired();
    expect(handler).toHaveBeenCalledTimes(2);
  });
});

describe('signout reason', () => {
  it('is one-shot: read clears it so a refresh does not keep showing it', () => {
    markSignoutReason('idle');
    expect(consumeSignoutReason()).toBe('idle');
    expect(consumeSignoutReason()).toBeNull();
  });
});
