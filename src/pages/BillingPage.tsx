import { useQuery } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import { fmtDate } from '../lib/format';
import {
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SectionCard,
  StatBlock,
  StatRow,
} from '../components/ui';
import { resolveEntitlement, type EntitlementReason } from '../../shared/entitlements';

// Settings → Billing. Read-only status of the firm's subscription (the cache the
// Stripe webhook keeps fresh, docs/24 §5.2) plus the two self-serve actions:
// "Manage billing" (Stripe portal — card/plan/cancel) and choosing a plan
// (Checkout). Both are POST functions that return a { url } we redirect to.
// Writing billing state is never done from the client — only through Stripe.

// Access status → chip label + tone. Mirrors SettingsPage's BillingCard so the
// two surfaces read the same; the plan/status detail lives here.
const REASON_LABEL: Record<EntitlementReason, { label: string; cls: string }> = {
  comp: { label: 'Beta access — complimentary', cls: 'status-good' },
  active: { label: 'Active', cls: 'status-good' },
  trialing: { label: 'Trial', cls: 'status-ok' },
  past_due_grace: { label: 'Payment past due', cls: 'status-warning' },
  none: { label: 'No plan', cls: 'status-neutral' },
  inactive: { label: 'Inactive', cls: 'status-neutral' },
};

interface PlanRow {
  code: string;
  name: string;
  stripe_price_id: string | null;
  seat_limit: number | null;
  engagement_limit: number | null;
  features: string[];
  sort: number;
}
interface SubRow {
  plan_code: string | null;
  status: string;
  seats: number;
  comp: boolean;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
}
interface BillingData {
  sub: SubRow | null;
  plans: PlanRow[];
  stripeCustomerId: string | null;
  seatsUsed: number;
}

// Staff roles occupy a seat; owners (clients) do not.
const STAFF_ROLES = ['advisor', 'reviewer', 'admin'];

function useBilling(firmId: string | undefined) {
  return useQuery<BillingData>({
    queryKey: ['billing', firmId ?? ''],
    enabled: !!firmId,
    queryFn: async () => {
      const [subRes, plansRes, firmRes, profilesRes] = await Promise.all([
        supabase
          .from('firm_subscriptions')
          .select('plan_code,status,seats,comp,current_period_end,cancel_at_period_end')
          .eq('firm_id', firmId!)
          .maybeSingle(),
        supabase.from('plans').select('*').eq('active', true).order('sort'),
        supabase.from('firms').select('stripe_customer_id').eq('id', firmId!).maybeSingle(),
        supabase.from('profiles').select('role').eq('firm_id', firmId!),
      ]);
      for (const r of [subRes, plansRes, firmRes, profilesRes]) {
        if (r.error) throw new Error(r.error.message);
      }
      const seatsUsed = ((profilesRes.data ?? []) as { role: string }[]).filter((p) =>
        STAFF_ROLES.includes(p.role),
      ).length;
      return {
        sub: (subRes.data as SubRow) ?? null,
        plans: ((plansRes.data ?? []) as PlanRow[]).map((p) => ({ ...p, features: p.features ?? [] })),
        stripeCustomerId: (firmRes.data as { stripe_customer_id: string | null } | null)?.stripe_customer_id ?? null,
        seatsUsed,
      };
    },
  });
}

export default function BillingPage() {
  const { profile } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const { data, isLoading, error } = useBilling(firmId);
  const { busy, run } = useAsyncAction();

  const openPortal = () =>
    run(
      async () => {
        const { url } = await invokeFunction<{ url: string }>('create-billing-portal-session', {
          return_url: window.location.href,
        });
        window.location.assign(url);
      },
      { onError: () => {} },
    );

  const startCheckout = (planCode: string) =>
    run(
      async () => {
        const { url } = await invokeFunction<{ url: string }>('create-checkout-session', {
          plan_code: planCode,
          success_url: `${window.location.origin}/settings/billing?checkout=success`,
          cancel_url: window.location.href,
        });
        window.location.assign(url);
      },
      { onError: () => {} },
    );

  const header = (
    <PageHeader
      title="Billing"
      subtitle="Your firm's subscription, seats, and invoices — managed securely through Stripe."
      crumbs={[{ label: 'Portfolio', to: '/' }, { label: 'Settings', to: '/settings' }, { label: 'Billing' }]}
    />
  );

  if (!firmId) {
    return (
      <div className="stack-lg">
        {header}
        <ErrorState variant="inline" error="No firm is associated with your account." />
      </div>
    );
  }
  if (isLoading || !data) {
    return (
      <div className="stack-lg">
        {header}
        <LoadingState variant="page" />
      </div>
    );
  }
  if (error) {
    return (
      <div className="stack-lg">
        {header}
        <ErrorState variant="inline" error={(error as Error).message} />
      </div>
    );
  }

  const { sub, plans, stripeCustomerId, seatsUsed } = data;
  const currentPlan = plans.find((p) => p.code === sub?.plan_code) ?? null;
  const ent = resolveEntitlement(
    sub && { plan_code: sub.plan_code, status: sub.status, seats: sub.seats, comp: sub.comp },
    currentPlan && {
      code: currentPlan.code,
      name: currentPlan.name,
      seat_limit: currentPlan.seat_limit,
      engagement_limit: currentPlan.engagement_limit,
      features: currentPlan.features,
    },
  );
  const meta = REASON_LABEL[ent.reason];
  const seatLimit = ent.seatLimit; // null = unlimited
  const hasSubscription = ent.entitled || ent.reason === 'past_due_grace';

  return (
    <div className="stack-lg">
      {header}

      {/* Current plan + status. Always shown so a lapsed/comped firm still sees
          where it stands, with the manage-billing self-serve action. */}
      <SectionCard
        title="Plan & billing"
        subtitle="Managed through Stripe. Update your card or cancel any time via Manage billing."
        action={
          stripeCustomerId ? (
            <button className="button-secondary" onClick={openPortal} disabled={busy}>
              Manage billing
            </button>
          ) : undefined
        }
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap', marginBottom: '1rem' }}>
          <span className={`status-chip ${meta.cls}`}>{meta.label}</span>
          {sub?.cancel_at_period_end && (
            <span className="status-chip status-warning">Cancels at period end</span>
          )}
        </div>
        <StatRow>
          <StatBlock label="Plan" value={ent.planName ?? 'None'} />
          <StatBlock
            label="Seats"
            value={seatLimit == null ? String(seatsUsed) : `${seatsUsed} of ${seatLimit}`}
            hint={seatLimit == null ? 'Unlimited seats' : 'Staff members using a seat'}
          />
          <StatBlock
            label={sub?.cancel_at_period_end ? 'Access ends' : 'Renews'}
            value={fmtDate(sub?.current_period_end)}
          />
        </StatRow>
      </SectionCard>

      {/* Paywall / empty state: no active subscription. */}
      {!hasSubscription && (
        <Card pad="lg">
          <EmptyState
            icon="warning"
            title="No active subscription"
            action={
              plans.length > 0 ? (
                <p className="muted" style={{ marginTop: '0.5rem' }}>
                  Choose a plan below to activate your firm's workspace.
                </p>
              ) : undefined
            }
          >
            Your firm doesn't have an active plan. Viewing existing records stays available; starting
            new assessments, reports, and valuations requires a subscription.
          </EmptyState>
        </Card>
      )}

      {/* Plan picker. Choosing a plan opens Stripe Checkout; the current plan is
          marked and its button disabled. */}
      <SectionCard title="Plans" subtitle="Select a plan to start or change your subscription.">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(15rem, 1fr))',
            gap: '1rem',
            marginTop: '0.5rem',
          }}
        >
          {plans.map((plan) => {
            const isCurrent = plan.code === sub?.plan_code && ent.entitled;
            return (
              <Card key={plan.code} pad="lg">
                <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', height: '100%' }}>
                  <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '0.5rem' }}>
                    <span className="stat-block-label">{plan.name}</span>
                    {isCurrent && <span className="status-chip status-good">Current</span>}
                  </div>
                  <p className="muted" style={{ margin: 0 }}>
                    {plan.seat_limit == null ? 'Unlimited seats' : `Up to ${plan.seat_limit} seat${plan.seat_limit === 1 ? '' : 's'}`}
                    {plan.engagement_limit != null && ` · ${plan.engagement_limit} engagements`}
                  </p>
                  <div style={{ marginTop: 'auto', paddingTop: '0.5rem' }}>
                    <button
                      onClick={() => startCheckout(plan.code)}
                      disabled={busy || isCurrent}
                      title={isCurrent ? 'This is your current plan' : undefined}
                    >
                      {isCurrent ? 'Current plan' : hasSubscription ? 'Switch to this plan' : 'Choose plan'}
                    </button>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      </SectionCard>
    </div>
  );
}
