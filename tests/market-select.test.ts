// Market multiple selection (docs/sellside-ai/01, build order step 1) — locks the
// versioned-config gate that keeps the market lane deterministic and OFF by default,
// and the precedence override > own_book > market > table. Pure, fixture-style.
//
// The DEFAULT-OFF guarantee (CLAUDE.md §1) is the load-bearing case: with no market
// candidate / no marketConfig, selectValuationMultiple must return exactly what it
// returned before market existed, so the valuation fixtures still reproduce.
import { describe, expect, it } from 'vitest';
import {
  aggregateOwnBook,
  selectValuationMultiple,
  type MarketMultiple,
  type OwnBookDeal,
} from '../shared/own-book';

const deal = (multiple: number, sizeBand: string | null = '1_3m'): OwnBookDeal => ({ multiple, sizeBand });
const market: MarketMultiple = { median: 5.9, p25: 5.2, p75: 6.4, sample_size: 14 };

describe('selectValuationMultiple — market lane', () => {
  const ownBook = aggregateOwnBook([deal(5), deal(5.2), deal(5.4), deal(5.6)], '1_3m')!; // n=4, median 5.3

  it('market disabled → identical to the table result today (no marketConfig at all)', () => {
    const r = selectValuationMultiple({ tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: false, minSampleSize: 3 } });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.market).toBeNull();
  });

  it('market present but its config omitted → still table (market shown only as context)', () => {
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: false, minSampleSize: 3 },
      market,
    });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.market?.driving).toBe(false); // attached as context, not driving
    expect(r.market?.sample_size).toBe(14);
  });

  it('market present + config disabled → still table', () => {
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: false, minSampleSize: 3 },
      market, marketConfig: { enabled: false, minSampleSize: 5 },
    });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.market?.driving).toBe(false);
  });

  it('market enabled + sufficient sample + no own-book → source market', () => {
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: true, minSampleSize: 3 },
      market, marketConfig: { enabled: true, minSampleSize: 5 },
    });
    expect(r.source).toBe('market');
    expect(r.multiple).toBe(5.9);
    expect(r.market?.driving).toBe(true);
  });

  it('market enabled but below its sample floor → falls back to table', () => {
    const thin: MarketMultiple = { median: 5.9, p25: 5.2, p75: 6.4, sample_size: 3 };
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: null, ownBook: null, config: { enabled: true, minSampleSize: 3 },
      market: thin, marketConfig: { enabled: true, minSampleSize: 5 },
    });
    expect(r.source).toBe('table');
    expect(r.multiple).toBe(4.5);
    expect(r.market?.driving).toBe(false);
  });

  it('own-book still wins over market when both are enabled + sufficient', () => {
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: null, ownBook, config: { enabled: true, minSampleSize: 3 },
      market, marketConfig: { enabled: true, minSampleSize: 5 },
    });
    expect(r.source).toBe('own_book');
    expect(r.multiple).toBe(ownBook.median);
    expect(r.own_book?.driving).toBe(true);
    expect(r.market?.driving).toBe(false); // market still attached as context
  });

  it('an advisor override still wins over everything', () => {
    const r = selectValuationMultiple({
      tableMultiple: 4.5, override: 6.1, ownBook, config: { enabled: true, minSampleSize: 3 },
      market, marketConfig: { enabled: true, minSampleSize: 5 },
    });
    expect(r.source).toBe('override');
    expect(r.multiple).toBe(6.1);
    expect(r.own_book?.driving).toBe(false);
    expect(r.market?.driving).toBe(false);
  });
});
