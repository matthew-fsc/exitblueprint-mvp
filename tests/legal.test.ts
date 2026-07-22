// Legal / trust page content checks. These guard what matters for the beta
// terms: the pages read as real (not a scaffold), the protective clauses are
// present, the only placeholders are the six centralized business facts, and the
// (factual) sub-processor register lists the six real vendors. Pure data
// assertions — no DB, no rendering.
import { describe, expect, it } from 'vitest';
import {
  BETA_NOTICE,
  FILL,
  COUNSEL_REVIEW_ITEMS,
  LEGAL_DOCS,
  SUBPROCESSORS,
  termsDoc,
  privacyDoc,
  dpaDoc,
  subprocessorsDoc,
  type LegalDoc,
} from '../src/pages/legal/content';

const allDocs: LegalDoc[] = [termsDoc, privacyDoc, dpaDoc, subprocessorsDoc];
const bodyText = (doc: LegalDoc) => doc.sections.flatMap((s) => s.body).join('\n');

describe('legal documents (beta terms)', () => {
  it('the beta notice frames these as beta terms and states the no-advice disclaimer', () => {
    const text = [BETA_NOTICE.title, ...BETA_NOTICE.points].join('\n').toLowerCase();
    expect(text).toContain('beta');
    expect(text).toContain('not financial, legal, tax'); // the professional-advice disclaimer
    expect(BETA_NOTICE.points.length).toBeGreaterThan(0);
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

  it('carries no leftover scaffold placeholder in user-facing text', () => {
    // The old "[to be completed by counsel]" markers are gone; the only
    // placeholders that render are the six centralized business facts (FILL).
    for (const doc of allDocs) {
      expect(bodyText(doc)).not.toContain('[to be completed by counsel]');
    }
  });

  it('Terms carry the protective clauses (as-is, no advice, liability cap, indemnity)', () => {
    const text = bodyText(termsDoc).toLowerCase();
    expect(text).toContain('"as is"');
    expect(text).toContain('financial, legal, tax'); // the professional-advice disclaimer
    expect(text).toContain('total aggregate liability');
    expect(text).toContain('indemnif');
    // The advisor firm warrants it has the right/consent to upload client data.
    expect(text).toContain('rights, consents, and authority');
    expect(termsDoc.sections.some((s) => s.heading === 'Limitation of liability')).toBe(true);
  });

  it('the six business facts are centralized in FILL and referenced in the docs', () => {
    expect(Object.keys(FILL).sort()).toEqual(
      ['address', 'contactEmail', 'effectiveDate', 'entity', 'governingLaw', 'venue'].sort(),
    );
    for (const v of Object.values(FILL)) expect(v.trim().length).toBeGreaterThan(0);
    // Business facts actually appear in the rendered text.
    expect(bodyText(termsDoc)).toContain(FILL.governingLaw);
    expect(bodyText(privacyDoc)).toContain(FILL.contactEmail);
    expect(termsDoc.lastUpdated).toBe(FILL.effectiveDate);
  });

  it('provides a counsel-review checklist (not shown to users)', () => {
    expect(COUNSEL_REVIEW_ITEMS.length).toBeGreaterThan(0);
    expect(COUNSEL_REVIEW_ITEMS.every((s) => s.trim().length > 0)).toBe(true);
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
