import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabase';
import { qk } from '../lib/queries';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines } from '../components/ui';

interface QueueItem {
  document_id: string;
  engagement_id: string;
  company_name: string;
  original_filename: string;
  category: string | null;
  field_count: number;
  created_at: string;
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
