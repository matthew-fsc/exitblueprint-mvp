import { describe, expect, it } from 'vitest';
import { parseHex, darken, readableOn, accentVars } from '../src/lib/color';

describe('parseHex', () => {
  it('parses #rrggbb and #rgb', () => {
    expect(parseHex('#1f7a52')).toEqual([31, 122, 82]);
    expect(parseHex('#fff')).toEqual([255, 255, 255]);
    expect(parseHex('  #1F7A52 ')).toEqual([31, 122, 82]);
  });
  it('returns null for unparseable input', () => {
    expect(parseHex('nope')).toBeNull();
    expect(parseHex('#12')).toBeNull();
    expect(parseHex('rgb(1,2,3)')).toBeNull();
    expect(parseHex('')).toBeNull();
  });
});

describe('darken', () => {
  it('moves a color toward black by the given fraction', () => {
    expect(darken('#ffffff', 0.2)).toBe('#cccccc');
    expect(darken('#1f7a52', 0.2)).toBe('#196242');
  });
  it('returns null for invalid hex', () => {
    expect(darken('not-a-color')).toBeNull();
  });
});

describe('readableOn — best-effort AA foreground', () => {
  it('picks white on a dark accent', () => {
    expect(readableOn('#1f7a52')).toBe('#ffffff'); // light-theme forest accent
  });
  it('picks a dark ink on a light/bright accent', () => {
    // dark-theme accent #4bb888 fails white-text AA (2.47:1); dark ink passes.
    expect(readableOn('#4bb888')).toBe('#14251d');
    expect(readableOn('#ffcc00')).toBe('#14251d');
  });
});

describe('accentVars — the coherent white-label set', () => {
  it('derives accent, accent-strong and the button surface from one hex', () => {
    expect(accentVars('#1f7a52')).toEqual({
      '--accent': '#1f7a52',
      '--accent-strong': '#196242',
      '--btn-bg': '#1f7a52',
      '--btn-bg-hover': '#196242',
      '--btn-fg': '#ffffff',
    });
  });
  it('falls back to null (keep defaults) for missing or invalid input', () => {
    expect(accentVars(null)).toBeNull();
    expect(accentVars(undefined)).toBeNull();
    expect(accentVars('')).toBeNull();
    expect(accentVars('teal')).toBeNull();
  });
});
