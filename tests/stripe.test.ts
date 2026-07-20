// Stripe billing core (server/stripe.ts). Everything here is pure: an in-memory
// fake pg client + hand-built event objects exercise the price→plan map and the
// idempotent event→state machine. NO live Stripe, NO real database, NO network —
// the SDK-touching functions (checkout / portal / signature verify) are covered by
// the Stripe CLI in test mode (docs/24 §5.6), not here.
import { describe, expect, it } from 'vitest';
import type pg from 'pg';
import {
  applyStripeEvent,
  planToPrice,
  priceToPlan,
  type PlanPriceRow,
  type StripeEvent,
} from '../server/stripe';

const PLANS: PlanPriceRow[] = [
  { code: 'solo', stripe_price_id: 'price_solo' },
  { code: 'practice', stripe_price_id: 'price_practice' },
  { code: 'firm', stripe_price_id: 'price_firm' },
];

// ── Fake pg client ────────────────────────────────────────────────────────────
// A tiny in-memory Postgres stand-in that understands only the statements
// applyStripeEvent issues, matched by substring. Returns { rowCount, rows } like
// node-postgres so the code under test is unchanged.
interface FirmRow {
  id: string;
  stripe_customer_id: string | null;
}
interface SubRow {
  firm_id: string;
  stripe_subscription_id: string | null;
  plan_code: string | null;
  status: string;
  seats: number;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}

function makeDb(seed?: { firms?: FirmRow[]; plans?: PlanPriceRow[] }) {
  const firms = new Map<string, FirmRow>((seed?.firms ?? []).map((f) => [f.id, { ...f }]));
  const subs = new Map<string, SubRow>();
  const events = new Map<string, { type: string; payload: unknown; processed_at: string | null }>();
  const plans = seed?.plans ?? PLANS;

  const db = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async query(sql: string, params: any[] = []) {
      if (sql.includes('insert into billing_events')) {
        const [id, type, payload] = params;
        if (events.has(id)) return { rowCount: 0, rows: [] };
        events.set(id, { type, payload, processed_at: null });
        return { rowCount: 1, rows: [{ id: `row_${id}` }] };
      }
      if (sql.includes('update billing_events set processed_at')) {
        const e = events.get(params[0]);
        if (e) e.processed_at = 'now';
        return { rowCount: e ? 1 : 0, rows: [] };
      }
      if (sql.includes('update firms set stripe_customer_id')) {
        const [firmId, customerId] = params;
        const f = firms.get(firmId) ?? { id: firmId, stripe_customer_id: null };
        f.stripe_customer_id = customerId;
        firms.set(firmId, f);
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('from firms where stripe_customer_id')) {
        const match = [...firms.values()].find((f) => f.stripe_customer_id === params[0]);
        return { rowCount: match ? 1 : 0, rows: match ? [{ id: match.id }] : [] };
      }
      if (sql.includes('from plans')) {
        return { rowCount: plans.length, rows: plans };
      }
      if (sql.includes('insert into firm_subscriptions')) {
        const [firm_id, stripe_subscription_id, plan_code, status, seats, cpe, cancel] = params;
        subs.set(firm_id, {
          firm_id,
          stripe_subscription_id,
          plan_code,
          status,
          seats,
          current_period_end: cpe,
          cancel_at_period_end: cancel,
        });
        return { rowCount: 1, rows: [] };
      }
      if (sql.includes('update firm_subscriptions set status')) {
        const [firmId, status] = params;
        const sub = subs.get(firmId);
        if (!sub) return { rowCount: 0, rows: [] };
        sub.status = status;
        return { rowCount: 1, rows: [] };
      }
      throw new Error(`fake db: unhandled sql: ${sql}`);
    },
  };

  return { db: db as unknown as pg.ClientBase, firms, subs, events };
}

// ── Event fixtures ────────────────────────────────────────────────────────────
let seq = 0;
function evt(type: string, object: Record<string, unknown>, id?: string): StripeEvent {
  return { id: id ?? `evt_${type}_${++seq}`, type, data: { object } };
}
function subscriptionObject(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'sub_1',
    customer: 'cus_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: 1893456000, // 2030-01-01
    items: { data: [{ price: { id: 'price_practice' }, quantity: 5 }] },
    metadata: { firm_id: 'firm-1' },
    ...over,
  };
}

// ── priceToPlan / planToPrice ─────────────────────────────────────────────────
describe('priceToPlan / planToPrice', () => {
  it('maps a Stripe price id to its plan code', () => {
    expect(priceToPlan(PLANS, 'price_practice')).toBe('practice');
    expect(priceToPlan(PLANS, 'price_firm')).toBe('firm');
  });

  it('returns null for an unknown or missing price', () => {
    expect(priceToPlan(PLANS, 'price_unknown')).toBeNull();
    expect(priceToPlan(PLANS, null)).toBeNull();
    expect(priceToPlan(PLANS, undefined)).toBeNull();
  });

  it('maps a plan code back to its price id (round trip)', () => {
    expect(planToPrice(PLANS, 'solo')).toBe('price_solo');
    expect(planToPrice(PLANS, priceToPlan(PLANS, 'price_firm'))).toBe('price_firm');
    expect(planToPrice(PLANS, 'ghost')).toBeNull();
  });
});

// ── applyStripeEvent: idempotency ─────────────────────────────────────────────
describe('applyStripeEvent idempotency', () => {
  it('processes an event once; a redelivery with the same id is a no-op', async () => {
    const { db, subs, events } = makeDb();
    const first = evt('customer.subscription.created', subscriptionObject(), 'evt_dup');
    const r1 = await applyStripeEvent(db, first);
    expect(r1.handled).toBe(true);
    expect(r1.duplicate).toBeUndefined();
    expect(subs.get('firm-1')!.status).toBe('active');

    // Same event id, but a payload that WOULD cancel — must be ignored entirely.
    const replay = evt('customer.subscription.deleted', subscriptionObject({ status: 'canceled' }), 'evt_dup');
    const r2 = await applyStripeEvent(db, replay);
    expect(r2.duplicate).toBe(true);
    expect(r2.handled).toBe(false);
    // The second state change never happened — still active, one logged event.
    expect(subs.get('firm-1')!.status).toBe('active');
    expect(events.size).toBe(1);
  });
});

// ── applyStripeEvent: status transitions ──────────────────────────────────────
describe('applyStripeEvent transitions', () => {
  it('checkout.session.completed caches the firm’s Stripe customer id', async () => {
    const { db, firms } = makeDb({ firms: [{ id: 'firm-1', stripe_customer_id: null }] });
    const r = await applyStripeEvent(
      db,
      evt('checkout.session.completed', { client_reference_id: 'firm-1', customer: 'cus_1' }),
    );
    expect(r.handled).toBe(true);
    expect(firms.get('firm-1')!.stripe_customer_id).toBe('cus_1');
  });

  it('customer.subscription.updated upserts the cached row (plan, seats, period)', async () => {
    const { db, subs } = makeDb();
    await applyStripeEvent(db, evt('customer.subscription.updated', subscriptionObject()));
    const sub = subs.get('firm-1')!;
    expect(sub.status).toBe('active');
    expect(sub.plan_code).toBe('practice');
    expect(sub.seats).toBe(5);
    expect(sub.stripe_subscription_id).toBe('sub_1');
    expect(sub.current_period_end).toBe(new Date(1893456000 * 1000).toISOString());
    expect(sub.cancel_at_period_end).toBe(false);
  });

  it('resolves the firm from the Stripe customer when metadata is absent', async () => {
    // The realistic flow: checkout links firm→customer, then the subscription
    // event (no metadata) resolves the firm by its cached customer id.
    const { db, subs } = makeDb({ firms: [{ id: 'firm-9', stripe_customer_id: 'cus_9' }] });
    const object = subscriptionObject({ customer: 'cus_9', metadata: {} });
    delete (object as Record<string, unknown>).metadata;
    await applyStripeEvent(db, evt('customer.subscription.created', object));
    expect(subs.get('firm-9')!.plan_code).toBe('practice');
  });

  it('invoice.payment_failed moves the subscription to past_due', async () => {
    const { db, subs } = makeDb();
    await applyStripeEvent(db, evt('customer.subscription.created', subscriptionObject()));
    await applyStripeEvent(db, evt('invoice.payment_failed', { customer: 'cus_1', metadata: { firm_id: 'firm-1' } }));
    expect(subs.get('firm-1')!.status).toBe('past_due');
  });

  it('invoice.paid restores the subscription to active', async () => {
    const { db, subs } = makeDb();
    await applyStripeEvent(db, evt('customer.subscription.created', subscriptionObject({ status: 'past_due' })));
    expect(subs.get('firm-1')!.status).toBe('past_due');
    await applyStripeEvent(db, evt('invoice.paid', { metadata: { firm_id: 'firm-1' } }));
    expect(subs.get('firm-1')!.status).toBe('active');
  });

  it('customer.subscription.deleted marks the subscription canceled', async () => {
    const { db, subs } = makeDb();
    await applyStripeEvent(db, evt('customer.subscription.created', subscriptionObject()));
    await applyStripeEvent(db, evt('customer.subscription.deleted', subscriptionObject({ status: 'active' })));
    expect(subs.get('firm-1')!.status).toBe('canceled');
  });

  it('ignores an unrelated event type but still logs it (idempotency substrate)', async () => {
    const { db, events } = makeDb();
    const r = await applyStripeEvent(db, evt('customer.updated', { id: 'cus_1' }));
    expect(r.handled).toBe(false);
    expect(r.detail).toMatch(/ignored/);
    expect(events.size).toBe(1);
  });
});
