// Stripe billing boundary — per-firm subscription + seats (docs/24 §5). The
// advisor firm is the paying customer: firm = Stripe Customer = Clerk Org. Stripe
// is the source of truth for money; firm_subscriptions is the cache the app reads.
//
// Structure mirrors server/clerk-webhook.ts: the SDK-touching functions (checkout,
// portal, signature verification) are thin and env-gated, while the event→state
// core (`applyStripeEvent`) is PURE — it takes an already-parsed event object and
// a pg client, so it is unit-testable with a fake client and hand-built fixtures,
// no live Stripe and no real DB (tests/stripe.test.ts). Every DB write runs under
// the service role (the webhook is a trusted system caller, RLS-bypass like the
// Clerk webhook); no client ever writes billing state.
import Stripe from 'stripe';
import type pg from 'pg';

// ── Env / SDK boundary ────────────────────────────────────────────────────────
// Nothing here runs unless the Stripe keys are set: local dev and CI have no
// Stripe keys, so the SDK-touching functions throw a clear "stripe not configured"
// error and the webhook route replies 503 (like the Clerk webhook). The pure
// applyStripeEvent below never reads env.
let stripeClient: Stripe | null = null;

export function stripeConfigured(): boolean {
  return Boolean(process.env.STRIPE_SECRET_KEY?.trim() && process.env.STRIPE_WEBHOOK_SECRET?.trim());
}

// The shared Stripe client, built from STRIPE_SECRET_KEY. Throws (not silently
// no-ops) when unset so a misconfigured deploy fails loudly instead of pretending
// to charge. Memoized so repeated calls reuse one client.
export function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw new Error('stripe not configured: set STRIPE_SECRET_KEY');
  if (!stripeClient) stripeClient = new Stripe(key);
  return stripeClient;
}

export function stripeWebhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim();
  if (!secret) throw new Error('stripe not configured: set STRIPE_WEBHOOK_SECRET');
  return secret;
}

// ── Checkout + billing portal (SDK calls) ─────────────────────────────────────
export interface CheckoutArgs {
  firmId: string;
  planCode: string;
  stripeCustomerId?: string | null; // reuse the firm's existing Stripe Customer if it has one
  successUrl: string;
  cancelUrl: string;
}
export interface CheckoutDeps {
  stripe: Stripe;
  db: pg.ClientBase; // to resolve the plan's stripe_price_id
}

// Start a subscription Checkout Session for the caller's firm. client_reference_id
// AND metadata.firm_id both carry the firm id so the webhook can map back to it,
// and subscription_data.metadata.firm_id stamps the firm onto the subscription
// object itself (so customer.subscription.* events resolve the firm even before
// checkout.session.completed has linked the Stripe Customer).
export async function createCheckoutSession(args: CheckoutArgs, deps: CheckoutDeps): Promise<{ url: string }> {
  const priceId = (
    await deps.db.query(`select stripe_price_id from plans where code = $1 and active`, [args.planCode])
  ).rows[0]?.stripe_price_id as string | null | undefined;
  if (!priceId) throw new Error(`plan '${args.planCode}' has no Stripe price configured`);

  const session = await deps.stripe.checkout.sessions.create({
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: args.firmId,
    metadata: { firm_id: args.firmId },
    subscription_data: { metadata: { firm_id: args.firmId } },
    ...(args.stripeCustomerId ? { customer: args.stripeCustomerId } : {}),
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  });
  if (!session.url) throw new Error('Stripe did not return a checkout URL');
  return { url: session.url };
}

export interface PortalArgs {
  stripeCustomerId: string;
  returnUrl: string;
}
export interface PortalDeps {
  stripe: Stripe;
}

// Self-serve card / plan / cancel via the Stripe billing portal — the dunning
// recovery path (docs/24 §5.5): a past_due firm updates its card here, Stripe
// retries, invoice.paid flips it back to active.
export async function createBillingPortalSession(args: PortalArgs, deps: PortalDeps): Promise<{ url: string }> {
  const session = await deps.stripe.billingPortal.sessions.create({
    customer: args.stripeCustomerId,
    return_url: args.returnUrl,
  });
  return { url: session.url };
}

// Verify a Stripe webhook signature against the RAW request body (the http.ts
// route must pass raw bytes, no JSON pre-parse). Thin wrapper over the SDK's
// constructEvent — the security boundary for the one unauthenticated endpoint.
// Throws on a bad signature (the caller replies 400).
export function verifyStripeSignature(
  rawBody: string | Buffer,
  signatureHeader: string,
  webhookSecret: string,
): Stripe.Event {
  return getStripe().webhooks.constructEvent(rawBody, signatureHeader, webhookSecret);
}

// ── Price ↔ plan mapping (pure) ───────────────────────────────────────────────
// The plans table is the single source of truth for which Stripe Price maps to
// which plan code (docs/24 §5.2). Resolved from rows the caller passes (or reads
// from the DB), never hard-coded. Pure and unit-tested.
export interface PlanPriceRow {
  code: string;
  stripe_price_id: string | null;
}

export function priceToPlan(plans: PlanPriceRow[], priceId: string | null | undefined): string | null {
  if (!priceId) return null;
  return plans.find((p) => p.stripe_price_id === priceId)?.code ?? null;
}

export function planToPrice(plans: PlanPriceRow[], planCode: string | null | undefined): string | null {
  if (!planCode) return null;
  return plans.find((p) => p.code === planCode)?.stripe_price_id ?? null;
}

// ── The pure event → state core ───────────────────────────────────────────────
// A minimal view of the Stripe event envelope. `data.object` is `unknown` so a
// real Stripe.Event is assignable here (extra fields are fine) AND hand-built test
// fixtures need only these three fields.
export interface StripeEvent {
  id: string;
  type: string;
  data: { object: unknown };
}

export interface ApplyResult {
  handled: boolean;
  duplicate?: boolean;
  detail: string;
}

// The subset of the Stripe objects we read, all optional (fixtures/real payloads
// vary by API version). subscriptions carry current_period_end either on the
// object or on the first item depending on API version — read both.
interface StripeObject {
  id?: string;
  customer?: string | null;
  status?: string;
  client_reference_id?: string | null;
  metadata?: Record<string, unknown> | null;
  cancel_at_period_end?: boolean;
  current_period_end?: number;
  quantity?: number;
  items?: { data?: Array<{ price?: { id?: string } | null; quantity?: number; current_period_end?: number }> };
}

// Map a Stripe object to our firm id. Prefer the firm id we stamped into metadata
// / client_reference_id (survives before the Customer is linked); otherwise look
// the firm up by its cached Stripe Customer id.
async function resolveFirmId(db: pg.ClientBase, obj: StripeObject): Promise<string | null> {
  const fromMeta = obj.metadata?.firm_id;
  if (typeof fromMeta === 'string' && fromMeta) return fromMeta;
  if (typeof obj.client_reference_id === 'string' && obj.client_reference_id) return obj.client_reference_id;
  if (typeof obj.customer === 'string' && obj.customer) {
    return (await db.query(`select id from firms where stripe_customer_id = $1`, [obj.customer])).rows[0]?.id ?? null;
  }
  return null;
}

// Apply a verified Stripe event to the billing cache. Idempotent and pure (no
// SDK, no env): (a) log the event by its Stripe id — a redelivery is a no-op;
// (b) mutate firms / firm_subscriptions per the event type; (c) stamp processed_at.
// Safe to call repeatedly with the same event.
export async function applyStripeEvent(db: pg.ClientBase, event: StripeEvent): Promise<ApplyResult> {
  // (a) Idempotency: record the event first. `on conflict do nothing` means a
  // redelivered event id inserts zero rows — treat that as a duplicate and stop
  // before any state change.
  const logged = await db.query(
    `insert into billing_events (stripe_event_id, type, payload)
     values ($1, $2, $3)
     on conflict (stripe_event_id) do nothing
     returning id`,
    [event.id, event.type, event],
  );
  if (!logged.rowCount) return { handled: false, duplicate: true, detail: `duplicate event ${event.id}` };

  // (b) Dispatch on the event type.
  const result = await dispatch(db, event);

  // (c) Mark the event processed (even when ignored — we did record + inspect it).
  await db.query(`update billing_events set processed_at = now() where stripe_event_id = $1`, [event.id]);
  return result;
}

async function dispatch(db: pg.ClientBase, event: StripeEvent): Promise<ApplyResult> {
  const obj = event.data.object as StripeObject;
  switch (event.type) {
    case 'checkout.session.completed':
      return linkCustomer(db, obj);
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
      return upsertSubscription(db, obj, obj.status ?? 'incomplete');
    case 'customer.subscription.deleted':
      return upsertSubscription(db, obj, 'canceled');
    case 'invoice.paid':
      return setSubscriptionStatus(db, obj, 'active');
    case 'invoice.payment_failed':
      return setSubscriptionStatus(db, obj, 'past_due');
    default:
      return { handled: false, detail: `ignored event ${event.type}` };
  }
}

// checkout.session.completed → cache the firm's Stripe Customer id on firms. The
// subscription rows arrive via the customer.subscription.* events.
async function linkCustomer(db: pg.ClientBase, obj: StripeObject): Promise<ApplyResult> {
  const firmId = await resolveFirmId(db, obj);
  const customerId = typeof obj.customer === 'string' ? obj.customer : null;
  if (!firmId || !customerId) return { handled: false, detail: 'checkout.session.completed missing firm/customer' };
  await db.query(`update firms set stripe_customer_id = $2 where id = $1`, [firmId, customerId]);
  return { handled: true, detail: `linked firm ${firmId} to Stripe customer ${customerId}` };
}

// customer.subscription.created|updated|deleted → upsert the one cached row per
// firm. Plan resolved from the price via the plans table; seats from the line
// quantity; status passed in (the subscription's status, or 'canceled' on delete).
async function upsertSubscription(db: pg.ClientBase, obj: StripeObject, status: string): Promise<ApplyResult> {
  const firmId = await resolveFirmId(db, obj);
  if (!firmId) return { handled: false, detail: 'subscription event could not resolve a firm' };

  const plans = (await db.query(`select code, stripe_price_id from plans`)).rows as PlanPriceRow[];
  const line = obj.items?.data?.[0];
  const planCode = priceToPlan(plans, line?.price?.id);
  const seats = line?.quantity ?? obj.quantity ?? 1;
  const periodEndUnix = obj.current_period_end ?? line?.current_period_end ?? null;
  const currentPeriodEnd = periodEndUnix ? new Date(periodEndUnix * 1000).toISOString() : null;

  await db.query(
    `insert into firm_subscriptions
       (firm_id, stripe_subscription_id, plan_code, status, seats, current_period_end, cancel_at_period_end, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, now())
     on conflict (firm_id) do update set
       stripe_subscription_id = excluded.stripe_subscription_id,
       plan_code = excluded.plan_code,
       status = excluded.status,
       seats = excluded.seats,
       current_period_end = excluded.current_period_end,
       cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = now()`,
    [firmId, obj.id ?? null, planCode, status, seats, currentPeriodEnd, Boolean(obj.cancel_at_period_end)],
  );
  return { handled: true, detail: `firm ${firmId} subscription → ${status}${planCode ? ` (${planCode})` : ''}` };
}

// invoice.paid | invoice.payment_failed → move the firm's subscription status
// (active / past_due). If no cached row exists yet (invoice before the
// subscription event), it is a no-op — the subscription event will set the row.
async function setSubscriptionStatus(db: pg.ClientBase, obj: StripeObject, status: string): Promise<ApplyResult> {
  const firmId = await resolveFirmId(db, obj);
  if (!firmId) return { handled: false, detail: 'invoice event could not resolve a firm' };
  const updated = await db.query(
    `update firm_subscriptions set status = $2, updated_at = now() where firm_id = $1`,
    [firmId, status],
  );
  if (!updated.rowCount) return { handled: false, detail: `no subscription row for firm ${firmId} yet` };
  return { handled: true, detail: `firm ${firmId} subscription → ${status}` };
}
