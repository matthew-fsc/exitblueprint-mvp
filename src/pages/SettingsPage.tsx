import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { supabase, isDevStack, isClerkStack } from '../lib/supabase';
import { useClerk } from '@clerk/react';
import { enrollTotp, getMfaState, verifyTotp, type MfaState, type TotpEnrollment } from '../lib/mfa';
import { ErrorState, LoadingState, PageHeader, SectionCard, useToast } from '../components/ui';
import { resolveEntitlement, type EntitlementReason } from '../../shared/entitlements';

// Read-only billing/access status. During the beta, firms are comped, so this
// reassures a tester they have full access; post-beta it shows the live plan.
const REASON_LABEL: Record<EntitlementReason, { label: string; cls: string }> = {
  comp: { label: 'Beta access — complimentary', cls: 'status-good' },
  active: { label: 'Active', cls: 'status-good' },
  trialing: { label: 'Trial', cls: 'status-ok' },
  past_due_grace: { label: 'Payment past due', cls: 'status-warning' },
  none: { label: 'No plan', cls: 'status-neutral' },
  inactive: { label: 'Inactive', cls: 'status-neutral' },
};

function BillingCard({ firmId }: { firmId?: string }) {
  const [state, setState] = useState<{ reason: EntitlementReason; planName: string | null; seatLimit: number | null } | null>(null);
  useEffect(() => {
    if (!firmId) return;
    let alive = true;
    (async () => {
      const [{ data: sub }, { data: plans }] = await Promise.all([
        supabase.from('firm_subscriptions').select('plan_code,status,seats,comp').eq('firm_id', firmId).maybeSingle(),
        supabase.from('plans').select('code,name,seat_limit,engagement_limit,features').eq('active', true),
      ]);
      if (!alive) return;
      const plan = (plans ?? []).find((p) => p.code === sub?.plan_code) ?? null;
      const ent = resolveEntitlement(
        sub ? { plan_code: sub.plan_code, status: sub.status, seats: sub.seats, comp: sub.comp } : null,
        plan ? { code: plan.code, name: plan.name, seat_limit: plan.seat_limit, engagement_limit: plan.engagement_limit, features: plan.features ?? [] } : null,
      );
      setState({ reason: ent.reason, planName: ent.planName, seatLimit: ent.seatLimit });
    })();
    return () => {
      alive = false;
    };
  }, [firmId]);

  const meta = state ? REASON_LABEL[state.reason] : null;
  return (
    <SectionCard title="Billing & access" subtitle="Your firm's plan and access status.">
      {!state ? (
        <LoadingState variant="inline" />
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
          <span className={`status-chip ${meta!.cls}`}>{meta!.label}</span>
          <span className="muted">
            {state.planName ? `${state.planName} plan` : 'No plan attached'}
            {state.seatLimit != null ? ` · ${state.seatLimit} seat${state.seatLimit === 1 ? '' : 's'}` : ''}
          </span>
          <Link to="/settings/billing" style={{ marginLeft: 'auto' }}>
            Manage billing →
          </Link>
        </div>
      )}
    </SectionCard>
  );
}

// Multi-factor authentication lives in Settings (the MFA gate routes unenrolled
// advisors here). Same enrollment / verify flow it always had.
function MfaCard() {
  const toast = useToast();
  const [state, setState] = useState<MfaState | 'loading'>('loading');
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    getMfaState()
      .then(setState)
      .catch(() => setState('satisfied'));
  };
  useEffect(refresh, []);

  const startEnroll = async () => {
    setBusy(true);
    setError(null);
    try {
      setEnrollment(await enrollTotp());
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  const verify = async () => {
    if (!enrollment) return;
    setBusy(true);
    setError(null);
    try {
      await verifyTotp(enrollment.factorId, code.trim());
      setEnrollment(null);
      setCode('');
      toast.show('Multi-factor authentication enabled', 'good');
      refresh();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  };

  return (
    <SectionCard title="Multi-factor authentication" subtitle="Required for advisor and admin accounts.">
      {isDevStack ? (
        <p className="muted">
          MFA is enforced on the hosted deployment. The local dev stack has no authenticator endpoint, so enrollment is
          disabled here.
        </p>
      ) : state === 'loading' ? (
        <LoadingState variant="inline" label="Checking status…" />
      ) : state === 'satisfied' && !enrollment ? (
        <p className="status-chip status-good">Active — your account is protected by MFA.</p>
      ) : (
        <div className="mfa-enroll">
          {!enrollment ? (
            <>
              <p className="muted">
                {state === 'needs_verify'
                  ? 'Enter a code from your authenticator to finish signing in.'
                  : 'MFA is required for advisor accounts. Add an authenticator app to continue.'}
              </p>
              <button onClick={startEnroll} disabled={busy}>
                {busy ? 'Starting…' : 'Set up authenticator'}
              </button>
            </>
          ) : (
            <>
              <p className="muted">Scan this with your authenticator app, or enter the secret manually.</p>
              <img className="mfa-qr" src={enrollment.qrSvg} alt="MFA QR code" />
              <code className="mfa-secret">{enrollment.secret}</code>
              <div className="mfa-verify">
                <input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} />
                <button onClick={verify} disabled={busy || code.trim().length < 6}>
                  {busy ? 'Verifying…' : 'Verify & enable'}
                </button>
              </div>
            </>
          )}
          {error && <ErrorState variant="inline" error={error} />}
        </div>
      )}
    </SectionCard>
  );
}

// Personal account (name, email, password, MFA devices) lives in Clerk, the
// identity provider. Everything about the FIRM — its team, branding, directory —
// is managed in the Organization area (admins only). We link out to Clerk's
// personal-account portal for the individual identity.
function ClerkAccountCard() {
  const clerk = useClerk();
  return (
    <SectionCard title="Your account" subtitle="Your personal sign-in and security are managed in Clerk.">
      <div className="control-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button className="button-secondary" onClick={() => clerk.openUserProfile()}>
          Manage your account
        </button>
      </div>
      <p className="muted text-sm" style={{ marginTop: 'var(--space-3)' }}>
        Your name, email, password, and multi-factor devices live in your personal account.
      </p>
    </SectionCard>
  );
}

// A pointer to the admin-only Organization area, shown to admins so the firm's
// team, branding, directory, and engagement ownership have a clear home.
function OrganizationCard() {
  return (
    <SectionCard
      title="Organization"
      subtitle="Your firm's team & seats, white-label branding, professional directory, and engagement ownership."
    >
      <div className="control-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <Link to="/organization">Open Organization →</Link>
      </div>
      <p className="muted text-sm" style={{ marginTop: 'var(--space-3)' }}>
        These are firm-wide administrative controls, so they're managed by admins.
      </p>
    </SectionCard>
  );
}

export default function SettingsPage() {
  const { profile } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const isAdmin = profile?.role === 'admin';

  return (
    <div className="stack-lg">
      <PageHeader
        title="Settings"
        subtitle="Your account, your firm's plan, and — for admins — the Organization controls."
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Settings' }]}
      />

      <BillingCard firmId={firmId} />
      {isClerkStack && <ClerkAccountCard />}
      {isAdmin && <OrganizationCard />}
      <MfaCard />
    </div>
  );
}
