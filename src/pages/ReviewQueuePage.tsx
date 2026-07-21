import { Link } from 'react-router-dom';
import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from '../lib/supabase';
import { qk } from '../lib/queries';
import { humanizeKey, formatFieldValue } from '../lib/format';
import { Card, EmptyState, ErrorState, PageHeader, SectionCard, SkeletonLines } from '../components/ui';

interface QueueItem {
  document_id: string;
  engagement_id: string;
  company_name: string;
  original_filename: string;
  category: string | null;
  field_count: number;
  created_at: string;
}

// ── Unified per-engagement review surface (Evidence "Review" tab) ─────────────
// Review used to be fragmented across three places: the firm-wide /review page
// (documents in_review), and the VerificationPanel's inline review_items queue.
// This panel brings BOTH pending queues for ONE engagement into a single typed
// list, each row linking to its EXISTING resolution UI — a document review to its
// /review/:id detail, a reconciliation/finding review_item to the Verification
// tab where its inline resolve controls live. Presentation-level only: the two
// tables (documents, review_items) are NOT merged (that remains deferred — a
// genuine merge needs schema/server work); this reuses the existing reads.
interface PendingDoc {
  id: string;
  original_filename: string;
  category: string | null;
  status: string;
}
interface PendingReviewItem {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
}

// Shares the Documents tab cache key (qk.sourceDocuments); filtered to in_review.
function usePendingDocReviews(engagementId: string | undefined): UseQueryResult<PendingDoc[]> {
  return useQuery({
    queryKey: qk.sourceDocuments(engagementId ?? ''),
    enabled: !!engagementId,
    select: (rows: PendingDoc[]) => rows.filter((d) => d.status === 'in_review'),
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, original_filename, category, status, scan_status, created_at')
        .eq('engagement_id', engagementId!)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data as PendingDoc[]) ?? [];
    },
  });
}

// Shares the Verification tab cache key (qk.engagementReviewItems).
function usePendingReviewItems(
  engagementId: string | undefined,
): UseQueryResult<PendingReviewItem[]> {
  return useQuery({
    queryKey: qk.engagementReviewItems(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_items')
        .select('id, type, payload, status')
        .eq('engagement_id', engagementId!)
        .in('status', ['pending', 'in_review', 'escalated'])
        .order('created_at');
      if (error) throw new Error(error.message);
      return (data as PendingReviewItem[]) ?? [];
    },
  });
}

const REVIEW_ITEM_TYPE_LABEL: Record<string, string> = {
  conflict: 'Conflict',
  low_confidence_extraction: 'Low confidence',
  finding_approval: 'Finding approval',
  report_signoff: 'Report sign-off',
};

export function ReviewPanel({ engagementId }: { engagementId: string | undefined }) {
  const docsQ = usePendingDocReviews(engagementId);
  const itemsQ = usePendingReviewItems(engagementId);

  const docs = docsQ.data ?? [];
  const items = itemsQ.data ?? [];
  const loading = docsQ.isLoading || itemsQ.isLoading;
  const total = docs.length + items.length;
  const verificationTo = `/engagement/${engagementId}/evidence/verification`;

  return (
    <div className="stack-lg">
      <SectionCard
        title="Review"
        subtitle="Everything awaiting a reviewer for this engagement — uploaded documents and reconciliation / finding decisions — in one place. Each opens its existing resolution view."
      >
        {loading ? (
          <SkeletonLines lines={4} />
        ) : docsQ.error || itemsQ.error ? (
          <ErrorState variant="section" error={docsQ.error || itemsQ.error} />
        ) : total === 0 ? (
          <EmptyState title="Queue is clear" icon="check">
            Nothing awaiting review. Uploaded documents and verification conflicts appear here.
          </EmptyState>
        ) : (
          <ul className="review-queue">
            {docs.map((d) => (
              <li key={`doc-${d.id}`} className="review-queue-row">
                <div className="review-queue-main">
                  <span className="doc-name">
                    <span className="status-chip status-neutral review-queue-flag">Document</span>
                    {d.original_filename}
                  </span>
                  <span className="doc-meta">
                    Uploaded document awaiting field confirmation
                    {d.category ? ` · ${humanizeKey(d.category)}` : ''}
                  </span>
                </div>
                <Link className="button-link" to={`/review/${d.id}`}>
                  Review →
                </Link>
              </li>
            ))}
            {items.map((it) => {
              const isRecon =
                it.type === 'conflict' || it.type === 'low_confidence_extraction';
              return (
                <li key={`item-${it.id}`} className="review-queue-row">
                  <div className="review-queue-main">
                    <span className="doc-name">
                      <span className="status-chip status-neutral review-queue-flag">
                        {REVIEW_ITEM_TYPE_LABEL[it.type] ?? humanizeKey(it.type)}
                      </span>
                      {isRecon
                        ? humanizeKey((it.payload.field_key as string) ?? 'Field')
                        : humanizeKey((it.payload.pattern_key as string) ?? 'Finding')}
                      {it.status === 'escalated' && (
                        <span className="status-chip status-warning review-queue-flag">
                          Escalated
                        </span>
                      )}
                    </span>
                    <span className="doc-meta">
                      {isRecon
                        ? `self-reported ${formatFieldValue(
                            it.payload.field_key as string,
                            it.payload.self_reported,
                          )} vs document ${formatFieldValue(
                            it.payload.field_key as string,
                            it.payload.verified,
                          )}`
                        : 'Buy-side finding awaiting approval'}
                    </span>
                  </div>
                  <Link className="button-link" to={verificationTo}>
                    Resolve →
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>
    </div>
  );
}

export default function ReviewQueuePage() {
  const queueQ = useQuery({
    queryKey: qk.reviewQueue(),
    queryFn: async () => {
      const r = await invokeFunction<{ items: QueueItem[] }>('list-review-queue', {});
      return r.items;
    },
  });

  const items = queueQ.data ?? [];

  return (
    <div className="stack-lg">
      <PageHeader
        title="Review queue"
        subtitle="Confirm extracted values against the source document before they become verified facts."
      />

      {queueQ.isLoading ? (
        <Card>
          <SkeletonLines lines={5} />
        </Card>
      ) : queueQ.error ? (
        <ErrorState variant="section" error={queueQ.error} onRetry={() => void queueQ.refetch()} />
      ) : items.length === 0 ? (
        <EmptyState title="Queue is clear" icon="check">
          Nothing awaiting review. Uploaded documents appear here for confirmation.
        </EmptyState>
      ) : (
        <ul className="review-queue">
          {items.map((it) => (
            <li key={it.document_id} className="review-queue-row">
              <div className="review-queue-main">
                <span className="doc-name">{it.original_filename}</span>
                <span className="doc-meta">
                  {it.company_name}
                  {it.category ? ` · ${it.category}` : ''} · {it.field_count} field
                  {it.field_count === 1 ? '' : 's'}
                </span>
              </div>
              <Link className="button-link" to={`/review/${it.document_id}`}>
                Review →
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
