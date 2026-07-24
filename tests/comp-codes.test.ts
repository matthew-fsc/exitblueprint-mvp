// Comp-code redemption (server/comp-codes.ts). Pure `compCodeFailure` is tested
// with hand-built rows; `redeemCompCode` runs against an in-memory fake pg client
// (same style as tests/stripe.test.ts) — NO real database, NO network. Proves the
// validity rules, idempotent-per-firm redemption, and that a redeem flips the firm
// to fully-entitled (comp).
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import { compCodeFailure, normalizeCompCode, redeemCompCode, type CompCodeRow } from '../server/comp-codes';

const NOW = Date.parse('2026-07-24T00:00:00Z');

function row(over: Partial<CompCodeRow> = {}): CompCodeRow {
  return {
    code: 'PILOT-2026',
    plan_code: null,
    max_redemptions: null,
    redeemed_count: 0,
    expires_at: null,
    active: true,
    ...over,
  };
}

// ── Pure validity (compCodeFailure) ───────────────────────────────────────────
describe('compCodeFailure', () => {
  it('accepts a live, unlimited, unredeemed code', () => {
    expect(compCodeFailure(row(), false, NOW)).toBeNull();
  });

  it('rejects an unknown code', () => {
    expect(compCodeFailure(null, false, NOW)?.reason).toBe('not_found');
  });

  it('rejects an inactive code', () => {
    expect(compCodeFailure(row({ active: false }), false, NOW)?.reason).toBe('inactive');
  });

  it('rejects an expired code', () => {
    expect(compCodeFailure(row({ expires_at: '2026-01-01T00:00:00Z' }), false, NOW)?.reason).toBe('expired');
  });

  it('rejects a fully-redeemed code for a new firm', () => {
    expect(compCodeFailure(row({ max_redemptions: 5, redeemed_count: 5 }), false, NOW)?.reason).toBe('exhausted');
  });

  it('lets a firm that already redeemed re-apply an exhausted or expired code', () => {
    expect(compCodeFailure(row({ max_redemptions: 5, redeemed_count: 5 }), true, NOW)).toBeNull();
    expect(compCodeFailure(row({ expires_at: '2026-01-01T00:00:00Z' }), true, NOW)).toBeNull();
  });
});

describe('normalizeCompCode', () => {
  it('trims and upper-cases so entry is forgiving', () => {
    expect(normalizeCompCode('  pilot-2026 ')).toBe('PILOT-2026');
  });
});

// ── Fake pg client for redeemCompCode ─────────────────────────────────────────
interface SubRow {
  firm_id: string;
  plan_code: string | null;
  status: string;
  seats: number;
  comp: boolean;
}

function makeDb(seed: {
  codes?: CompCodeRow[];
  plans?: { code: string; name: string; seat_limit: number | null; engagement_limit: number | null; features: string[] }[];
}) {
  const codes = new Map<string, CompCodeRow>((seed.codes ?? []).map((c) => [c.code, { ...c }]));
  const redemptions = new Set<string>();
  const subs = new Map<string, SubRow>();
  const plans = new Map((seed.plans ?? []).map((p) => [p.code, p]));

  const db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: string, params: any[] = []) {
      if (sql.includes('from comp_codes where code')) {
        const c = codes.get(params[0]);
        return { rowCount: c ? 1 : 0, rows: c ? [c] : [] };
      }
      if (sql.includes('from comp_code_redemptions where code')) {
        const has = redemptions.has(`${params[0]}|${params[1]}`);
        return { rowCount: has ? 1 : 0, rows: has ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('insert into comp_code_redemptions')) {
        const key = `${params[0]}|${params[1]}`;
        if (redemptions.has(key)) return { rowCount: 0, rows: [] };
        redemptions.add(key);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update comp_codes set redeemed_count')) {
        const c = codes.get(params[0]);
        if (c) c.redeemed_count += 1;
        return { rowCount: c ? 1 : 0, rows: [] };
      }
      if (sql.includes('insert into firm_subscriptions')) {
        const [firmId, planCode] = params;
        const existing = subs.get(firmId);
        subs.set(firmId, {
          firm_id: firmId,
          plan_code: planCode ?? existing?.plan_code ?? null,
          status: existing?.status ?? 'active',
          seats: existing?.seats ?? 1,
          comp: true,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from firm_subscriptions where firm_id')) {
        const s = subs.get(params[0]);
        return { rowCount: s ? 1 : 0, rows: s ? [s] : [] };
      }
      if (sql.includes('from plans where code')) {
        const p = plans.get(params[0]);
        return { rowCount: p ? 1 : 0, rows: p ? [p] : [] };
      }
      throw new Error(`fake db: unhandled sql: ${sql}`);
    },
  };
  return { db: db as unknown as pg.ClientBase, codes, redemptions, subs };
}

// ── redeemCompCode ────────────────────────────────────────────────────────────
describe('redeemCompCode', () => {
  it('redeems a valid code → firm becomes comped (fully entitled)', async () => {
    const { db, codes, redemptions } = makeDb({ codes: [row({ max_redemptions: 15 })] });
    const out = await redeemCompCode(db, { code: ' pilot-2026 ', firmId: 'firm-1', redeemedBy: 'user_1', now: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.entitlement.entitled).toBe(true);
    expect(out.entitlement.reason).toBe('comp');
    expect(out.alreadyRedeemed).toBe(false);
    expect(codes.get('PILOT-2026')!.redeemed_count).toBe(1);
    expect(redemptions.has('PILOT-2026|firm-1')).toBe(true);
  });

  it('is idempotent per firm: a second redeem re-applies without consuming a slot', async () => {
    const { db, codes } = makeDb({ codes: [row({ max_redemptions: 1 })] });
    const first = await redeemCompCode(db, { code: 'PILOT-2026', firmId: 'firm-1', now: NOW });
    const second = await redeemCompCode(db, { code: 'PILOT-2026', firmId: 'firm-1', now: NOW });
    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.alreadyRedeemed).toBe(true);
    // count stays 1 — the same firm never double-consumes the single slot.
    expect(codes.get('PILOT-2026')!.redeemed_count).toBe(1);
  });

  it('refuses an exhausted code for a new firm', async () => {
    const { db } = makeDb({ codes: [row({ max_redemptions: 1, redeemed_count: 1 })] });
    const out = await redeemCompCode(db, { code: 'PILOT-2026', firmId: 'firm-2', now: NOW });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('exhausted');
  });

  it('attaches the code’s plan on redeem', async () => {
    const { db } = makeDb({
      codes: [row({ plan_code: 'practice' })],
      plans: [{ code: 'practice', name: 'Practice', seat_limit: 5, engagement_limit: 25, features: ['assessment'] }],
    });
    const out = await redeemCompCode(db, { code: 'PILOT-2026', firmId: 'firm-3', now: NOW });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.planCode).toBe('practice');
    expect(out.entitlement.planName).toBe('Practice');
  });

  it('rejects an unknown code', async () => {
    const { db } = makeDb({ codes: [] });
    const out = await redeemCompCode(db, { code: 'NOPE', firmId: 'firm-1', now: NOW });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.reason).toBe('not_found');
  });
});
