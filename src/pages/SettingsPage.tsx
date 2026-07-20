import { useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase, isDevStack, isClerkStack } from '../lib/supabase';
import { useClerk } from '@clerk/react';
import { qk, useBranding } from '../lib/queries';
import { enrollTotp, getMfaState, verifyTotp, type MfaState, type TotpEnrollment } from '../lib/mfa';
import { Card, ErrorState, FirmMark, LoadingState, PageHeader, SectionCard, TierBadge, useToast } from '../components/ui';
import { resolveEntitlement, type EntitlementReason } from '../../shared/entitlements';

// Validate a CSS hex color (#rgb or #rrggbb).
const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// Read-only billing/access status. During the beta, firms are comped, so this
// reassures a tester they have full access; post-beta it shows the live plan.
// Manage-billing (Stripe portal) is wired in the Stripe checkout slice.
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

// Multi-factor authentication lives in Settings now that the standalone Security
// page is gone (the MFA gate routes unenrolled advisors here). Same enrollment /
// verify flow it always had; only its home moved.
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
          MFA is enforced on the hosted deployment. The local dev stack has no authenticator
          endpoint, so enrollment is disabled here.
        </p>
      ) : state === 'loading' ? (
        <p className="muted">Checking status…</p>
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
                <input
                  inputMode="numeric"
                  placeholder="6-digit code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
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

// Account + organization management (name, email, password, MFA devices, firm
// members) lives in Clerk, the identity provider. Rather than duplicate those
// surfaces, link into Clerk's own portals from Settings. Only mounted on the
// Clerk stack, so useClerk() always runs inside <ClerkProvider>.
function ClerkAccountCard() {
  const clerk = useClerk();
  return (
    <SectionCard
      title="Account & organization"
      subtitle="Your sign-in, profile, and firm membership are managed in Clerk."
    >
      <div className="control-row" style={{ gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <button className="button-secondary" onClick={() => clerk.openUserProfile()}>
          Manage your account
        </button>
        <button className="button-secondary" onClick={() => clerk.openOrganizationProfile()}>
          Organization settings
        </button>
      </div>
      <p className="muted text-sm" style={{ marginTop: 'var(--space-3)' }}>
        Your name, email, password, and multi-factor devices live in your account. Your firm's
        members are managed under the organization. The logo shown on client-facing reports is set
        below — it is independent of any logo in Clerk.
      </p>
    </SectionCard>
  );
}

export default function SettingsPage() {
  const { profile, firmName } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const { data: branding, isLoading } = useBranding(firmId);
  const qc = useQueryClient();
  const toast = useToast();

  const [displayName, setDisplayName] = useState('');
  const [accent, setAccent] = useState('');
  const [logoUrl, setLogoUrl] = useState('');
  const [fromLine, setFromLine] = useState('');
  const [disclosure, setDisclosure] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (branding) {
      setDisplayName(branding.display_name ?? '');
      setAccent(branding.accent_color ?? '');
      setLogoUrl(branding.logo_url ?? '');
      setFromLine(branding.report_from_line ?? '');
      setDisclosure(branding.footer_disclosure_md ?? '');
    } else if (branding === null && firmName) {
      setDisplayName(firmName);
    }
  }, [branding, firmName]);

  const accentValid = accent === '' || HEX.test(accent);

  // Logo upload: store as a data URL in logo_url so it works without a
  // configured storage bucket (dev stack). Production can swap this for a
  // Supabase Storage upload and store the public URL instead.
  const onLogoFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 400_000) {
      setError('Logo must be under 400 KB. Use an SVG or a small PNG.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => setLogoUrl(String(reader.result));
    reader.readAsDataURL(file);
  };

  const save = async () => {
    if (!firmId) return;
    if (!accentValid) {
      setError('Accent color must be a hex value like #1f7a52.');
      return;
    }
    setSaving(true);
    setError(null);
    const { error } = await supabase
      .from('firm_branding')
      .upsert(
        {
          firm_id: firmId,
          display_name: displayName || null,
          accent_color: accent || null,
          logo_url: logoUrl || null,
          report_from_line: fromLine || null,
          footer_disclosure_md: disclosure || null,
        },
        { onConflict: 'firm_id' },
      );
    setSaving(false);
    if (error) {
      setError(error.message);
      return;
    }
    qc.invalidateQueries({ queryKey: qk.branding(firmId) });
    toast.show('Branding saved', 'good');
  };

  const previewBrand = {
    displayName: displayName || firmName,
    logoUrl: logoUrl || null,
    accentColor: accentValid && accent ? accent : null,
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Firm settings"
        subtitle="Your plan, and how your firm appears on every client-facing report and portal — Exit Blueprint stays in the background."
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Settings' }]}
      />

      {error && <ErrorState variant="inline" error={error} />}

      <BillingCard firmId={firmId} />

      {isClerkStack && <ClerkAccountCard />}
      <MfaCard />

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,20rem)', gap: '1.25rem', alignItems: 'start' }} className="settings-grid">
        <Card pad="lg">
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <label className="field">
              <span className="field-label">Display name</span>
              <input value={displayName} onChange={(e) => setDisplayName(e.target.value)} placeholder="Cascade Wealth Partners" />
            </label>

            <label className="field">
              <span className="field-label">Report from line</span>
              <input value={fromLine} onChange={(e) => setFromLine(e.target.value)} placeholder="Prepared by Jane Doe, CFP®, Cascade Wealth Partners" />
            </label>

            <label className="field">
              <span className="field-label">Accent color</span>
              <span className="control-row">
                <input
                  type="color"
                  value={accentValid && accent ? (accent.length === 4 ? accent : accent) : '#1f7a52'}
                  onChange={(e) => setAccent(e.target.value)}
                  style={{ width: '3rem', height: '2.4rem', padding: 2 }}
                  aria-label="Accent color picker"
                />
                <input
                  value={accent}
                  onChange={(e) => setAccent(e.target.value)}
                  placeholder="#1f7a52"
                  style={{ maxWidth: '9rem' }}
                  aria-invalid={!accentValid}
                />
                {!accentValid && <span className="form-error">invalid hex</span>}
              </span>
            </label>

            <label className="field">
              <span className="field-label">Logo</span>
              <input type="file" accept="image/png,image/svg+xml,image/jpeg" onChange={onLogoFile} />
              <span className="field-hint">PNG or SVG, under 400 KB. Or paste a URL below.</span>
              <input value={logoUrl.startsWith('data:') ? '' : logoUrl} onChange={(e) => setLogoUrl(e.target.value)} placeholder="https://…/logo.svg" />
              {logoUrl && (
                <button className="linkish" type="button" onClick={() => setLogoUrl('')} style={{ alignSelf: 'flex-start' }}>
                  Remove logo
                </button>
              )}
            </label>

            <label className="field">
              <span className="field-label">Footer disclosure</span>
              <textarea
                rows={4}
                value={disclosure}
                onChange={(e) => setDisclosure(e.target.value)}
                placeholder="Compliance disclosure shown at the foot of every client-facing document."
              />
            </label>

            <div>
              <button onClick={save} disabled={saving || isLoading || !firmId}>
                {saving ? 'Saving…' : 'Save branding'}
              </button>
            </div>
          </div>
        </Card>

        <Card pad="lg">
          <span className="stat-block-label">Live preview</span>
          <div style={{ marginTop: '0.9rem', display: 'flex', flexDirection: 'column', gap: '1rem' }}>
            <div style={accentValid && accent ? ({ ['--accent' as string]: accent } as React.CSSProperties) : undefined}>
              <FirmMark brand={previewBrand} />
              <p className="ui-pageheader-sub" style={{ marginTop: '0.5rem' }}>{fromLine || 'Prepared by your firm'}</p>
              <div style={{ marginTop: '0.75rem', display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                <TierBadge tier="Sale Ready" />
                <button style={{ background: 'var(--accent)' }}>Accent button</button>
              </div>
              {disclosure && (
                <p className="powered-by" style={{ marginTop: '0.9rem' }}>{disclosure}</p>
              )}
              <p className="powered-by" style={{ marginTop: '0.5rem' }}>Powered by Exit Blueprint</p>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
