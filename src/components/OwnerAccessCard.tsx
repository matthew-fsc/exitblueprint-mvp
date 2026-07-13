import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, isDevStack } from '../lib/supabase';
import { useOwnerProfile } from '../lib/queries';
import { Card, SkeletonLines, useToast } from './ui';

interface InviteResult {
  status: 'invited' | 'exists';
  email: string;
  full_name: string | null;
  dev_password?: string;
}

// Advisor-facing owner access: see whether the client's owner has portal access,
// and invite them if not. The invite creates the owner login + profile so they
// can sign in and see their score, plan, documents, and value.
export function OwnerAccessCard({
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

  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [invited, setInvited] = useState<InviteResult | null>(null);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await invokeFunction<InviteResult>('invite-owner', {
        engagement_id: engagementId,
        email,
        full_name: name,
      });
      setInvited(r);
      setName('');
      setEmail('');
      qc.invalidateQueries({ queryKey: ['ownerProfile', companyId ?? ''] });
      toast.show(r.status === 'exists' ? 'Owner already has access' : 'Owner invited', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setBusy(false);
  };

  return (
    <Card>
      <div className="verif-head">
        <span className="stat-block-label">Owner access</span>
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
          <form className="invite-form" onSubmit={invite}>
            <input placeholder="Owner name" value={name} onChange={(e) => setName(e.target.value)} />
            <input type="email" placeholder="Owner email" value={email} onChange={(e) => setEmail(e.target.value)} required />
            <button type="submit" disabled={busy}>{busy ? 'Inviting…' : 'Invite owner'}</button>
          </form>
          {invited && isDevStack && invited.dev_password && (
            <p className="invite-devnote">
              Dev: <strong>{invited.email}</strong> can sign in now with password{' '}
              <code>{invited.dev_password}</code>. (In production this sends a set-password email.)
            </p>
          )}
        </>
      )}
    </Card>
  );
}
