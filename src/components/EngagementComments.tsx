import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import { fmtDate } from '../lib/format';
import { qkEngagementComments, useEngagementComments } from '../lib/queries';
import { SectionCard, SkeletonLines, EmptyState, ErrorState } from './ui';

// A shared comment thread on an engagement — the one thing an external
// collaborator can WRITE (see 20260721001500). Firm staff, the engagement's
// owner, and its collaborators all read and post here; RLS scopes each to the
// engagement they can already see. Rendered on the advisor engagement page and
// in the owner/collaborator portal.

const ROLE_LABEL: Record<string, string> = {
  admin: 'Advisor',
  advisor: 'Advisor',
  reviewer: 'Reviewer',
  owner: 'Owner',
  collaborator: 'Collaborator',
};

export function EngagementComments({ engagementId }: { engagementId: string | undefined }) {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const { busy, run } = useAsyncAction();
  const commentsQ = useEngagementComments(engagementId);
  const comments = commentsQ.data ?? [];
  const [body, setBody] = useState('');

  const canPost = !!engagementId && !!profile?.firm_id;

  const post = () =>
    run(
      async () => {
        if (!engagementId || !profile?.firm_id) throw new Error('Not ready.');
        const text = body.trim();
        if (!text) throw new Error('Write a message first.');
        const { error } = await supabase.from('engagement_comments').insert({
          firm_id: profile.firm_id,
          engagement_id: engagementId,
          author_profile_id: profile.id,
          author_name: profile.full_name || profile.email,
          author_role: profile.role,
          body: text,
        });
        if (error) throw new Error(error.message);
        setBody('');
        qc.invalidateQueries({ queryKey: qkEngagementComments(engagementId) });
      },
      { success: 'Comment posted' },
    );

  return (
    <SectionCard
      title="Discussion"
      subtitle="A shared thread for everyone on this engagement — you, the owner, and any invited advisors."
    >
      {commentsQ.isLoading ? (
        <SkeletonLines lines={3} />
      ) : commentsQ.isError ? (
        <ErrorState variant="inline" error={commentsQ.error} />
      ) : comments.length === 0 ? (
        <EmptyState title="No comments yet">Start the conversation below.</EmptyState>
      ) : (
        <ul className="comment-thread">
          {comments.map((c) => (
            <li key={c.id} className="comment">
              <div className="comment-head">
                <span className="comment-author">{c.author_name || 'Someone'}</span>
                {c.author_role && <span className="comment-role">{ROLE_LABEL[c.author_role] ?? c.author_role}</span>}
                <span className="comment-date muted">{fmtDate(c.created_at)}</span>
              </div>
              <p className="comment-body">{c.body}</p>
            </li>
          ))}
        </ul>
      )}

      {canPost && (
        <div className="comment-composer">
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            rows={2}
            placeholder="Write a comment…"
            aria-label="Write a comment"
          />
          <div className="control-row" style={{ justifyContent: 'flex-end', marginTop: 'var(--space-2)' }}>
            <button onClick={post} disabled={busy || !body.trim()}>
              {busy ? 'Posting…' : 'Post comment'}
            </button>
          </div>
        </div>
      )}
    </SectionCard>
  );
}
