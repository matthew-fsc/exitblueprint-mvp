import { useEffect, useRef, useState, type Ref } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabase';
import {
  qk,
  useCompany,
  useEngagement,
  useDiligenceQaList,
  type DiligenceQa,
  type EvidenceRef,
} from '../lib/queries';
import {
  Card,
  EngagementNav,
  ErrorState,
  PageHeader,
  SkeletonLines,
} from '../components/ui';
import { useAsyncAction } from '../lib/useAsyncAction';
import { engagementCrumbs } from '../lib/nav';
import { fmtDate, humanizeKey } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

// Diligence Q&A — a persisted chat surface (docs/sellside-ai/05 §4). The advisor
// asks a buyer diligence question; the assistant answers from THIS engagement's
// own cited data. The conversation is the list of persisted diligence_qa turns
// (oldest → newest, like a chat), the composer is pinned at the bottom, and each
// answer's mode badge is the load-bearing UX: an 'ai' answer is an advisor-review
// draft; a 'retrieval_only' answer is the graceful-degradation state — the AI
// synthesis call failed / no credit, so the answer is the cited retrieved
// evidence, not a synthesis. Never legal or tax advice.

const SUGGESTED = [
  'How concentrated is customer revenue, and how diversified is the base?',
  'Walk me through revenue by year and the growth trend.',
  'How dependent is the business on the owner?',
  'What contracts are in place with key customers?',
  'How deep is the management team below the owner?',
];

export default function DiligenceQaPage() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const { busy, run } = useAsyncAction();

  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const companyName = companyQ.data?.name ?? 'Engagement';

  const listQ = useDiligenceQaList(engagementId);
  const turns = [...(listQ.data?.items ?? [])].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime(),
  );

  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null); // in-flight question
  const threadRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);

  // While a question is in flight, keep the "thinking" row in view at the bottom;
  // once an answer lands, bring the newest turn's TOP into view (the question +
  // start of the answer) rather than the very bottom — answers can be long.
  useEffect(() => {
    if (pending) {
      threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
    } else {
      lastTurnRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [turns.length, pending]);

  const ask = async (raw?: string) => {
    const q = (raw ?? question).trim();
    if (!q || busy || !engagementId) return;
    setQuestion('');
    setPending(q);
    const res = await run(() =>
      invokeFunction<{ qa: DiligenceQa }>('answer-diligence-question', {
        engagement_id: engagementId,
        question: q,
      }),
    );
    setPending(null);
    if (res === undefined) {
      setQuestion(q); // error already toasted — restore the draft so it isn't lost
      return;
    }
    await qc.invalidateQueries({ queryKey: qk.diligenceQa(engagementId) });
  };

  if (engagementQ.isLoading) return <Card><SkeletonLines lines={6} /></Card>;
  if (!engagement) {
    return (
      <ErrorState
        variant="section"
        title="Engagement not found"
        message="This engagement doesn’t exist or you don’t have access to it."
      />
    );
  }

  const empty = !listQ.isLoading && turns.length === 0 && !pending;

  return (
    <div className="page-shell qa-page">
      <header className="page-masthead">
        <PageHeader
          title="Diligence Q&A"
          crumbs={engagementCrumbs(engagementId, companyName, 'Diligence Q&A')}
          subtitle="Ask a buyer diligence question. Answers are drafted from this engagement's own verified facts, data room, and findings — every claim cited. Advisor-reviewed; not legal or tax advice."
        />
        <EngagementNav engagementId={engagementId!} />
      </header>

      <div className="qa-thread" ref={threadRef}>
        {listQ.isLoading && <SkeletonLines lines={5} />}
        {listQ.isError && <ErrorState variant="inline" error={listQ.error} />}

        {empty && (
          <div className="qa-empty">
            <p className="qa-empty-title">Rehearse the diligence conversation</p>
            <p className="muted">
              Ask the questions a buyer will ask. Every answer is grounded in this company's own
              data and cited back to the source. Try one:
            </p>
            <div className="qa-suggestions">
              {SUGGESTED.map((s) => (
                <button key={s} type="button" className="qa-chip" onClick={() => ask(s)} disabled={busy}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {turns.map((qa, i) => (
          <QaTurn key={qa.id} qa={qa} innerRef={i === turns.length - 1 ? lastTurnRef : undefined} />
        ))}

        {pending && (
          <div className="qa-turn">
            <div className="qa-ask">
              <div className="qa-bubble">{pending}</div>
            </div>
            <div className="qa-answer qa-answer-pending">
              <span className="qa-thinking">
                <span className="qa-dot" /><span className="qa-dot" /><span className="qa-dot" />
              </span>
              <span className="muted text-sm">Drafting a cited answer…</span>
            </div>
          </div>
        )}
      </div>

      <form
        className="qa-composer"
        onSubmit={(e) => {
          e.preventDefault();
          void ask();
        }}
      >
        <textarea
          className="qa-input"
          rows={1}
          placeholder="Ask a buyer diligence question…"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
          disabled={busy}
        />
        <button type="submit" className="qa-send" disabled={busy || question.trim() === ''}>
          {busy ? 'Asking…' : 'Ask'}
        </button>
      </form>
    </div>
  );
}

function QaTurn({ qa, innerRef }: { qa: DiligenceQa; innerRef?: Ref<HTMLDivElement> }) {
  const retrievalOnly = qa.mode === 'retrieval_only';
  return (
    <div className="qa-turn" ref={innerRef}>
      <div className="qa-ask">
        <div className="qa-bubble">{qa.question}</div>
      </div>
      <div className="qa-answer">
        <div className="qa-answer-head">
          <span className={`status-chip ${retrievalOnly ? 'status-warning' : 'status-neutral'}`}>
            {retrievalOnly ? 'Retrieval-only — AI synthesis unavailable' : 'AI draft — advisor review'}
          </span>
          <span className="muted text-sm">{fmtDate(qa.created_at)}</span>
        </div>
        <div className="report-body qa-answer-body">{renderMarkdown(qa.answer_md)}</div>
        {/* AI answers are prose with inline [cite_id] refs — the collapsible maps
            them to full citations. Retrieval-only answers already list the
            evidence in the body, so the collapsible would just duplicate it. */}
        {!retrievalOnly && qa.evidence.length > 0 && (
          <details className="qa-sources">
            <summary>{qa.evidence.length} cited source{qa.evidence.length === 1 ? '' : 's'}</summary>
            <div className="qa-sources-list">
              {qa.evidence.map((e, i) => (
                <EvidenceLine key={`${e.cite_id}-${i}`} evidence={e} />
              ))}
            </div>
          </details>
        )}
      </div>
    </div>
  );
}

function EvidenceLine({ evidence: e }: { evidence: EvidenceRef }) {
  return (
    <p className="qa-source muted text-sm">
      <span className="advisory-tag">{humanizeKey(e.source)}</span> {e.citation}
    </p>
  );
}
