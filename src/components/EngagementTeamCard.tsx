import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, isDevStack } from '../lib/supabase';
import { qk, useEngagementCollaborators, useOwnerProfile } from '../lib/queries';
import { ConfirmDialog, SectionCard, SkeletonLines, useToast } from './ui';

interface OwnerInviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  dev_password?: string;
}

interface CollaboratorInviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  kind: string;
  dev_password?: string;
}

const KIND_LABEL: Record<string, string> = {
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  advisor: 'Other advisor',
  other: 'Other',
};

// The engagement's deal team, assembled through the owner-portal invite workflow.
// The business owner gets their full portal; their outside advisors (CPA,
// attorney, …) get emailed a VIEW-ONLY link scoped to this engagement alone.
// Everyone lands in the same read-only portal — RLS decides what each can see.
export function EngagementTeamCard({
  engagementId,
  companyId,
}: {
  engagementId: string;
  companyId: string | undefined;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const ownerQ = useOwnerProfile(companyId);
  const owner = ownerQ.data;
  const collabsQ = useEngagementCollaborators(engagementId);

  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerInvited, setOwnerInvited] = useState<OwnerInviteResult | null>(null);

  const [collabName, setCollabName] = useState('');
  const [collabEmail, setCollabEmail] = useState('');
  const [collabKind, setCollabKind] = useState('cpa');
  const [collabBusy, setCollabBusy] = useState(false);
  const [collabInvited, setCollabInvited] = useState<CollaboratorInviteResult | null>(null);
  const [revoking, setRevoking] = useState<{ id: string; label: string } | null>(null);
  const [revokeBusy, setRevokeBusy] = useState(false);

  const inviteOwner = async (e: FormEvent) => {
    e.preventDefault();
    setOwnerBusy(true);
    try {
      const r = await invokeFunction<OwnerInviteResult>('invite-owner', {
        engagement_id: engagementId,
        email: ownerEmail,
        full_name: ownerName,
      });
      setOwnerInvited(r);
      setOwnerName('');
      setOwnerEmail('');
      qc.invalidateQueries({ queryKey: ['ownerProfile', companyId ?? ''] });
      toast.show(r.status === 'exists' ? 'Owner already has access' : 'Owner invited', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setOwnerBusy(false);
  };

  const inviteCollaborator = async (e: FormEvent) => {
    e.preventDefault();
    setCollabBusy(true);
    try {
      const r = await invokeFunction<CollaboratorInviteResult>('invite-collaborator', {
        engagement_id: engagementId,
        email: collabEmail,
        full_name: collabName,
        kind: collabKind,
      });
      setCollabInvited(r);
      setCollabName('');
      setCollabEmail('');
      qc.invalidateQueries({ queryKey: qk.engagementCollaborators(engagementId) });
      toast.show(r.status === 'exists' ? 'Already on this engagement' : 'View-only link sent', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setCollabBusy(false);
  };

  const revoke = async () => {
    if (!revoking) return;
    setRevokeBusy(true);
    try {
      await invokeFunction('revoke-collaborator', {
        engagement_id: engagementId,
        collaborator_id: revoking.id,
      });
      qc.invalidateQueries({ queryKey: qk.engagementCollaborators(engagementId) });
      toast.show('Access revoked', 'good');
      setRevoking(null);
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setRevokeBusy(false);
  };

  return (
    <SectionCard
      title="Deal team & portal access"
      subtitle="Give the owner their portal, and email a view-only link to their CPA, attorney, or other advisors — each scoped to this engagement only."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* ── Owner ─────────────────────────────────────────────────────────── */}
        <div>
          <div className="verif-head">
            <span className="stat-block-label">Business owner</span>
            {owner && <span className="verif-badge verif-tier-high">Invited</span>}
          </div>
          {ownerQ.isLoading ? (
            <SkeletonLines lines={2} />
          ) : owner ? (
            <p className="muted" style={{ marginTop: '0.4rem' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{owner.full_name ?? owner.email}</strong>
              {owner.full_name && owner.email ? ` · ${owner.email}` : ''} can sign in to the owner portal
              to see their score, plan, documents, and estimated value.
            </p>
          ) : (
            <>
              <p className="muted" style={{ margin: '0.4rem 0 0.9rem' }}>
                Invite the business owner to their own portal — a branded view of their readiness, the
                plan you've built, their documents, and their estimated value.
              </p>
              <form className="invite-form" onSubmit={inviteOwner}>
                <input placeholder="Owner name" value={ownerName} onChange={(e) => setOwnerName(e.target.value)} />
                <input type="email" placeholder="Owner email" value={ownerEmail} onChange={(e) => setOwnerEmail(e.target.value)} required />
                <button type="submit" disabled={ownerBusy}>{ownerBusy ? 'Inviting…' : 'Invite owner'}</button>
              </form>
              {ownerInvited && isDevStack && ownerInvited.dev_password && (
                <p className="invite-devnote">
                  Dev: <strong>{ownerInvited.email}</strong> can sign in now with password{' '}
                  <code>{ownerInvited.dev_password}</code>. (In production this sends a set-password email.)
                </p>
              )}
            </>
          )}
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: 0 }} />

        {/* ── View-only collaborators (CPA, attorney, …) ────────────────────── */}
        <div>
          <span className="stat-block-label">View-only collaborators</span>
          <p className="muted" style={{ margin: '0.4rem 0 0.9rem' }}>
            Email a read-only portal link to an outside advisor. They see this engagement's readiness,
            plan, documents, and value — nothing else, and can't change anything. Scoped to this
            engagement only.
          </p>

          {collabsQ.isLoading ? (
            <SkeletonLines lines={2} />
          ) : (collabsQ.data ?? []).length > 0 ? (
            <ul style={{ listStyle: 'none', margin: '0 0 0.9rem', padding: 0, display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {(collabsQ.data ?? []).map((c) => (
                <li
                  key={c.id}
                  style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', padding: 'var(--space-2) 0', borderBottom: '1px solid var(--border)' }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 600 }}>{c.full_name || c.email}</div>
                    {c.full_name && c.email && <div className="muted text-sm">{c.email}</div>}
                  </div>
                  <span className="status-chip status-neutral" style={{ marginLeft: 'auto' }}>
                    {KIND_LABEL[c.kind] ?? c.kind}
                  </span>
                  <span className={`verif-badge ${c.status === 'active' ? 'verif-tier-high' : 'verif-tier-mid'}`}>
                    {c.status === 'active' ? 'Active' : 'Invited'}
                  </span>
                  <button className="linkish" type="button" onClick={() => setRevoking({ id: c.id, label: c.full_name || c.email })}>
                    Revoke
                  </button>
                </li>
              ))}
            </ul>
          ) : null}

          <form className="collab-invite-form" onSubmit={inviteCollaborator}>
            <input placeholder="Name (optional)" value={collabName} onChange={(e) => setCollabName(e.target.value)} />
            <input type="email" placeholder="Email" value={collabEmail} onChange={(e) => setCollabEmail(e.target.value)} required />
            <select value={collabKind} onChange={(e) => setCollabKind(e.target.value)} aria-label="Collaborator type">
              <option value="cpa">CPA / accountant</option>
              <option value="attorney">Attorney</option>
              <option value="advisor">Other advisor</option>
              <option value="other">Other</option>
            </select>
            <button type="submit" disabled={collabBusy}>{collabBusy ? 'Sending…' : 'Send view-only link'}</button>
          </form>
          {collabInvited && isDevStack && collabInvited.dev_password && (
            <p className="invite-devnote">
              Dev: <strong>{collabInvited.email}</strong> can sign in now with password{' '}
              <code>{collabInvited.dev_password}</code> to the read-only portal. (In production this sends
              a portal invitation email.)
            </p>
          )}
        </div>
      </div>

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
    </SectionCard>
  );
}
