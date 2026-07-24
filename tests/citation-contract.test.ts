// Citation contract post-check (docs/sellside-ai/01, "The citation contract").
// Pure, hermetic (no DB): the source-score guard that verifies every MARKET
// numeral in a deliverable is rendered adjacent to its passage's citation.
import { describe, expect, it } from 'vitest';
import { citationPostCheck } from '../server/narrative';

describe('citationPostCheck', () => {
  const marketContext = {
    passages: [
      { cite_id: 'PLACE-FS-01', body: 'Precedent transactions closed at 5.2x LTM EBITDA (n=14).' },
    ],
  };

  it('passes when a market numeral shares its line with the passage cite_id', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA [PLACE-FS-01].';
    expect(citationPostCheck(md, marketContext)).toEqual([]);
  });

  it('flags a market numeral stated without its cite_id on that line', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA.';
    expect(citationPostCheck(md, marketContext)).toEqual([
      'market figure 5.2 stated without its [PLACE-FS-01] citation',
    ]);
  });

  it('does not police numerals that are not from any passage (years, payload figures)', () => {
    // 2024 (a year) and 72.25 (a payload score) appear in no passage body.
    const md = 'Since 2024 your score of 72.25 has held steady.';
    expect(citationPostCheck(md, marketContext)).toEqual([]);
  });

  it('returns no violations when there is no market context to police', () => {
    const md = 'Comparable deals cleared 5.2x LTM EBITDA.';
    expect(citationPostCheck(md, { passages: [] })).toEqual([]);
  });
});
