// The "professionals on this deal" roster — the client's outside professionals
// (CPA, attorney, M&A advisor, …) drawn from the firm's directory. This renders
// as INNER content of the unified EngagementTeamCard surface (no SectionCard of
// its own). Attaching a directory contact records who's on the deal; each row
// then carries an OPTIONAL "Grant portal access" action that emails that person
// a VIEW-ONLY portal link (the invite-collaborator workflow). Portal status is
// derived by matching the collaborator roster to a professional by email — the
// only join available (the two tables share no FK). Directory writes go direct
// under RLS (staff CRUD); portal invites go through the edge function.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, isDevStack, supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  useEngagementCollaborators,
  useEngagementProfessionals,
  useFirmProfessionals,
  type EngagementCollaboratorRow,
  type ProfessionalKind,
} from '../lib/queries';
import { ConfirmDialog, EmptyState, SkeletonLines, useToast } from './ui';

const KIND_LABEL: Record<ProfessionalKind, string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  ma_advisor: 'M&A advisor',
  banker: 'Banker',
  wealth_manager: 'Wealth manager',
  insurance: 'Insurance',
  other: 'Other',
};

const COLLAB_KIND_LABEL: Record<EngagementCollaboratorRow['kind'], string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  advisor: 'Other advisor',
  other: 'Other',
};

// Map a directory professional's kind onto the narrower collaborator kind the
// invite-collaborator function accepts (cpa | attorney | advisor | other).
function toCollaboratorKind(kind: ProfessionalKind): EngagementCollaboratorRow['kind'] {
  if (kind === 'cpa') return 'cpa';
  if (kind === 'attorney') return 'attorney';
  if (kind === 'other') return 'other';
  return 'advisor';
}

const norm = (email: string | null | undefined) => (email ?? '').trim().toLowerCase();

interface CollaboratorInviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  kind: string;
  dev_password?: string;
}

function PortalStatusChip({ status }: { status: EngagementCollaboratorRow['status'] }) {
  const cls = status === 'active' ? 'status-good' : 'status-warning';
  return (
    <span className={`status-chip ${cls}`}>{status === 'active' ? 'Portal · active' : 'Portal · invited'}</span>
  );
}

export function EngagementProfessionalsCard({
  engagementId,
  firmId,
}: {
  engagementId: string;
  firmId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const linkedQ = useEngagementProfessionals(engagementId);
  const directoryQ = useFirmProfessionals(firmId);
  const collabsQ = useEngagementCollaborators(engagementId);
  const { busy, run } = useAsyncAction();

  const [professionalId, setProfessionalId] = useState('');
  const [role, setRole] = useState('');
  const [pendingPortalId, setPendingPortalId] = useState<string | null>(null);
  const [lastGrant, setLastGrant] = useState<CollaboratorInviteResult | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const linked = linkedQ.data ?? [];
  const linkedIds = new Set(linked.map((l) => l.professional_id));
  const available = (directoryQ.data ?? []).filter((p) => !linkedIds.has(p.id));

  // Collaborator roster indexed by email — the only key that joins a portal
  // guest to a directory professional (no FK between the two tables).
  const collabs = collabsQ.data ?? [];
  const collabByEmail = new Map<string, EngagementCollaboratorRow>();
  for (const c of collabs) {
    const key = norm(c.email);
    if (key) collabByEmail.set(key, c);
  }
  const matchedCollabIds = new Set<string>();
  for (const l of linked) {
    const c = collabByEmail.get(norm(l.professional?.email));
    if (c) matchedCollabIds.add(c.id);
  }
  // Portal guests with no matching professional on the deal (e.g. legacy invites)
  // — surfaced so nobody already invited is orphaned/hidden.
  const orphanCollabs = collabs.filter((c) => !matchedCollabIds.has(c.id));

  const invalidateProfessionals = () =>
    qc.invalidateQueries({ queryKey: qk.engagementProfessionals(engagementId) });
  const invalidateCollaborators = () =>
    qc.invalidateQueries({ queryKey: qk.engagementCollaborators(engagementId) });

  const attach = () =>
    run(
      async () => {
        if (!professionalId) throw new Error('Pick a professional from the directory.');
        const { error } = await supabase.from('engagement_professionals').insert({
          firm_id: firmId,
          engagement_id: engagementId,
          professional_id: professionalId,
          engagement_role: role.trim() || null,
          added_by: profile?.id ?? null,
        });
        if (error) throw new Error(error.message);
        setProfessionalId('');
        setRole('');
        invalidateProfessionals();
      },
      { success: 'Added to the deal' },
    );

  const remove = (id: string) =>
    run(
      async () => {
        const { error } = await supabase.from('engagement_professionals').delete().eq('id', id);
        if (error) throw new Error(error.message);
        invalidateProfessionals();
      },
      { success: 'Removed from the deal' },
    );

  const grantPortal = (p: { id: string; full_name: string; email: string | null; kind: ProfessionalKind }) => {
    setPendingPortalId(p.id);
    return run(
      async () => {
        const r = await invokeFunction<CollaboratorInviteResult>('invite-collaborator', {
          engagement_id: engagementId,
          email: p.email,
          full_name: p.full_name,
          kind: toCollaboratorKind(p.kind),
        });
        setLastGrant(r);
        invalidateCollaborators();
      },
      { success: 'View-only link sent' },
    ).finally(() => setPendingPortalId(null));
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await invokeFunction('revoke-collaborator', {
        engagement_id: engagementId,
        collaborator_id: revoking.id,
      });
      invalidateCollaborators();
      toast.show('Access revoked', 'good');
      setRevoking(null);
    } catch (err) {
      // Keep the dialog open on failure so the user can retry.
      toast.show((err as Error).message, 'error');
    }
    setRevokeBusy(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div>
        <span className="stat-block-label">Professionals on this deal</span>
        <p className="muted" style={{ margin: 'var(--space-1) 0 var(--space-3)' }}>
          The client's outside professionals, pulled from your firm's directory. Attaching one records
          who's on the deal; grant portal access to email an individual a read-only view of this
          engagement.
        </p>
      </div>

      {linkedQ.isLoading ? (
        <SkeletonLines lines={2} />
      ) : linked.length > 0 ? (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          {linked.map((l) => {
            const email = l.professional?.email ?? null;
            const kind = l.professional?.kind ?? 'other';
            const collab = collabByEmail.get(norm(email));
            const granting = pendingPortalId === l.id;
            return (
              <li
                key={l.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>
                    {l.professional?.full_name ?? 'Professional'}
                    {l.professional?.organization && <span className="muted text-sm"> · {l.professional.organization}</span>}
                  </div>
                  <div className="muted text-sm">
                    {KIND_LABEL[kind]}
                    {l.engagement_role ? ` · ${l.engagement_role}` : ''}
                    {email ? ` · ${email}` : ''}
                  </div>
                </div>
                <div style={{ marginLeft: 'auto', display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 'var(--space-1)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
                    {collab && <PortalStatusChip status={collab.status} />}
                    {collab ? (
                      <button
                        className="linkish"
                        type="button"
                        onClick={() => setRevoking({ id: collab.id, label: l.professional?.full_name || email || 'This professional' })}
                      >
                        Revoke access
                      </button>
                    ) : (
                      <button
                        className="btn-secondary btn-sm"
                        type="button"
                        disabled={busy || !email}
                        title={email ? undefined : 'Add an email in the directory to grant access'}
                        onClick={() =>
                          email &&
                          grantPortal({ id: l.id, full_name: l.professional?.full_name ?? '', email, kind })
                        }
                      >
                        {granting ? 'Sending…' : 'Grant portal access'}
                      </button>
                    )}
                  </div>
                  {!collab && !email && (
                    <span className="muted text-xs">Add an email in the directory to grant access</span>
                  )}
                </div>
                <button className="linkish" type="button" onClick={() => remove(l.id)} disabled={busy}>
                  Remove
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <EmptyState title="No professionals on this deal yet">
          Attach the client's CPA, attorney, or M&A advisor from your firm's directory.
        </EmptyState>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1.4fr) minmax(0,1fr) auto', gap: 'var(--space-2)', alignItems: 'end' }} className="team-invite-row">
        <label className="field">
          <span className="field-label">From directory</span>
          <select value={professionalId} onChange={(e) => setProfessionalId(e.target.value)} disabled={available.length === 0}>
            <option value="">{available.length === 0 ? 'No more in directory' : 'Choose a professional…'}</option>
            {available.map((p) => (
              <option key={p.id} value={p.id}>
                {p.full_name}
                {p.organization ? ` · ${p.organization}` : ''} ({KIND_LABEL[p.kind]})
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span className="field-label">Role on this deal (optional)</span>
          <input value={role} onChange={(e) => setRole(e.target.value)} placeholder="Deal counsel, QoE, …" />
        </label>
        <button onClick={attach} disabled={busy || !professionalId}>{busy ? 'Adding…' : 'Add'}</button>
      </div>
      {available.length === 0 && (directoryQ.data ?? []).length === 0 && (
        <p className="muted text-sm">
          Your firm directory is empty. An admin can add professionals under Organization → Professional directory.
        </p>
      )}

      {lastGrant && isDevStack && lastGrant.dev_password && (
        <p className="invite-devnote">
          Dev: <strong>{lastGrant.email}</strong> can sign in now with password{' '}
          <code>{lastGrant.dev_password}</code> to the read-only portal. (In production this sends a
          portal invitation email.)
        </p>
      )}

      {/* Portal guests not matched to any professional on the deal (legacy invites,
          or people not in the directory) — kept visible so nobody loses access. */}
      {orphanCollabs.length > 0 && (
        <div>
          <span className="stat-block-label">Other portal guests</span>
          <p className="muted" style={{ margin: 'var(--space-1) 0 var(--space-3)' }}>
            People with a view-only portal link who aren't in this deal's professional roster.
          </p>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {orphanCollabs.map((c) => (
              <li
                key={c.id}
                style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 600 }}>{c.full_name || c.email}</div>
                  <div className="muted text-sm">
                    {COLLAB_KIND_LABEL[c.kind]}
                    {c.full_name && c.email ? ` · ${c.email}` : ''}
                  </div>
                </div>
                <PortalStatusChip status={c.status} />
                <button
                  className="linkish"
                  type="button"
                  style={{ marginLeft: 'auto' }}
                  onClick={() => setRevoking({ id: c.id, label: c.full_name || c.email })}
                >
                  Revoke access
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ConfirmDialog
        open={!!revoking}
        danger
        title="Revoke portal access?"
        confirmLabel="Revoke access"
        cancelLabel="Cancel"
        busy={revokeBusy}
        onCancel={() => !revokeBusy && setRevoking(null)}
        onConfirm={revoke}
      >
        <p className="m-0">
          {revoking?.label} will immediately lose access to this engagement's portal. You can re-invite
          them later with a new link.
        </p>
      </ConfirmDialog>
    </div>
  );
}
