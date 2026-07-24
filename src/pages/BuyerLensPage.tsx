import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabase';
import {
  qk,
  useCompany,
  useEngagement,
  useFiredAdvisory,
  useEngagementBuyerMatches,
  useMarketContext,
  useDiligenceQaList,
  // useDiligenceSimulation,  // Hidden for now — AI diligence simulator not production-ready yet
  type AdvisoryItemType,
  type FiredAdvisoryItem,
  type BuyerMatchRow,
  type MarketPassage,
  type DiligenceQa,
  type EvidenceRef,
  // type DiligenceFinding,  // Hidden for now — AI diligence simulator not production-ready yet
  // type DiligenceRemediation,
  // type DiligenceSourceKind,
} from '../lib/queries';
import {
  Card,
  Collapsible,
  EmptyState,
  EngagementNav,
  ErrorState,
  PageHeader,
  PageSection,
  SkeletonLines,
} from '../components/ui';
import { useAsyncAction } from '../lib/useAsyncAction';
import { advisorySevClass } from '../lib/severity';
import { engagementCrumbs } from '../lib/nav';
import { fmtDate, humanizeKey } from '../lib/format';
import { renderMarkdown } from '../lib/markdown';

// The three lenses, in the order an advisor walks an owner through them:
// what a buyer will ask, what to fix, and what diligence will otherwise find.
const SECTIONS: { type: AdvisoryItemType; label: string; blurb: string }[] = [
  {
    type: 'buyer_question',
    label: 'Questions a buyer will ask',
    blurb: 'Where the score is weak, expect these in management meetings. Rehearse the answer.',
  },
  {
    type: 'initiative',
    label: 'Value-creating initiatives',
    blurb: 'The moves that raise the score — and the multiple — before you go to market.',
  },
  {
    type: 'risk_flag',
    label: 'Red flags diligence will surface',
    blurb: 'Get ahead of these. A pre-cleared risk is a footnote; a discovered one is a discount.',
  },
];

// --- Diligence simulation (the proactive buyer lens) --------------------------
// Hidden for now — AI diligence simulator not production-ready yet.
// The entire simulator (SOURCE_LABEL, remediationHref, FindingCard,
// DiligenceSimulationPanel) is commented out below and its render call is
// removed from BuyerLensPage. Restore the imports above to bring it back.
/*
const SOURCE_LABEL: Record<DiligenceSourceKind, string> = {
  gap: 'Flagged gap',
  evidence: 'Missing evidence',
  buyer_question: 'Buyer question',
  untracked: 'Untracked metric',
};

function remediationHref(engagementId: string, r: DiligenceRemediation): string {
  switch (r.kind) {
    case 'evidence':
      return `/engagement/${engagementId}/evidence`;
    case 'roadmap':
      return `/engagement/${engagementId}/roadmap`;
    case 'plan':
      return '/plans';
    case 'library':
      return '/library';
  }
}

function FindingCard({ engagementId, finding }: { engagementId: string; finding: DiligenceFinding }) {
  const sev = advisorySevClass(finding.severity);
  return (
    <div className={`dsim-finding ${sev}`}>
      <div className="dsim-finding-head">
        <span className="dsim-finding-rank" aria-label={`rank ${finding.rank}`}>
          {finding.rank}
        </span>
        <span className={`sev-chip ${sev}`}>{finding.severity}</span>
        <div className="dsim-finding-titles">
          <p className="dsim-finding-title">{finding.title}</p>
          <p className="dsim-finding-meta muted">
            {finding.area} · {SOURCE_LABEL[finding.source_kind]}
          </p>
        </div>
      </div>
      <p className="dsim-finding-why">{finding.why}</p>
      {finding.remediation && (
        <p className="dsim-finding-fix">
          <span className="dsim-finding-fix-label">Where to close it:</span>{' '}
          <Link to={remediationHref(engagementId, finding.remediation)}>{finding.remediation.label} →</Link>
        </p>
      )}
    </div>
  );
}

function DiligenceSimulationPanel({ engagementId }: { engagementId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const simQ = useDiligenceSimulation(engagementId);
  const run = simQ.data?.run ?? null;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runSimulation = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await invokeFunction<{ assessment_id: string | null }>('simulate-diligence', {
        engagement_id: engagementId,
      });
      await qc.invalidateQueries({ queryKey: qk.diligenceSimulation(engagementId) });
      toast.show(
        res.assessment_id === null ? 'No completed assessment to simulate yet' : 'Diligence simulation complete',
        res.assessment_id === null ? 'default' : 'good',
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const ruleBased = (run?.model ?? '').startsWith('rule-based');

  return (
    <PageSection
      title={
        <>
          Diligence simulation <span className="muted">· rehearse the interrogation</span>
        </>
      }
      note="Runs the whole diligence process against the business today, ranked most severe first, while there is still time to fix what it surfaces. Findings are deterministic; the summary is a labeled draft."
    >
      {error && <ErrorState variant="inline" error={new Error(error)} />}

      <Card>
        <div className="dsim-toolbar">
          <div className="dsim-toolbar-status">
            {run ? (
              <>
                <span className={`status-chip status-${ruleBased ? 'neutral' : 'good'}`}>
                  {ruleBased ? 'Draft' : 'AI draft'}
                </span>
                <span className="muted">
                  {run.finding_count} finding{run.finding_count === 1 ? '' : 's'} · last run{' '}
                  {new Date(run.created_at).toLocaleString()}
                </span>
              </>
            ) : (
              <span className="muted">No simulation has been run for this engagement yet.</span>
            )}
          </div>
          <button onClick={runSimulation} disabled={busy}>
            {busy ? 'Simulating…' : run ? 'Re-run simulation' : 'Run diligence simulation'}
          </button>
        </div>

        {simQ.isLoading && <SkeletonLines lines={4} />}

        {simQ.data && !run && (
          <EmptyState title="No simulation yet">
            Complete a baseline assessment, then run the simulation to see the ranked blind spots a
            buyer's diligence team would surface.
          </EmptyState>
        )}

        {run && run.findings.length === 0 && (
          <EmptyState title="No blind spots surfaced">
            The last run found nothing flagged at the current scores, no financial input on self-report,
            and no fired buyer questions. Hold the position and assemble materials for scrutiny.
          </EmptyState>
        )}

        {run && run.findings.length > 0 && (
          <>
            <div className="dsim-findings">
              {run.findings.map((f) => (
                <FindingCard key={f.rank} engagementId={engagementId} finding={f} />
              ))}
            </div>
            <Collapsible title="Draft summary" hint="AI-assisted narrative framing, for advisor review">
              <div className="dsim-narrative report-body">{renderMarkdown(run.narrative_md)}</div>
            </Collapsible>
          </>
        )}
      </Card>
    </PageSection>
  );
}
*/

// --- Advisory (the reactive buyer lens) ---------------------------------------

function AdvisoryCard({ item }: { item: FiredAdvisoryItem }) {
  const hasDetail = !!(item.response_framework || item.data_needed);
  return (
    <div className={`advisory-item ${advisorySevClass(item.severity)}`}>
      <div className="advisory-item-head">
        <span className={`sev-chip ${advisorySevClass(item.severity)}`}>{item.severity ?? 'note'}</span>
        <div className="advisory-item-titles">
          <p className="advisory-item-title">{item.title}</p>
          <p className="advisory-item-body">{item.body}</p>
        </div>
        <span className="advisory-item-score" title="Live score vs. the trigger that fired this">
          {humanizeKey(item.governing_code)} {Number(item.governing_score)}
          <span className="muted"> / ≤{item.score_trigger}</span>
        </span>
      </div>
      {hasDetail && (
        <Collapsible title="Preparation" hint="How to prepare and what to have ready">
          <div className="advisory-item-detail">
            {item.response_framework && (
              <div>
                <span className="advisory-detail-label">
                  {item.item_type === 'buyer_question'
                    ? 'How to answer'
                    : item.item_type === 'risk_flag'
                      ? 'How to get ahead of it'
                      : 'How to run it'}
                </span>
                <p>{item.response_framework}</p>
              </div>
            )}
            {item.data_needed && (
              <div>
                <span className="advisory-detail-label">Documentation to have ready</span>
                <p>{item.data_needed}</p>
              </div>
            )}
          </div>
        </Collapsible>
      )}
    </div>
  );
}

// Ranked matches from the firm's OWN buyer book (deterministic — no AI). Blocked
// matches (an open dealbreaker gap, or the DRS floor unmet) are shown separately
// with the reason to clear, so the advisor sees the path: clear these gaps and
// the buyer opens.
function MatchedBuyersSection({ engagementId }: { engagementId: string }) {
  const matchesQ = useEngagementBuyerMatches(engagementId);
  const data = matchesQ.data;
  const open = (data?.matches ?? []).filter((m) => !m.blocked);
  const blocked = (data?.matches ?? []).filter((m) => m.blocked);

  return (
    <PageSection
      title="Matched buyers"
      note="Ranked from your own buyer book — deterministic, firm-private"
    >
      {matchesQ.isLoading && <SkeletonLines lines={4} />}
      {matchesQ.isError && <ErrorState variant="inline" error={matchesQ.error} />}
      {data && data.matches.length === 0 && (
        <EmptyState title="No buyer matches yet">
          Add buyers and their mandates in your{' '}
          <Link to="/buyers">buyer book</Link>, or this company doesn't yet fit any buyer's box. Matching
          ranks the firm's own book — it never reaches outside your firm.
        </EmptyState>
      )}
      {data && data.matches.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {open.length > 0 && (
            <Card>
              <div className="advisory-list">
                {open.map((m) => <BuyerMatchRowView key={m.mandateId} match={m} />)}
              </div>
            </Card>
          )}
          {blocked.length > 0 && (
            <div>
              <p className="muted text-sm" style={{ margin: '0 0 var(--space-2)' }}>
                Blocked — a fit once the gap clears or readiness reaches the floor:
              </p>
              <Card>
                <div className="advisory-list">
                  {blocked.map((m) => <BuyerMatchRowView key={m.mandateId} match={m} />)}
                </div>
              </Card>
            </div>
          )}
        </div>
      )}
    </PageSection>
  );
}

function BuyerMatchRowView({ match: m }: { match: BuyerMatchRow }) {
  return (
    <div className="eb-list-row" style={{ alignItems: 'flex-start', opacity: m.blocked ? 0.85 : 1 }}>
      <div className="eb-list-row-main" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
        <div style={{ fontWeight: 600 }}>{m.buyerName}</div>
        {m.factors.length > 0 && <span className="muted text-sm">{m.factors.join(' · ')}</span>}
        {m.blockers.map((b) => (
          <span key={b} className="text-sm" style={{ color: 'var(--danger, #b42318)' }}>⚠ {b}</span>
        ))}
      </div>
      <span className="status-chip status-neutral eb-list-row-push">score {m.score}</span>
      {m.blocked && <span className="status-chip status-warning">Blocked</span>}
    </div>
  );
}

// Directional market REFERENCE context (docs/sellside-ai/01): cited sector
// commentary and precedent-transaction passages the backend retrieves for this
// engagement's sector/size. Reference only — no scoring, no valuation. Every
// passage renders its citation next to the body (the source-score contract), so
// an advisor can put the figure in front of a buyer.
function MarketContextSection({ engagementId }: { engagementId: string }) {
  const marketQ = useMarketContext(engagementId);
  const passages = marketQ.data?.passages ?? [];

  return (
    <PageSection
      title="Market context"
      note="Directional market reference — sector commentary and precedent-transaction notes a sophisticated buyer will benchmark against. Context, not advice or a valuation."
    >
      {marketQ.isLoading && <SkeletonLines lines={4} />}
      {marketQ.isError && <ErrorState variant="inline" error={marketQ.error} />}
      {marketQ.data && passages.length === 0 && (
        <EmptyState icon="search" title="No market context yet">
          No market context available for this sector yet — directional reference data appears here
          once loaded.
        </EmptyState>
      )}
      {passages.length > 0 && (
        <Card>
          <div className="advisory-list">
            {passages.map((p, i) => (
              <MarketPassageView key={`${p.cite_id}-${i}`} passage={p} />
            ))}
          </div>
        </Card>
      )}
    </PageSection>
  );
}

function MarketPassageView({ passage: p }: { passage: MarketPassage }) {
  return (
    <div className="advisory-item">
      <div className="advisory-item-titles">
        <p className="advisory-item-title">
          <span className="advisory-tag">{humanizeKey(p.kind)}</span>
        </p>
        <p className="advisory-item-body">{p.body}</p>
        <p className="muted text-sm" style={{ margin: 'var(--space-1) 0 0' }}>
          Source: {p.citation}
        </p>
      </div>
    </div>
  );
}

// Diligence Q&A (docs/sellside-ai/05 §4): the advisor asks a buyer diligence
// question and gets a cited draft answer grounded in THIS engagement's own data.
// The mode badge is the load-bearing UX: an 'ai' answer is an advisor-review
// draft; a 'retrieval_only' answer is the graceful-degradation state (the AI
// synthesis call failed / no credit), still grounded in retrieved evidence but
// not synthesized — the warning chip makes that unmistakable.
function DiligenceQaSection({ engagementId }: { engagementId: string }) {
  const qc = useQueryClient();
  const { busy, run } = useAsyncAction();
  const [question, setQuestion] = useState('');

  const listQ = useDiligenceQaList(engagementId);
  const items = listQ.data?.items ?? [];

  const ask = async () => {
    const q = question.trim();
    if (!q) return;
    const res = await run(() =>
      invokeFunction<{ qa: DiligenceQa }>('answer-diligence-question', {
        engagement_id: engagementId,
        question: q,
      }),
    );
    if (res === undefined) return; // error already toasted
    await qc.invalidateQueries({ queryKey: qk.diligenceQa(engagementId) });
    setQuestion('');
  };

  return (
    <PageSection
      title="Diligence Q&A"
      note="Draft answers to buyer diligence questions, grounded in this engagement's own verified facts, data room, and findings — every claim cited. Advisor-reviewed; not legal or tax advice."
    >
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
          <textarea
            rows={2}
            placeholder="Ask a buyer diligence question — e.g. How concentrated is customer revenue?"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            disabled={busy}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <button onClick={ask} disabled={busy || question.trim() === ''}>
              {busy ? 'Asking…' : 'Ask'}
            </button>
          </div>
        </div>
      </Card>

      {listQ.isLoading && <SkeletonLines lines={4} />}
      {listQ.isError && <ErrorState variant="inline" error={listQ.error} />}
      {listQ.data && items.length === 0 && (
        <EmptyState title="No questions asked yet">
          No questions asked yet — ask a buyer diligence question above.
        </EmptyState>
      )}
      {items.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' }}>
          {[...items]
            .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
            .map((qa) => (
              <DiligenceQaCard key={qa.id} qa={qa} />
            ))}
        </div>
      )}
    </PageSection>
  );
}

function DiligenceQaCard({ qa }: { qa: DiligenceQa }) {
  const retrievalOnly = qa.mode === 'retrieval_only';
  return (
    <Card>
      <div className="advisory-item-head" style={{ alignItems: 'flex-start' }}>
        <div className="advisory-item-titles">
          <p className="advisory-item-title" style={{ fontWeight: 600 }}>
            {qa.question}
          </p>
          <p className="muted text-sm" style={{ margin: 'var(--space-1) 0 0' }}>
            {fmtDate(qa.created_at)}
          </p>
        </div>
        <span
          className={`status-chip ${retrievalOnly ? 'status-warning' : 'status-neutral'} eb-list-row-push`}
        >
          {retrievalOnly ? 'Retrieval-only — AI synthesis unavailable' : 'AI draft — advisor review'}
        </span>
      </div>
      <div className="report-body" style={{ marginTop: 'var(--space-2)' }}>
        {renderMarkdown(qa.answer_md)}
      </div>
      {qa.evidence.length > 0 && (
        <div style={{ marginTop: 'var(--space-2)' }}>
          {qa.evidence.map((e, i) => (
            <EvidenceLine key={`${e.cite_id}-${i}`} evidence={e} />
          ))}
        </div>
      )}
    </Card>
  );
}

function EvidenceLine({ evidence: e }: { evidence: EvidenceRef }) {
  return (
    <p className="muted text-sm" style={{ margin: 'var(--space-1) 0 0' }}>
      <span className="advisory-tag">{humanizeKey(e.source)}</span> Source: {e.citation}
    </p>
  );
}

export default function BuyerLensPage() {
  const { engagementId } = useParams();
  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const firedQ = useFiredAdvisory(engagementId);

  const companyName = companyQ.data?.name ?? 'Engagement';
  const result = firedQ.data;

  const byType = useMemo(() => {
    const m = new Map<AdvisoryItemType, FiredAdvisoryItem[]>();
    for (const it of result?.items ?? []) {
      const list = m.get(it.item_type) ?? [];
      list.push(it);
      m.set(it.item_type, list);
    }
    return m;
  }, [result]);

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Buyer lens"
          crumbs={engagementCrumbs(engagementId, companyName, 'Buyer lens')}
          subtitle="Buyer-facing risks derived from the latest assessment, most critical first."
          actions={
            <Link className="button-link" to="/library">
              Advisory library →
            </Link>
          }
        />
        <EngagementNav engagementId={engagementId!} />
      </header>

      {engagementId && <MatchedBuyersSection engagementId={engagementId} />}

      {engagementId && <MarketContextSection engagementId={engagementId} />}

      {engagementId && <DiligenceQaSection engagementId={engagementId} />}

      {/* Hidden for now — AI diligence simulator not production-ready yet */}
      {/* {engagementId && <DiligenceSimulationPanel engagementId={engagementId} />} */}

      {firedQ.isLoading && <SkeletonLines lines={6} />}
      {firedQ.isError && <ErrorState variant="inline" error={firedQ.error} />}

      {result && result.assessment_id === null && (
        <EmptyState title="No completed assessment yet">
          Complete a baseline assessment to see the buyer questions, initiatives, and risk flags it
          surfaces.
        </EmptyState>
      )}

      {result && result.assessment_id !== null && result.items.length === 0 && (
        <EmptyState title="No active triggers">
          No risk trigger is met at the current scores — a strong signal of readiness.
        </EmptyState>
      )}

      {result && result.items.length > 0 && (
        <>
          <PageSection title="How buyers will read this" note="Live counts from the latest assessment">
            <div className="advisory-summary">
              <span className="advisory-summary-stat">
                <strong>{result.counts.critical}</strong> critical
              </span>
              <span className="advisory-summary-stat">
                <strong>{result.counts.high}</strong> high
              </span>
              <span className="advisory-summary-sep" aria-hidden />
              <span className="muted">
                {result.counts.buyer_question} buyer questions · {result.counts.initiative} initiatives ·{' '}
                {result.counts.risk_flag} risk flags
              </span>
            </div>
          </PageSection>

          {SECTIONS.map((s) => {
            const items = byType.get(s.type) ?? [];
            if (items.length === 0) return null;
            return (
              <PageSection
                key={s.type}
                title={
                  <>
                    {s.label} <span className="muted">· {items.length}</span>
                  </>
                }
                note={s.blurb}
              >
                <Card>
                  <div className="advisory-list">
                    {items.map((it) => (
                      <AdvisoryCard key={it.id} item={it} />
                    ))}
                  </div>
                </Card>
              </PageSection>
            );
          })}
        </>
      )}
    </div>
  );
}
