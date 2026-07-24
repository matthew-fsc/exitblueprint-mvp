import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, isDevStack } from '../lib/supabase';
import { useCompany, useOwnerProfile } from '../lib/queries';
import { useAsyncAction } from '../lib/useAsyncAction';

interface ShareResult {
  status: 'shared';
  shared_at: string;
  invite: { status: 'invited' | 'exists'; email: string; full_name: string | null; dev_password?: string };
}

// Advisor action: send an in-progress assessment to the business owner. If the
// company has no owner login yet, this invites them (name/email, prefilled from the
// company's owner contact) AND shares in one step; if an owner already exists, it's
// a single-click share. Once shared, it renders the state chips instead
// ("Shared with client" / "Client submitted — ready for review"). The owner then
// fills the questionnaire in their portal; scoring stays advisor-only.
export function SendToClientButton({
  assessmentId,
  companyId,
  sharedAt,
  submittedAt,
}: {
  assessmentId: string;
  companyId: string | undefined;
  sharedAt: string | null;
  submittedAt: string | null;
}) {
  const qc = useQueryClient();
  const { busy, run } = useAsyncAction();
  const ownerQ = useOwnerProfile(companyId);
  const companyQ = useCompany(companyId);
  const owner = ownerQ.data;

  const [expanded, setExpanded] = useState(false);
  const [email, setEmail] = useState('');
  const [devNote, setDevNote] = useState<ShareResult['invite'] | null>(null);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['assessment', 'active', assessmentId] });
    qc.invalidateQueries({ queryKey: ['assessments', 'byEngagement'] });
    qc.invalidateQueries({ queryKey: ['ownerProfile', companyId ?? ''] });
  };

  // Already shared → show state, nothing to do.
  if (sharedAt) {
    return (
      <span className="cluster" style={{ gap: 'var(--space-2)' }}>
        <span className="status-chip status-neutral">Shared with client</span>
        {submittedAt && <span className="status-chip status-good">Client submitted — ready for review</span>}
      </span>
    );
  }

  const share = (body: Record<string, unknown>) =>
    run(() => invokeFunction<ShareResult>('share-assessment-with-client', body), {
      success: 'Assessment sent to client',
    }).then((r) => {
      if (!r) return;
      setExpanded(false);
      setEmail('');
      if (isDevStack && r.invite.dev_password) setDevNote(r.invite);
      invalidate();
    });

  // Owner already has a login → one-click share.
  if (owner) {
    return (
      <button className="btn-secondary" disabled={busy} onClick={() => share({ assessment_id: assessmentId })}>
        {busy ? 'Sending…' : 'Send to client'}
      </button>
    );
  }

  // No owner yet → collect just the client's email (their name comes from the
  // company contact) and invite + share together, all on one row.
  const submit = (e: FormEvent) => {
    e.preventDefault();
    void share({
      assessment_id: assessmentId,
      full_name: companyQ.data?.owner_contact_name || null,
      email: email || companyQ.data?.owner_contact_email || '',
    });
  };

  if (!expanded) {
    return (
      <div className="stack-sm">
        <button
          className="btn-secondary"
          disabled={busy || ownerQ.isLoading}
          onClick={() => {
            setEmail(companyQ.data?.owner_contact_email ?? '');
            setExpanded(true);
          }}
        >
          Send to client
        </button>
        {devNote && isDevStack && devNote.dev_password && (
          <p className="invite-devnote">
            Dev: <strong>{devNote.email}</strong> can sign in now with password <code>{devNote.dev_password}</code>.
          </p>
        )}
      </div>
    );
  }

  return (
    <form className="stc-form" onSubmit={submit}>
      <input
        type="email"
        placeholder="Client email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        aria-label="Client email"
        autoFocus
        required
      />
      <button type="submit" disabled={busy}>
        {busy ? 'Sending…' : 'Invite & send'}
      </button>
      <button type="button" className="btn-ghost" disabled={busy} onClick={() => setExpanded(false)}>
        Cancel
      </button>
    </form>
  );
}
