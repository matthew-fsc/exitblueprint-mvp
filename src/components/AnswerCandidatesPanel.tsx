import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction, supabase } from '../lib/supabase';
import { qk, useAnswerCandidates, type AnswerCandidateRow } from '../lib/queries';
import { Card, ErrorState, SkeletonLines } from './ui';
import { useAsyncAction } from '../lib/useAsyncAction';
import { humanizeKey } from '../lib/format';

// AI-proposed answers awaiting review (docs/sellside-ai WS-EXTRACT). Extraction
// reads a data-room document and PROPOSES candidate answers into a staging queue;
// nothing here has touched the score. This panel is the human gate: an advisor
// confirms a candidate (promoting it to a real assessment answer through the
// deterministic answer-writing path) or rejects it. The "AI draft — confirm to
// apply" framing is load-bearing: a candidate is never a scored answer until a
// person confirms it (CLAUDE.md rules 1 & 2).
function renderValue(v: unknown): string {
  if (v == null) return '—';
  if (Array.isArray(v)) return v.map((x) => renderValue(x)).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

export function AnswerCandidatesPanel({ engagementId }: { engagementId: string | undefined }) {
  const qc = useQueryClient();
  const { busy, run } = useAsyncAction();
  const listQ = useAnswerCandidates(engagementId);
  const candidates = listQ.data ?? [];

  const refresh = () =>
    engagementId ? qc.invalidateQueries({ queryKey: qk.answerCandidates(engagementId) }) : undefined;

  const confirm = async (c: AnswerCandidateRow) => {
    if (busy || !engagementId) return;
    const res = await run(() =>
      invokeFunction('confirm-answer-candidate', {
        engagement_id: engagementId,
        candidate_id: c.id,
      }),
    );
    if (res !== undefined) await refresh();
  };

  const reject = async (c: AnswerCandidateRow) => {
    if (busy) return;
    // Reject is a status flip on the staging row — the staff RLS policy allows it
    // directly; no answer is written, so it needs no server-authoritative path.
    const res = await run(async () => {
      const { error } = await supabase
        .from('answer_candidates')
        .update({ status: 'rejected' })
        .eq('id', c.id);
      if (error) throw new Error(error.message);
    });
    if (res !== undefined) await refresh();
  };

  if (listQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={4} />
      </Card>
    );
  }
  if (listQ.isError) return <ErrorState variant="inline" error={listQ.error} />;

  // Answer extraction has no advisor-facing trigger wired yet (docs/sellside-ai
  // WS-EXTRACT is a staging queue only). With no candidates there is nothing to
  // review, so the panel self-hides rather than showing an orphaned empty card
  // that tells the advisor to "run extraction" with no way to do so. It appears
  // the moment a candidate exists.
  if (candidates.length === 0) return null;

  return (
    <Card>
      <div className="cluster-between">
        <h3 className="card-title">Proposed answers to review</h3>
        <span className="status-chip status-neutral">AI draft — confirm to apply</span>
      </div>
      <p className="muted text-sm">
        Extracted from source documents as candidates. Confirming applies the value to the open
        assessment through the normal answer path; the score is only ever recomputed from confirmed
        answers.
      </p>

      <ul className="candidate-list">
          {candidates.map((c) => (
            <li key={c.id} className="candidate-row eb-list-row">
              <div className="candidate-main min-w-0">
                <div className="cluster-tight">
                  <span className="candidate-code">{humanizeKey(c.question_code)}</span>
                  {c.confidence != null && (
                    <span className="muted text-sm">{Math.round(c.confidence * 100)}% confidence</span>
                  )}
                </div>
                <div className="candidate-value break-anywhere">{renderValue(c.candidate_value)}</div>
                {c.source_span && (
                  <div className="muted text-sm break-anywhere">Source: “{c.source_span}”</div>
                )}
              </div>
              <div className="candidate-actions cluster-tight">
                <button
                  type="button"
                  className="button-link"
                  disabled={busy}
                  onClick={() => void confirm(c)}
                >
                  Confirm
                </button>
                <button
                  type="button"
                  className="button-link button-link-muted"
                  disabled={busy}
                  onClick={() => void reject(c)}
                >
                  Reject
                </button>
              </div>
            </li>
          ))}
        </ul>
    </Card>
  );
}
