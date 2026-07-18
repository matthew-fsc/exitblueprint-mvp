import { afterEach, describe, expect, it } from 'vitest';
import { entitlementGate, getFirmEntitlement, GATED_FNS } from '../server/entitlements';

// A minimal fake pg client: returns canned rows per query shape.
function fakeDb(rows: { subscription?: Record<string, unknown> | null; plan?: Record<string, unknown> | null }) {
  return {
    query: async (sql: string) => {
      if (sql.includes('from firm_subscriptions')) return { rows: rows.subscription ? [rows.subscription] : [] };
      if (sql.includes('from plans')) return { rows: rows.plan ? [rows.plan] : [] };
      return { rows: [] };
    },
  } as never;
}

afterEach(() => {
  delete process.env.BILLING_ENFORCED;
});

describe('entitlementGate', () => {
  it('is a no-op when billing is not enforced (default) — even a gated action passes', async () => {
    delete process.env.BILLING_ENFORCED;
    const msg = await entitlementGate('score-assessment', 'firm-1', fakeDb({ subscription: null }));
    expect(msg).toBeNull();
  });

  it('refuses a gated action for an unentitled firm when enforced', async () => {
    process.env.BILLING_ENFORCED = 'true';
    const msg = await entitlementGate('score-assessment', 'firm-1', fakeDb({ subscription: null }));
    expect(msg).toMatch(/active subscription/i);
  });

  it('allows a non-gated action even when enforced (viewing stays free)', async () => {
    process.env.BILLING_ENFORCED = 'true';
    const msg = await entitlementGate('explain-assessment', 'firm-1', fakeDb({ subscription: null }));
    expect(msg).toBeNull();
    expect(GATED_FNS.has('explain-assessment')).toBe(false);
  });

  it('allows a comped firm a gated action even when enforced (the beta path)', async () => {
    process.env.BILLING_ENFORCED = 'true';
    const db = fakeDb({ subscription: { plan_code: null, status: 'incomplete', seats: 1, comp: true } });
    const msg = await entitlementGate('compute-valuation', 'firm-1', db);
    expect(msg).toBeNull();
  });

  it('getFirmEntitlement joins the plan and reports its features', async () => {
    const db = fakeDb({
      subscription: { plan_code: 'practice', status: 'active', seats: 5, comp: false },
      plan: { code: 'practice', name: 'Practice', seat_limit: 5, engagement_limit: 25, features: ['valuation'] },
    });
    const ent = await getFirmEntitlement(db, 'firm-1');
    expect(ent.entitled).toBe(true);
    expect(ent.planName).toBe('Practice');
    expect(ent.features).toContain('valuation');
  });
});
