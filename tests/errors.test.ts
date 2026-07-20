import { describe, expect, it } from 'vitest';
import { describeError, errorMessage } from '../src/lib/errors';

describe('errorMessage', () => {
  it('extracts a message from strings, Errors, and PostgREST-shaped objects', () => {
    expect(errorMessage('boom')).toBe('boom');
    expect(errorMessage(new Error('nope'))).toBe('nope');
    expect(errorMessage({ message: 'permission denied for table gaps' })).toBe(
      'permission denied for table gaps',
    );
    expect(errorMessage(null)).toBe('');
  });
});

describe('describeError', () => {
  it('flags an RLS/permission denial as an authorization problem with the config hint', () => {
    const d = describeError(new Error('permission denied for table engagements'));
    expect(d.kind).toBe('permission');
    expect(d.hint).toMatch(/role: authenticated/);
    expect(d.hint).toMatch(/docs\/30/);
  });

  it('reads a raw PostgREST permission code (42501)', () => {
    const d = describeError({ code: '42501', message: 'permission denied' });
    expect(d.kind).toBe('permission');
  });

  it('treats an expired/invalid JWT as an auth-session problem', () => {
    expect(describeError(new Error('JWT expired')).kind).toBe('auth');
    expect(describeError({ code: 'PGRST301', message: 'jwt error' }).kind).toBe('auth');
  });

  it('treats a fetch failure (any browser) as a retryable network problem', () => {
    for (const msg of ['Failed to fetch', 'NetworkError when attempting to fetch resource', 'Load failed', 'fetch failed']) {
      const d = describeError(new TypeError(msg));
      expect(d.kind, msg).toBe('network');
      expect(d.retryable, msg).toBe(true);
    }
  });

  it('does NOT label a plain coding TypeError as a network problem', () => {
    // A bug like this must surface as a real error, not be disguised as "we
    // couldn't reach the server. Check your connection", which would be wrong
    // and unactionable for the user and hide the bug from us.
    const d = describeError(new TypeError("Cannot read properties of undefined (reading 'id')"));
    expect(d.kind).not.toBe('network');
    expect(d.message).not.toMatch(/couldn’t reach the server/);
  });

  it('maps a 0-row single() result to not-found', () => {
    expect(describeError({ code: 'PGRST116', message: 'Results contain 0 rows' }).kind).toBe(
      'notFound',
    );
  });

  it('passes an unrecognized message through verbatim under a structured frame', () => {
    const d = describeError(new Error('Name is required'));
    expect(d.kind).toBe('unknown');
    expect(d.message).toBe('Name is required');
    expect(d.title).toBe('Something went wrong');
  });
});
