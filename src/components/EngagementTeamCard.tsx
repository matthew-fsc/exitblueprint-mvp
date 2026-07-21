import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, isDevStack } from '../lib/supabase';
import { useOwnerProfile } from '../lib/queries';
import { SectionCard, SkeletonLines, useToast } from './ui';
import { EngagementProfessionalsCard } from './EngagementProfessionalsCard';

interface OwnerInviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  dev_password?: string;
}

// The engagement's external people, on ONE surface: the business owner at the
// top (their full owner portal), then the "professionals on this deal" roster
// drawn from the firm directory. Granting a professional a view-only portal
// login is an optional action on their roster row (see EngagementProfessionalsCard);
// there is no separate "collaborators" concept. Everyone with a login lands in
// the same read-only portal — RLS decides what each can see.
export function EngagementTeamCard({
  engagementId,
  companyId,
  firmId,
}: {
  engagementId: string;
  companyId: string | undefined;
  firmId: string;
}) {
  const qc = useQueryClient();
  const toast = useToast();

  const ownerQ = useOwnerProfile(companyId);
  const owner = ownerQ.data;

  const [ownerName, setOwnerName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerBusy, setOwnerBusy] = useState(false);
  const [ownerInvited, setOwnerInvited] = useState<OwnerInviteResult | null>(null);

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

  return (
    <SectionCard
      title="External people"
      subtitle="The business owner and the outside professionals on this deal. The owner gets their own portal; any professional can optionally be granted a view-only portal login scoped to this engagement."
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-5)' }}>
        {/* ── Business owner ────────────────────────────────────────────────── */}
        <div>
          <div className="verif-head">
            <span className="stat-block-label">Business owner</span>
            {owner && <span className="status-chip status-good">Invited</span>}
          </div>
          {ownerQ.isLoading ? (
            <SkeletonLines lines={2} />
          ) : owner ? (
            <p className="muted" style={{ marginTop: 'var(--space-1)' }}>
              <strong style={{ color: 'var(--text-primary)' }}>{owner.full_name ?? owner.email}</strong>
              {owner.full_name && owner.email ? ` · ${owner.email}` : ''} can sign in to the owner portal
              to see their score, plan, documents, and estimated value.
            </p>
          ) : (
            <>
              <p className="muted" style={{ margin: 'var(--space-1) 0 var(--space-3)' }}>
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

        {/* ── Professionals on this deal (+ optional portal access per row) ──── */}
        <EngagementProfessionalsCard engagementId={engagementId} firmId={firmId} />
      </div>
    </SectionCard>
  );
}
