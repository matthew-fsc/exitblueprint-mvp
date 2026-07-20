import { describe, expect, it } from 'vitest';
import { parseAllowedOrigins, resolveCorsOrigin } from '../server/cors';

describe('parseAllowedOrigins', () => {
  it('defaults to allow-any when unset or empty', () => {
    expect(parseAllowedOrigins(undefined)).toEqual(['*']);
    expect(parseAllowedOrigins('')).toEqual(['*']);
    expect(parseAllowedOrigins('   ')).toEqual(['*']);
  });

  it('splits a comma-separated list and trims whitespace', () => {
    expect(parseAllowedOrigins('https://exitblueprint.net, https://www.exitblueprint.net')).toEqual([
      'https://exitblueprint.net',
      'https://www.exitblueprint.net',
    ]);
  });

  it('keeps a single origin as a one-element list', () => {
    expect(parseAllowedOrigins('https://exitblueprint.net')).toEqual(['https://exitblueprint.net']);
  });
});

describe('resolveCorsOrigin', () => {
  it('returns * when any origin is allowed', () => {
    expect(resolveCorsOrigin(['*'], 'https://exitblueprint.net')).toBe('*');
    expect(resolveCorsOrigin([], 'https://exitblueprint.net')).toBe('*');
  });

  // The bug this whole change fixes: with more than one allowed origin the old
  // code emitted the comma-joined string verbatim as Access-Control-Allow-Origin,
  // which is an invalid header the browser rejects — so every function call from
  // the app failed as "we couldn't reach the server". A per-request single origin
  // must come back instead.
  it('echoes the request Origin when it is in a multi-origin allowlist', () => {
    const allowed = ['https://exitblueprint.net', 'https://www.exitblueprint.net'];
    expect(resolveCorsOrigin(allowed, 'https://exitblueprint.net')).toBe('https://exitblueprint.net');
    expect(resolveCorsOrigin(allowed, 'https://www.exitblueprint.net')).toBe(
      'https://www.exitblueprint.net',
    );
    // Never the comma-joined list.
    expect(resolveCorsOrigin(allowed, 'https://exitblueprint.net')).not.toContain(',');
  });

  it('falls back to the first configured origin for a non-listed / missing Origin', () => {
    const allowed = ['https://exitblueprint.net', 'https://www.exitblueprint.net'];
    expect(resolveCorsOrigin(allowed, 'https://evil.example.com')).toBe('https://exitblueprint.net');
    expect(resolveCorsOrigin(allowed, undefined)).toBe('https://exitblueprint.net');
  });
});
