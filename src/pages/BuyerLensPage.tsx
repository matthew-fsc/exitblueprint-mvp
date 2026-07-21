import { useMemo } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useCompany,
  useEngagement,
  useFiredAdvisory,
  type AdvisoryItemType,
  type FiredAdvisoryItem,
} from '../lib/queries';
import { Card, Collapsible, EmptyState, EngagementNav, ErrorState, PageHeader, PageSection, SkeletonLines } from '../components/ui';
import { advisorySevClass } from '../lib/severity';
import { engagementCrumbs } from '../lib/nav';

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
          {item.governing_code} {Number(item.governing_score)}
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
