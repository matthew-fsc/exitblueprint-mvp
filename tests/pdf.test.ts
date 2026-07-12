// Chromium resolution for PDF rendering. The renderer must find a browser
// without the caller setting an env var (the earlier bug: it only honored
// EB_CHROMIUM_PATH and otherwise let Playwright hunt for a bundled build that
// isn't installed).
import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { resolveChromium } from '../server/pdf';

describe('resolveChromium', () => {
  it('never throws and returns a string path or undefined', () => {
    let result: string | undefined;
    expect(() => {
      result = resolveChromium();
    }).not.toThrow();
    expect(result === undefined || typeof result === 'string').toBe(true);
  });

  it('honors EB_CHROMIUM_PATH when it points to an existing file', () => {
    const prev = process.env.EB_CHROMIUM_PATH;
    const here = fileURLToPath(import.meta.url); // this test file certainly exists
    process.env.EB_CHROMIUM_PATH = here;
    try {
      expect(resolveChromium()).toBe(here);
    } finally {
      if (prev === undefined) delete process.env.EB_CHROMIUM_PATH;
      else process.env.EB_CHROMIUM_PATH = prev;
    }
  });

  it('ignores EB_CHROMIUM_PATH when the file does not exist', () => {
    const prev = process.env.EB_CHROMIUM_PATH;
    process.env.EB_CHROMIUM_PATH = '/nonexistent/chromium-binary-xyz';
    try {
      // falls through to auto-detection; must not return the bogus path
      expect(resolveChromium()).not.toBe('/nonexistent/chromium-binary-xyz');
    } finally {
      if (prev === undefined) delete process.env.EB_CHROMIUM_PATH;
      else process.env.EB_CHROMIUM_PATH = prev;
    }
  });
});
