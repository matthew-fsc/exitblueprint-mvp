import { describe, expect, it } from 'vitest';
import {
  resolveEntitlement,
  hasFeature,
  withinLimit,
  type PlanRow,
  type SubscriptionRow,
} from '../shared/entitlements';

const practice: PlanRow = {
  code: 'practice',
  name: 'Practice',
  seat_limit: 5,
  engagement_limit: 25,
  features: ['assessment', 'valuation', 'data_room'],
};

const sub = (o: Partial<SubscriptionRow>): SubscriptionRow => ({
  plan_code: 'practice',
  status: 'active',
  seats: 5,
  comp: false,
  ...o,
});

describe('resolveEntitlement', () => {
  it('entitles an active paid subscription and exposes plan limits + features', () => {
    const e = resolveEntitlement(sub({ status: 'active' }), practice);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe('active');
    expect(e.planCode).toBe('practice');
    expect(e.seatLimit).toBe(5);
    expect(e.engagementLimit).toBe(25);
    expect(e.features).toContain('valuation');
  });

  it('entitles a trialing subscription', () => {
    expect(resolveEntitlement(sub({ status: 'trialing' }), practice).reason).toBe('trialing');
  });

  it('keeps a past_due subscription entitled (grace window)', () => {
    const e = resolveEntitlement(sub({ status: 'past_due' }), practice);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe('past_due_grace');
  });

  it('denies canceled / incomplete', () => {
    expect(resolveEntitlement(sub({ status: 'canceled' }), practice).entitled).toBe(false);
    expect(resolveEntitlement(sub({ status: 'incomplete' }), practice).reason).toBe('inactive');
  });

  it('denies when there is no subscription row at all', () => {
    const e = resolveEntitlement(null, null);
    expect(e.entitled).toBe(false);
    expect(e.reason).toBe('none');
  });

  it('comp overrides any Stripe status — the beta path', () => {
    // A comped firm is entitled even with a canceled/absent Stripe status.
    const e = resolveEntitlement(sub({ status: 'canceled', comp: true }), practice);
    expect(e.entitled).toBe(true);
    expect(e.reason).toBe('comp');
  });

  it('comp with no plan is entitled with no feature restriction', () => {
    const e = resolveEntitlement(sub({ plan_code: null, status: 'incomplete', comp: true }), null);
    expect(e.entitled).toBe(true);
    expect(hasFeature(e, 'valuation')).toBe(true); // empty feature set on an entitled firm = full
  });
});

describe('hasFeature', () => {
  it('is false for any feature when not entitled', () => {
    expect(hasFeature(resolveEntitlement(null, null), 'assessment')).toBe(false);
  });
  it('respects the plan feature set when entitled with a plan', () => {
    const e = resolveEntitlement(sub({ status: 'active' }), practice);
    expect(hasFeature(e, 'valuation')).toBe(true);
    expect(hasFeature(e, 'branding')).toBe(false); // Practice has no branding
  });
});

describe('withinLimit', () => {
  it('treats null as unlimited', () => {
    expect(withinLimit(9999, null)).toBe(true);
  });
  it('is exclusive on the limit (at limit = no room for one more)', () => {
    expect(withinLimit(4, 5)).toBe(true);
    expect(withinLimit(5, 5)).toBe(false);
  });
});
