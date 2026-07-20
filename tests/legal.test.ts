// Legal / trust page scaffold — content sanity checks. These guard the two
// things that matter for a DRAFT scaffold: every document is unmistakably marked
// as draft/pending-counsel, and the (factual) sub-processor register lists the
// six real vendors. Pure data assertions — no DB, no rendering.
import { describe, expect, it } from 'vitest';
import {
  DRAFT_BANNER,
  LEGAL_DOCS,
  SUBPROCESSORS,
  termsDoc,
  privacyDoc,
  dpaDoc,
  subprocessorsDoc,
  type LegalDoc,
} from '../src/pages/legal/content';

const allDocs: LegalDoc[] = [termsDoc, privacyDoc, dpaDoc, subprocessorsDoc];

describe('legal documents (draft scaffold)', () => {
  it('the DRAFT banner names it as a template pending counsel', () => {
    expect(DRAFT_BANNER.toLowerCase()).toContain('draft');
    expect(DRAFT_BANNER.toLowerCase()).toContain('legal counsel');
  });

  it('the registry exposes all four documents by slug', () => {
    expect(Object.keys(LEGAL_DOCS).sort()).toEqual(['dpa', 'privacy', 'subprocessors', 'terms']);
    for (const slug of Object.keys(LEGAL_DOCS) as LegalDoc['slug'][]) {
      expect(LEGAL_DOCS[slug].slug).toBe(slug);
    }
  });

  it.each(allDocs.map((d) => [d.title, d] as const))(
    '%s has a title and non-empty sections, each with body text',
    (_title, doc) => {
      expect(doc.title.length).toBeGreaterThan(0);
      expect(doc.sections.length).toBeGreaterThan(0);
      for (const section of doc.sections) {
        expect(section.heading.length).toBeGreaterThan(0);
        expect(section.body.length).toBeGreaterThan(0);
        expect(section.body.every((p) => p.trim().length > 0)).toBe(true);
      }
    },
  );

  it('every document routes counsel to the spots needing real decisions', () => {
    // Terms, Privacy, and the DPA carry explicit counsel-todo markers; the
    // sub-processor doc leans on its factual table, so it need not.
    for (const doc of [termsDoc, privacyDoc, dpaDoc]) {
      const text = doc.sections.flatMap((s) => s.body).join('\n');
      expect(text).toContain('[to be completed by counsel]');
    }
  });
});

describe('sub-processor register (factual)', () => {
  it('lists the six real vendors', () => {
    const names = SUBPROCESSORS.map((s) => s.name).sort();
    expect(names).toEqual(['Anthropic', 'Clerk', 'Render', 'Stripe', 'Supabase', 'Vercel']);
  });

  it('gives every vendor a purpose, data category, and region', () => {
    expect(SUBPROCESSORS.length).toBe(6);
    for (const sp of SUBPROCESSORS) {
      expect(sp.purpose.trim().length).toBeGreaterThan(0);
      expect(sp.dataCategory.trim().length).toBeGreaterThan(0);
      expect(sp.region.trim().length).toBeGreaterThan(0);
    }
  });

  it('keeps the AI vendor labeled narrative-only (never scores, never trains)', () => {
    const anthropic = SUBPROCESSORS.find((s) => s.name === 'Anthropic');
    expect(anthropic?.dataCategory.toLowerCase()).toContain('never');
  });
});
