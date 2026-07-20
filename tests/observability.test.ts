// Observability seam (server/observability.ts). Covers the shipped default —
// DISABLED with no SENTRY_DSN — plus the pure helpers (scrubbing, request log).
// No real DSN, no network: we never capture while the Sentry sink is active, so
// nothing is ever sent anywhere.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  captureError,
  captureMessage,
  initObservability,
  isObservabilityEnabled,
  logRequest,
  scrubContext,
} from '../server/observability';

// Start every test from the disabled (default) state.
beforeEach(() => {
  initObservability({} as NodeJS.ProcessEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initObservability', () => {
  it('is disabled with no SENTRY_DSN and logs a single disabled line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    initObservability({} as NodeJS.ProcessEnv);
    expect(isObservabilityEnabled()).toBe(false);
    expect(log).toHaveBeenCalledWith('observability: disabled (no SENTRY_DSN)');
  });

  it('enables the sentry sink when a DSN is present (no event captured here)', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    initObservability({
      SENTRY_DSN: 'https://examplePublicKey@o0.ingest.sentry.io/0',
      SENTRY_ENVIRONMENT: 'test',
    } as unknown as NodeJS.ProcessEnv);
    expect(isObservabilityEnabled()).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining('observability: enabled'));
    // Reset back to the console-only sink so no later capture could reach Sentry.
    initObservability({} as NodeJS.ProcessEnv);
    expect(isObservabilityEnabled()).toBe(false);
  });
});

describe('captureError (disabled / console-only)', () => {
  it('does not throw and emits one structured JSON error line', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => captureError(new Error('boom'), { route: '/functions/v1/x', firmId: 'firm_1' })).not.toThrow();
    expect(err).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.level).toBe('error');
    expect(parsed.msg).toBe('captured_error');
    expect(parsed.error).toEqual({ name: 'Error', message: 'boom' });
    expect(parsed.route).toBe('/functions/v1/x');
    expect(parsed.firmId).toBe('firm_1');
  });

  it('tolerates non-Error thrown values', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => captureError('a string blew up')).not.toThrow();
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.error.message).toBe('a string blew up');
  });

  it('scrubs sensitive keys out of the logged context', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    captureError(new Error('x'), {
      route: '/webhooks/clerk',
      firmId: 'firm_2',
      authorization: 'Bearer sk_live_secret',
      jwt: 'ey.some.token',
      body: { ssn: '000-00-0000' },
    });
    const parsed = JSON.parse(err.mock.calls[0][0] as string);
    expect(parsed.route).toBe('/webhooks/clerk');
    expect(parsed.firmId).toBe('firm_2');
    expect(parsed.authorization).toBeUndefined();
    expect(parsed.jwt).toBeUndefined();
    expect(parsed.body).toBeUndefined();
  });
});

describe('captureMessage (disabled / console-only)', () => {
  it('does not throw and emits a structured line at the given level', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(() => captureMessage('service booted', 'info', { fn: 'startup' })).not.toThrow();
    const parsed = JSON.parse(log.mock.calls.at(-1)![0] as string);
    expect(parsed.level).toBe('info');
    expect(parsed.msg).toBe('captured_message');
    expect(parsed.message).toBe('service booted');
    expect(parsed.fn).toBe('startup');
  });
});

describe('logRequest', () => {
  it('emits a single parseable JSON access-log line', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    logRequest({ method: 'POST', path: '/functions/v1/score', status: 200, ms: 12.7 });
    expect(log).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(log.mock.calls[0][0] as string);
    expect(parsed.msg).toBe('request');
    expect(parsed.method).toBe('POST');
    expect(parsed.path).toBe('/functions/v1/score');
    expect(parsed.status).toBe(200);
    expect(parsed.ms).toBe(13); // rounded
    expect(typeof parsed.t).toBe('string');
  });
});

describe('scrubContext', () => {
  it('keeps allowed scalar ids and drops sensitive keys', () => {
    const out = scrubContext({
      route: '/x',
      firmId: 'f1',
      status: 500,
      token: 'secret',
      password: 'hunter2',
      apiKey: 'k',
      cookie: 'sid=1',
    });
    expect(out).toEqual({ route: '/x', firmId: 'f1', status: 500 });
  });

  it('drops non-scalar values (arrays / nested objects that could carry a body)', () => {
    const out = scrubContext({ route: '/x', extra: { nested: 1 }, list: [1, 2, 3] });
    expect(out).toEqual({ route: '/x' });
  });

  it('returns undefined for empty or missing context', () => {
    expect(scrubContext(undefined)).toBeUndefined();
    expect(scrubContext({})).toBeUndefined();
    expect(scrubContext({ token: 'x' })).toBeUndefined();
  });

  it('caps long strings', () => {
    const long = 'a'.repeat(500);
    const out = scrubContext({ route: long });
    expect((out!.route as string).length).toBeLessThanOrEqual(201);
  });
});
