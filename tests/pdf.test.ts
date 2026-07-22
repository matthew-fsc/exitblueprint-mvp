// Chromium resolution for PDF rendering. The renderer must find a browser
// without the caller setting an env var (the earlier bug: it only honored
// EB_CHROMIUM_PATH and otherwise let Playwright hunt for a bundled build that
// isn't installed).
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveChromium, renderTeaserHtml, renderManagementPresentationHtml } from '../server/pdf';

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

  // A locally `npx playwright install`ed browser must be found regardless of the
  // host OS's on-disk layout (the earlier bug: only chrome-linux was checked, so
  // PDF export failed in `npm run dev` on a Mac/Windows workstation).
  describe('finds a browser in a Playwright cache (cross-platform layouts)', () => {
    let dir: string;
    const prevBase = process.env.PLAYWRIGHT_BROWSERS_PATH;
    const prevEnvPath = process.env.EB_CHROMIUM_PATH;

    afterEach(() => {
      if (dir) rmSync(dir, { recursive: true, force: true });
      if (prevBase === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = prevBase;
      if (prevEnvPath === undefined) delete process.env.EB_CHROMIUM_PATH;
      else process.env.EB_CHROMIUM_PATH = prevEnvPath;
    });

    for (const rel of [
      ['chrome-linux', 'chrome'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
      ['chrome-win', 'chrome.exe'],
    ]) {
      it(`resolves the ${rel[0]} layout`, () => {
        delete process.env.EB_CHROMIUM_PATH;
        dir = mkdtempSync(join(tmpdir(), 'pw-cache-'));
        process.env.PLAYWRIGHT_BROWSERS_PATH = dir;
        const binDir = join(dir, 'chromium-1234', ...rel.slice(0, -1));
        mkdirSync(binDir, { recursive: true });
        const binPath = join(binDir, rel[rel.length - 1]);
        writeFileSync(binPath, '');
        expect(resolveChromium()).toBe(binPath);
      });
    }
  });
});

// The two sell-side document covers differ on one load-bearing point: the teaser
// is a blind profile (no company name), the management presentation is post-NDA
// material (names the company). These HTML builders are pure — no Chromium — so
// we assert that invariant directly on the generated markup.
describe('sell-side document HTML', () => {
  const branding = null;
  const narrative = '## The Opportunity\n\nA services business.';

  it('teaser cover withholds the company name (blind profile)', () => {
    const html = renderTeaserHtml(
      { industry: 'Industrial services', state: 'Ohio', date: '2026-07-21' },
      narrative,
      branding,
    );
    expect(html).toContain('Confidential Teaser');
    expect(html).toContain('Industrial services');
    // Anonymized: the descriptor is industry-based, never a company name.
    expect(html).not.toContain('Northwind');
  });

  it('management presentation cover names the company (post-NDA)', () => {
    const html = renderManagementPresentationHtml(
      { companyName: 'Northwind Fabrication', industry: 'Industrial services', date: '2026-07-21' },
      narrative,
      branding,
    );
    expect(html).toContain('Management Presentation');
    expect(html).toContain('Northwind Fabrication');
  });
});
