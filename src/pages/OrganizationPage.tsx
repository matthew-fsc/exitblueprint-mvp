// Organization — the admin home for a firm's organizational controls (white-label
// branding, team & seats, the professional directory, and engagement ownership).
// Admin-only (RequireAdmin in App.tsx); advisors do client work, admins run the
// org. Every write here is also enforced at the database: branding and the
// directory are admin-only in RLS, and engagement reassignment goes through the
// admin-scoped assign-engagement function.
import { useCallback, useEffect, useState, type ChangeEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase, invokeFunction, isDevStack } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  useBranding,
  useFirmEngagementRoster,
  useFirmStaff,
} from '../lib/queries';
import {
  Card,
  BrandLogomark,
  EmptyState,
  ErrorState,
  FirmMark,
  LoadingState,
  PageHeader,
  SectionCard,
  SubTabs,
  subTabId,
  subTabPanelId,
  TierBadge,
  useToast,
} from '../components/ui';
import type { SubTab } from '../components/ui/SubTabs';
import { ProfessionalDirectoryCard } from '../components/ProfessionalDirectoryCard';
import { accentVars } from '../lib/color';
import { BRAND } from '../lib/brand';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

// ── Branding (white-label identity) ───────────────────────────────────────────
// Moved here from Settings: the firm's identity on every client-facing report and
// portal is an org asset, so it lives in the admin Organization area and is
// admin-only to write (firm_branding RLS). ExitBlueprint stays "Powered by".
function BrandingCard({ firmId, firmName }: { firmId?: string; firmName: string | null }) {
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
    const { error } = await supabase.from('firm_branding').upsert(
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
    <SectionCard
      title="Branding"
      subtitle={`How your firm appears on every client-facing report and portal. ${BRAND.name} stays in the background.`}
    >
      {error && <ErrorState variant="inline" error={error} />}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,20rem)', gap: 'var(--space-5)', alignItems: 'start' }}
        className="settings-grid"
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
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
                value={accentValid && accent ? accent : '#1f7a52'}
                onChange={(e) => setAccent(e.target.value)}
                style={{ width: 'calc(var(--control-h) + var(--space-3))', height: 'var(--control-h)', padding: 'var(--space-1)' }}
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

        <Card pad="lg">
          <span className="stat-block-label">Live preview</span>
          <div style={{ marginTop: 'var(--space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
            <div style={(accentValid && accent ? accentVars(accent) : undefined) as React.CSSProperties | undefined}>
              <FirmMark brand={previewBrand} />
              <p className="ui-pageheader-sub" style={{ marginTop: 'var(--space-2)' }}>{fromLine || 'Prepared by your firm'}</p>
              <div style={{ marginTop: 'var(--space-3)', display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                <TierBadge tier="Sale Ready" />
                <button>Accent button</button>
              </div>
              {disclosure && <p className="powered-by" style={{ marginTop: 'var(--space-4)' }}>{disclosure}</p>}
              <p className="powered-by" style={{ marginTop: 'var(--space-2)' }}>
                <BrandLogomark className="powered-by-mark" size={13} />
                {BRAND.poweredBy}
              </p>
            </div>
          </div>
        </Card>
      </div>
    </SectionCard>
  );
}

// ── Team & seats ──────────────────────────────────────────────────────────────
interface Member {
  id: string;
  full_name: string | null;
  email: string | null;
  role: 'admin' | 'advisor' | 'reviewer' | 'owner';
}
interface InviteAdvisorResult {
  status: 'invited' | 'exists';
  email: string;
  dev_password?: string;
}
const STAFF_ROLE_LABEL: Record<string, string> = { admin: 'Admin', advisor: 'Advisor', reviewer: 'Reviewer', owner: 'Owner' };

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
        const res = await invokeFunction<InviteAdvisorResult>('invite-advisor', { email, full_name: name || null, role });
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
    <SectionCard title="Team & seats" subtitle="Advisors, reviewers and admins in your firm. Only admins can invite or change the team.">
      {members === null ? (
        <LoadingState variant="inline" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {members.length === 0 ? (
              <EmptyState title="No team members yet">Invite your first colleague below.</EmptyState>
            ) : (
              members.map((m) => (
                <div key={m.id} className="eb-list-row">
                  <div className="eb-list-row-main">
                    <div style={{ fontWeight: 600 }}>
                      {m.full_name || m.email || '—'}
                      {m.id === meId && <span className="muted text-sm"> · you</span>}
                    </div>
                    {m.full_name && m.email && <div className="muted text-sm">{m.email}</div>}
                  </div>
                  <span className="status-chip status-neutral eb-list-row-push">{STAFF_ROLE_LABEL[m.role] ?? m.role}</span>
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
            <button onClick={invite} disabled={busy || !email || atLimit}>{busy ? 'Inviting…' : 'Invite'}</button>
          </div>
          {atLimit && <span className="form-error">Seat limit reached. Upgrade your plan to add more advisors.</span>}
          {devNote && (
            <span className="muted text-sm">
              {devNote}
              {isDevStack && ' (dev stack: no email is sent)'}
            </span>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Engagement assignments ────────────────────────────────────────────────────
// Firm-wide roster of who owns what. Reassignment goes through the admin-scoped
// assign-engagement function (the only path past the advisor_id guard trigger).
function AssignmentsCard({ firmId }: { firmId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: roster, isLoading } = useFirmEngagementRoster(firmId);
  const { data: staff } = useFirmStaff(firmId);
  const [savingId, setSavingId] = useState<string | null>(null);

  const reassign = async (engagementId: string, advisorId: string) => {
    setSavingId(engagementId);
    try {
      await invokeFunction('assign-engagement', { engagement_id: engagementId, advisor_id: advisorId || null });
      if (firmId) qc.invalidateQueries({ queryKey: qk.firmEngagementRoster(firmId) });
      toast.show('Engagement reassigned', 'good');
    } catch (e) {
      toast.show((e as Error).message, 'error');
    }
    setSavingId(null);
  };

  return (
    <SectionCard title="Engagement assignments" subtitle="Who on your team owns each engagement. Reassign ownership as your practice grows.">
      {isLoading ? (
        <LoadingState variant="inline" />
      ) : (roster ?? []).length === 0 ? (
        <EmptyState title="No engagements yet">Engagements appear here once you create them.</EmptyState>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {(roster ?? []).map((e) => (
            <div key={e.id} className="eb-list-row">
              <div className="eb-list-row-main">
                <div style={{ fontWeight: 600 }}>{e.company?.name ?? 'Engagement'}</div>
                <div className="muted text-sm">
                  {e.advisor ? `Owned by ${e.advisor.full_name || e.advisor.email}` : 'Unassigned'} · {e.status}
                </div>
              </div>
              <label className="field eb-list-row-push" style={{ minWidth: '12rem' }}>
                <span className="field-label">Owner</span>
                <select
                  value={e.advisor_id ?? ''}
                  disabled={savingId === e.id}
                  onChange={(ev) => reassign(e.id, ev.target.value)}
                >
                  <option value="">Unassigned</option>
                  {(staff ?? []).map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.full_name || s.email}
                      {s.role === 'admin' ? ' (admin)' : ''}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// The four org controls used to stack as one long scroll. They're distinct
// admin jobs (grow the team, dress the reports, curate the network, hand off
// engagements), so they split cleanly into sub-tabs — one job in view, the
// rest one click away rather than a scroll hunt (mirrors Evidence/Library).
const ORG_TABS: SubTab[] = [
  { key: 'team', label: 'Team & seats' },
  { key: 'branding', label: 'Branding' },
  { key: 'directory', label: 'Directory' },
  { key: 'assignments', label: 'Assignments' },
];

export default function OrganizationPage() {
  const { profile, firmName } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const [tab, setTab] = useState('team');

  return (
    <div className="stack-lg">
      <PageHeader
        title="Organization"
        subtitle="Your firm's team, branding, professional network, and engagement ownership. The controls that run the practice."
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Organization' }]}
      />
      <SubTabs tabs={ORG_TABS} activeKey={tab} onSelect={setTab} ariaLabel="Organization controls" />
      <div role="tabpanel" id={subTabPanelId(tab)} aria-labelledby={subTabId(tab)}>
        {tab === 'team' && <TeamCard firmId={firmId} meId={profile?.id} />}
        {tab === 'branding' && <BrandingCard firmId={firmId} firmName={firmName} />}
        {tab === 'directory' && <ProfessionalDirectoryCard firmId={firmId} meProfileId={profile?.id} />}
        {tab === 'assignments' && <AssignmentsCard firmId={firmId} />}
      </div>
    </div>
  );
}
