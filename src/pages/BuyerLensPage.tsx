import { useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  useCompany,
  useEngagement,
  useFiredAdvisory,
  type AdvisoryItemType,
  type FiredAdvisoryItem,
} from '../lib/queries';
import { Card, EmptyState, PageHeader, SkeletonLines } from '../components/ui';

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

function sevClass(sev: string | null): string {
  switch (sev) {
    case 'critical':
      return 'sev-critical';
    case 'high':
      return 'sev-high';
    case 'med':
      return 'sev-med';
    default:
      return 'sev-low';
  }
}

function AdvisoryCard({ item }: { item: FiredAdvisoryItem }) {
  const [open, setOpen] = useState(false);
  const hasDetail = !!(item.response_framework || item.data_needed);
  return (
    <div className={`advisory-item ${sevClass(item.severity)}`}>
      <div className="advisory-item-head">
        <span className={`sev-chip ${sevClass(item.severity)}`}>{item.severity ?? 'note'}</span>
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
        <button className="advisory-item-toggle" onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide preparation' : 'Show preparation'}
        </button>
      )}
      {open && (
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
    <div className="stack-lg">
      <PageHeader
        title="Buyer lens"
        crumbs={[
          { label: 'Portfolio', to: '/' },
          { label: companyName, to: `/engagement/${engagementId}` },
          { label: 'Buyer lens' },
        ]}
        subtitle="What the latest assessment tells a buyer — surfaced from the live score, most critical first."
        actions={
          <Link className="button-link" to="/library">
            Advisory library →
          </Link>
        }
      />

      {firedQ.isLoading && <SkeletonLines lines={6} />}
      {firedQ.isError && <p className="form-error">{(firedQ.error as Error).message}</p>}

      {result && result.assessment_id === null && (
        <EmptyState title="No completed assessment yet">
          Complete a baseline assessment to see the buyer questions, initiatives, and risk flags it
          surfaces.
        </EmptyState>
      )}

      {result && result.assessment_id !== null && result.items.length === 0 && (
        <EmptyState title="Nothing is firing">
          No catalog item's trigger is met at the current scores — a strong signal of readiness.
        </EmptyState>
      )}

      {result && result.items.length > 0 && (
        <>
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

          {SECTIONS.map((s) => {
            const items = byType.get(s.type) ?? [];
            if (items.length === 0) return null;
            return (
              <section key={s.type}>
                <h3 className="section-heading">
                  {s.label} <span className="muted">· {items.length}</span>
                </h3>
                <p className="muted" style={{ marginTop: '-0.35rem' }}>
                  {s.blurb}
                </p>
                <Card>
                  <div className="advisory-list">
                    {items.map((it) => (
                      <AdvisoryCard key={it.id} item={it} />
                    ))}
                  </div>
                </Card>
              </section>
            );
          })}
        </>
      )}
    </div>
  );
}
