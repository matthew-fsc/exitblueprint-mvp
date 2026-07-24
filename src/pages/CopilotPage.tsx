import { useEffect, useRef, useState, type Ref } from 'react';
import { askAdvisorCopilot, type CopilotResult } from '../lib/queries';
import { PageHeader } from '../components/ui';
import { useAsyncAction } from '../lib/useAsyncAction';
import { fmtDate, humanizeKey } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

// Advisor copilot (WS-COPILOT) — a firm-level chat surface. The advisor asks a
// natural-language question about their OWN book ("what needs my attention", "how
// accurate have our predictions been"); the server runs a bounded, READ-ONLY
// Anthropic tool-use loop over curated read functions and returns a draft answer
// grounded entirely in tool results. v1 is STATELESS: the conversation lives in this
// component's local state, nothing is persisted. The mode badge is the load-bearing
// UX: an 'ai' answer is an advisor-review draft; an 'unavailable' answer is the
// graceful-degradation state (AI synthesis failed / no credit) showing the raw tool
// results. Never legal, tax, or accounting advice.

const SUGGESTED = [
  'What needs my attention across the firm right now?',
  'How accurate have our valuation predictions been on closed deals?',
  'Which gap fixes have moved the DRS the most across our engagements?',
  'Which engagements are stalled or overdue for reassessment?',
];

interface Turn {
  id: string;
  question: string;
  result: CopilotResult;
}

export default function CopilotPage() {
  const { busy, run } = useAsyncAction();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [question, setQuestion] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const lastTurnRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (pending) {
      threadRef.current?.scrollTo({ top: threadRef.current.scrollHeight, behavior: 'smooth' });
    } else {
      lastTurnRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  }, [turns.length, pending]);

  const ask = async (raw?: string) => {
    const q = (raw ?? question).trim();
    if (!q || busy) return;
    setQuestion('');
    setPending(q);
    const result = await run(() => askAdvisorCopilot(q));
    setPending(null);
    if (result === undefined) {
      setQuestion(q); // error already toasted — restore the draft
      return;
    }
    setTurns((prev) => [...prev, { id: `${Date.now()}`, question: q, result }]);
  };

  const empty = turns.length === 0 && !pending;

  return (
    <div className="page-shell qa-page">
      <header className="page-masthead">
        <PageHeader
          title="Copilot"
          crumbs={[{ label: 'Copilot' }]}
          subtitle="Ask about your firm's book in plain language. Answers are drafted from your own read-only data — attention worklist, deal calibration, and remediation effectiveness — every figure traced to the source. Advisor-reviewed; not legal, tax, or accounting advice."
        />
      </header>

      <div className="qa-thread" ref={threadRef}>
        {empty && (
          <div className="qa-empty">
            <p className="qa-empty-title">Ask across your engagements</p>
            <p className="muted">
              The copilot reads your firm's own data and answers in plain language. It never
              changes anything and never invents a number. Try one:
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

        {turns.map((turn, i) => (
          <CopilotTurn
            key={turn.id}
            turn={turn}
            innerRef={i === turns.length - 1 ? lastTurnRef : undefined}
          />
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
              <span className="muted text-sm">Consulting your firm data…</span>
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
          placeholder="Ask about your firm's engagements…"
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

function CopilotTurn({ turn, innerRef }: { turn: Turn; innerRef?: Ref<HTMLDivElement> }) {
  const { result } = turn;
  const unavailable = result.mode === 'unavailable';
  return (
    <div className="qa-turn" ref={innerRef}>
      <div className="qa-ask">
        <div className="qa-bubble">{turn.question}</div>
      </div>
      <div className="qa-answer">
        <div className="qa-answer-head">
          <span className={`status-chip ${unavailable ? 'status-warning' : 'status-neutral'}`}>
            {unavailable ? 'Raw tool results — AI synthesis unavailable' : 'AI draft — advisor review'}
          </span>
          <span className="muted text-sm">{fmtDate(new Date().toISOString())}</span>
        </div>
        <div className="report-body qa-answer-body">{renderMarkdown(result.answer_md)}</div>
        {result.tool_calls.length > 0 && (
          <p className="qa-source muted text-sm">
            <span className="advisory-tag">Consulted</span>{' '}
            {[...new Set(result.tool_calls.map((c) => humanizeKey(c.name)))].join(' · ')}
          </p>
        )}
      </div>
    </div>
  );
}
