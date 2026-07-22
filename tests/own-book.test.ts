// Own-book valuation multiples (docs/09 moat 2) — deterministic aggregation +
// multiple selection. Pure, fixture-style; locks the statistics and the
// versioned-config gate that keeps corpus adoption a NEW valuation_rules_version.
import { describe, expect, it } from 'vitest';
import {
  aggregateOwnBook,
  ownBookConfidence,
  quantile,
  selectValuationMultiple,
  type OwnBookDeal,
} from '../shared/own-book';

const deal = (multiple: number, sizeBand: string | null = '1_3m'): OwnBookDeal => ({ multiple, sizeBand });

describe('quantile', () => {
  it('interpolates linearly between ranks', () => {
    expect(quantile([2, 4, 6, 8], 0.5)).toBe(5);
    expect(quantile([2, 4, 6, 8], 0.25)).toBe(3.5);
    expect(quantile([2, 4, 6, 8], 0.75)).toBe(6.5);
  });
  it('handles singletons and empties', () => {
    expect(quantile([7], 0.5)).toBe(7);
    expect(quantile([], 0.5)).toBe(0);
  });
});

describe('ownBookConfidence', () => {
  it('bands by sample size (firm own-book — lower thresholds)', () => {
    expect(ownBookConfidence(2)).toBe('low');
    expect(ownBookConfidence(4)).toBe('moderate');
    expect(ownBookConfidence(8)).toBe('high');
    expect(ownBookConfidence(20)).toBe('high');
  });
});

describe('aggregateOwnBook', () => {
  it('computes median / p25 / p75 / mean / min / max', () => {
    const r = aggregateOwnBook([deal(4), deal(5), deal(6), deal(8)], '1_3m');
    expect(r).not.toBeNull();
    expect(r!.sample_size).toBe(4);
    expect(r!.median).toBe(5.5);
    expect(r!.p25).toBe(4.75);
    expect(r!.p75).toBe(6.5);
    expect(r!.mean).toBe(5.75);
    expect(r!.min).toBe(4);
    expect(r!.max).toBe(8);
    expect(r!.confidence).toBe('moderate');
  });

  it('counts deals in the subject size band without narrowing the aggregate', () => {
    const r = aggregateOwnBook([deal(4, '1_3m'), deal(5, '3_5m'), deal(6, '1_3m')], '1_3m');
    expect(r!.sample_size).toBe(3); // spans the whole industry
    expect(r!.same_band_count).toBe(2); // two in the subject band
  });

  it('drops non-positive / non-finite multiples', () => {
    const r = aggregateOwnBook([deal(5), deal(0), deal(-2), deal(NaN)], null);
    expect(r!.sample_size).toBe(1);
    expect(r!.median).toBe(5);
  });

  it('returns null when there are no usable deals', () => {
    expect(aggregateOwnBook([], '1_3m')).toBeNull();
    expect(aggregateOwnBook([deal(0), deal(-1)], '1_3m')).toBeNull();
  });
});

describe('selectValuationMultiple', () => {
  const ownBook = aggregateOwnBook([deal(5), deal(5.2), deal(5.4), deal(5.6)], '1_3m')!; // n=4, median 5.3

  it('defaults to the generic table multiple when the corpus is disabled (rule #6)', () => {
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: null, ownBook, config: { enabled: false, minSampleSize: 3 } });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.own_book?.driving).toBe(false); // still shown as context
    expect(r.own_book?.sample_size).toBe(4);
  });

  it('uses the own-book median only when enabled AND the sample clears the floor', () => {
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: null, ownBook, config: { enabled: true, minSampleSize: 3 } });
    expect(r.source).toBe('own_book');
    expect(r.multiple).toBe(ownBook.median);
    expect(r.own_book?.driving).toBe(true);
  });

  it('falls back to the table when the sample is below the floor', () => {
    const thin = aggregateOwnBook([deal(6)], '1_3m')!; // n=1
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: null, ownBook: thin, config: { enabled: true, minSampleSize: 4 } });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.own_book?.driving).toBe(false);
  });

  it('an advisor override always wins, corpus enabled or not', () => {
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: 6.1, ownBook, config: { enabled: true, minSampleSize: 3 } });
    expect(r.source).toBe('override');
    expect(r.multiple).toBe(6.1);
    expect(r.own_book?.driving).toBe(false);
  });

  it('handles no own-book data at all', () => {
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: true, minSampleSize: 3 } });
    expect(r.source).toBe('table');
    expect(r.own_book).toBeNull();
  });
});
