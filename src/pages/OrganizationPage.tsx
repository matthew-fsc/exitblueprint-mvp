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
  useFirmProfessionals,
  useFirmEngagementRoster,
  useFirmStaff,
  type ProfessionalKind,
  type FirmProfessionalRow,
} from '../lib/queries';
import {
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  FirmMark,
  LoadingState,
  PageHeader,
  SectionCard,
  Switch,
  TierBadge,
  useToast,
} from '../components/ui';

const HEX = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

const KIND_LABEL: Record<ProfessionalKind, string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  ma_advisor: 'M&A advisor',
  banker: 'Banker',
  wealth_manager: 'Wealth manager',
  insurance: 'Insurance',
  other: 'Other',
};

// ── Branding (white-label identity) ───────────────────────────────────────────
// Moved here from Settings: the firm's identity on every client-facing report and
// portal is an org asset, so it lives in the admin Organization area and is
// admin-only to write (firm_branding RLS). Exit Blueprint stays "Powered by".
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
      subtitle="How your firm appears on every client-facing report and portal — Exit Blueprint stays in the background."
    >
      {error && <ErrorState variant="inline" error={error} />}
      <div
        style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,20rem)', gap: '1.25rem', alignItems: 'start' }}
        className="settings-grid"
      >
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
                value={accentValid && accent ? accent : '#1f7a52'}
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
              {disclosure && <p className="powered-by" style={{ marginTop: '0.9rem' }}>{disclosure}</p>}
              <p className="powered-by" style={{ marginTop: '0.5rem' }}>Powered by Exit Blueprint</p>
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
              {isDevStack && ' (dev stack — no email is sent)'}
            </span>
          )}
        </div>
      )}
    </SectionCard>
  );
}

// ── Professional directory ────────────────────────────────────────────────────
// The firm's reusable address book of the clients' outside professionals (CPAs,
// attorneys, M&A advisors, …). Admin-managed; advisors pick from it when building
// an engagement's deal team. Writes go direct under RLS (admin-only).
const EMPTY_FORM = { full_name: '', organization: '', kind: 'cpa' as ProfessionalKind, email: '', phone: '', notes: '' };

function DirectoryCard({ firmId, meProfileId }: { firmId?: string; meProfileId?: string }) {
  const qc = useQueryClient();
  const [includeArchived, setIncludeArchived] = useState(false);
  const { data: pros, isLoading } = useFirmProfessionals(firmId, { includeArchived });

  const [form, setForm] = useState(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<FirmProfessionalRow | null>(null);
  const { busy, run } = useAsyncAction();

  const reset = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const invalidate = () => firmId && qc.invalidateQueries({ queryKey: qk.firmProfessionals(firmId) });

  const startEdit = (p: FirmProfessionalRow) => {
    setEditingId(p.id);
    setForm({
      full_name: p.full_name,
      organization: p.organization ?? '',
      kind: p.kind,
      email: p.email ?? '',
      phone: p.phone ?? '',
      notes: p.notes ?? '',
    });
  };

  const submit = () =>
    run(
      async () => {
        if (!firmId || !form.full_name.trim()) throw new Error('A name is required.');
        const payload = {
          firm_id: firmId,
          full_name: form.full_name.trim(),
          organization: form.organization.trim() || null,
          kind: form.kind,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          notes: form.notes.trim() || null,
        };
        if (editingId) {
          const { error } = await supabase.from('firm_professionals').update(payload).eq('id', editingId);
          if (error) throw new Error(error.message);
        } else {
          const { error } = await supabase.from('firm_professionals').insert({ ...payload, created_by: meProfileId ?? null });
          if (error) throw new Error(error.message);
        }
        reset();
        invalidate();
      },
      { success: editingId ? 'Contact updated' : 'Contact added' },
    );

  const setArchived = (p: FirmProfessionalRow, archived: boolean) =>
    run(
      async () => {
        const { error } = await supabase.from('firm_professionals').update({ archived }).eq('id', p.id);
        if (error) throw new Error(error.message);
        setArchiving(null);
        invalidate();
      },
      { success: archived ? 'Contact archived' : 'Contact restored' },
    );

  return (
    <SectionCard
      title="Professional directory"
      subtitle="Your clients' outside professionals — CPAs, attorneys, M&A advisors, bankers. Curate them once here, then attach them to any engagement's deal team."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
        {isLoading ? (
          <LoadingState variant="inline" />
        ) : (pros ?? []).length === 0 ? (
          <EmptyState title="No professionals yet">Add the first outside professional your firm works with below.</EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {(pros ?? []).map((p) => (
              <div key={p.id} className="eb-list-row" style={{ opacity: p.archived ? 0.55 : 1 }}>
                <div className="eb-list-row-main">
                  <div style={{ fontWeight: 600 }}>
                    {p.full_name}
                    {p.organization && <span className="muted text-sm"> · {p.organization}</span>}
                  </div>
                  <div className="muted text-sm">
                    {[p.email, p.phone].filter(Boolean).join(' · ') || '—'}
                  </div>
                </div>
                <span className="status-chip status-neutral eb-list-row-push">{KIND_LABEL[p.kind]}</span>
                {p.archived && <span className="status-chip status-warning">Archived</span>}
                <button className="linkish" type="button" onClick={() => startEdit(p)}>Edit</button>
                {p.archived ? (
                  <button className="linkish" type="button" onClick={() => setArchived(p, false)} disabled={busy}>Restore</button>
                ) : (
                  <button className="linkish" type="button" onClick={() => setArchiving(p)}>Archive</button>
                )}
              </div>
            ))}
          </div>
        )}

        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-4)' }}>
          <span className="stat-block-label">{editingId ? 'Edit contact' : 'Add a professional'}</span>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }} className="settings-grid">
            <label className="field">
              <span className="field-label">Name</span>
              <input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} placeholder="Dana Reyes" />
            </label>
            <label className="field">
              <span className="field-label">Organization</span>
              <input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="Reyes & Co. CPAs" />
            </label>
            <label className="field">
              <span className="field-label">Type</span>
              <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as ProfessionalKind })}>
                {(Object.keys(KIND_LABEL) as ProfessionalKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Email</span>
              <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="dana@reyescpa.com" />
            </label>
            <label className="field">
              <span className="field-label">Phone</span>
              <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="(555) 123-4567" />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="field-label">Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Relationship, specialty, or how you work together." />
            </label>
          </div>
          <div className="control-row" style={{ marginTop: 'var(--space-3)', gap: 'var(--space-2)' }}>
            <button onClick={submit} disabled={busy || !form.full_name.trim()}>
              {busy ? 'Saving…' : editingId ? 'Save changes' : 'Add professional'}
            </button>
            {editingId && (
              <button className="button-secondary" type="button" onClick={reset} disabled={busy}>Cancel</button>
            )}
            <span className="control-row" style={{ marginLeft: 'auto', gap: 'var(--space-2)' }}>
              <Switch
                size="sm"
                checked={includeArchived}
                onChange={setIncludeArchived}
                label={<span className="muted text-sm">Show archived</span>}
              />
            </span>
          </div>
        </div>
      </div>

      <ConfirmDialog
        open={!!archiving}
        title="Archive this professional?"
        confirmLabel="Archive"
        cancelLabel="Cancel"
        busy={busy}
        onCancel={() => !busy && setArchiving(null)}
        onConfirm={() => archiving && setArchived(archiving, true)}
      >
        <p className="m-0">
          {archiving?.full_name} will be hidden from the directory and can't be attached to new engagements. Existing
          engagement links are kept. You can restore them later.
        </p>
      </ConfirmDialog>
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

export default function OrganizationPage() {
  const { profile, firmName } = useAuth();
  const firmId = profile?.firm_id ?? undefined;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Organization"
        subtitle="Your firm's team, branding, professional network, and engagement ownership — the controls that run the practice."
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Organization' }]}
      />
      <TeamCard firmId={firmId} meId={profile?.id} />
      <BrandingCard firmId={firmId} firmName={firmName} />
      <DirectoryCard firmId={firmId} meProfileId={profile?.id} />
      <AssignmentsCard firmId={firmId} />
    </div>
  );
}
