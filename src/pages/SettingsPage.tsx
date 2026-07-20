import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, isDevStack, supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import { qk, useBranding } from '../lib/queries';
import { Card, EmptyState, ErrorState, FirmMark, LoadingState, PageHeader, SectionCard, TierBadge, useToast } from '../components/ui';
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

// ── Team management (self-serve advisor provisioning, docs/35 #1) ──────────────
// Advisors/admins invite firm staff without the CLI. Members are read directly
// under RLS (advisor_firm_profiles_read / admin_firm_profiles_read); the invite
// goes through the guarded invite-advisor function (Clerk org invite in prod, dev
// direct-insert locally).

interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  role: 'admin' | 'advisor' | 'reviewer' | 'owner';
}

interface InviteAdvisorResult {
  status: 'invited' | 'exists';
  email: string;
  role: string;
  seatsUsed: number;
  seatLimit: number | null;
  dev_password?: string;
}

const STAFF_ROLE_LABEL: Record<string, string> = {
  admin: 'Admin',
  advisor: 'Advisor',
  reviewer: 'Reviewer',
  owner: 'Owner',
};

function TeamCard({ firmId, meId }: { firmId?: string; meId?: string }) {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [seatLimit, setSeatLimit] = useState<number | null>(null);
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [role, setRole] = useState<'advisor' | 'reviewer' | 'admin'>('advisor');
  const [devNote, setDevNote] = useState<string | null>(null);
  const { busy, run } = useAsyncAction();

  const load = useCallback(async () => {
    if (!firmId) return;
    const [{ data: profs }, { data: sub }] = await Promise.all([
      supabase.from('profiles').select('id,full_name,email,role').eq('firm_id', firmId).in('role', ['advisor', 'reviewer', 'admin']).order('role'),
      supabase.from('firm_subscriptions').select('plan_code').eq('firm_id', firmId).maybeSingle(),
    ]);
    setMembers((profs as Member[]) ?? []);
    if (sub?.plan_code) {
      const { data: plan } = await supabase.from('plans').select('seat_limit').eq('code', sub.plan_code).maybeSingle();
      setSeatLimit((plan?.seat_limit as number | null | undefined) ?? null);
    } else {
      setSeatLimit(null);
    }
  }, [firmId]);

  useEffect(() => {
    load();
  }, [load]);

  const invite = () =>
    run(
      async () => {
        const res = await invokeFunction<InviteAdvisorResult>('invite-advisor', {
          email,
          full_name: name || null,
          role,
        });
        setDevNote(
          res.status === 'exists'
            ? `${res.email} is already on this firm.`
            : res.dev_password
              ? `Invited ${res.email}. Dev login: password "${res.dev_password}".`
              : `Invitation email sent to ${res.email}.`,
        );
        setEmail('');
        setName('');
        await load();
        return res;
      },
      { success: 'Invitation sent' },
    );

  const seatsUsed = members?.length ?? 0;
  const seatText = seatLimit == null ? `${seatsUsed} seat${seatsUsed === 1 ? '' : 's'} used` : `${seatsUsed} of ${seatLimit} seats used`;
  const atLimit = seatLimit != null && seatsUsed >= seatLimit;

  return (
    <SectionCard title="Team" subtitle="Advisors, reviewers and admins in your firm. Invite a colleague to give them their own login.">
      {members === null ? (
        <LoadingState variant="inline" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {members.length === 0 ? (
              <EmptyState title="No team members yet">Invite your first colleague below.</EmptyState>
            ) : (
              members.map((m) => (
                <div
                  key={m.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 'var(--space-3)',
                    padding: 'var(--space-2) 0',
                    borderBottom: '1px solid var(--border)',
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>
                      {m.full_name || m.email || '—'}
                      {m.id === meId && <span className="muted text-sm"> · you</span>}
                    </div>
                    {m.full_name && m.email && <div className="muted text-sm">{m.email}</div>}
                  </div>
                  <span className="status-chip status-neutral" style={{ marginLeft: 'auto' }}>
                    {STAFF_ROLE_LABEL[m.role] ?? m.role}
                  </span>
                </div>
              ))
            )}
            <span className="muted text-sm">{seatText}</span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr) auto auto', gap: 'var(--space-2)', alignItems: 'end' }} className="team-invite-row">
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="colleague@firm.com" />
            </label>
            <label className="field">
              <span className="field-label">Name (optional)</span>
              <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Advisor" />
            </label>
            <label className="field">
              <span className="field-label">Role</span>
              <select value={role} onChange={(e) => setRole(e.target.value as typeof role)}>
                <option value="advisor">Advisor</option>
                <option value="reviewer">Reviewer</option>
                <option value="admin">Admin</option>
              </select>
            </label>
            <button onClick={invite} disabled={busy || !email || atLimit}>
              {busy ? 'Inviting…' : 'Invite'}
            </button>
          </div>
          {atLimit && (
            <span className="form-error">Seat limit reached. Upgrade your plan to add more advisors.</span>
          )}
          {devNote && (
            <span className="muted text-sm">
              {devNote}
              {isDevStack && ' (dev stack — no email is sent)'}
            </span>
          )}
        </div>
      )}
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

      <TeamCard firmId={firmId} meId={profile?.id} />

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
