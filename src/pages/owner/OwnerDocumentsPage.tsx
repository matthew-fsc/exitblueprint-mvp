import { useState } from 'react';
import { useOwnerContext } from '../../lib/owner';
import { useEngagementDocuments } from '../../lib/queries';
import { invokeFunctionBlob } from '../../lib/supabase';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines, useToast } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';

export default function OwnerDocumentsPage() {
  const { engagement, loading, isError, error, refetch } = useOwnerContext();
  const docsQ = useEngagementDocuments(engagement?.id);
  const docs = docsQ.data ?? [];
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (assessmentId: string) => {
    setBusy(assessmentId);
    try {
      const blob = await invokeFunctionBlob('render-owner-pdf', { assessment_id: assessmentId });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'exit-readiness-report.pdf';
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setBusy(null);
  };

  return (
    <div className="stack-lg">
      <PageHeader title="Documents" subtitle="The readiness reports your advisor has prepared for you." />
      {loading || docsQ.isLoading ? (
        <Card><SkeletonLines lines={5} /></Card>
      ) : isError || docsQ.isError ? (
        <ErrorState variant="section" error={error ?? docsQ.error} onRetry={refetch} />
      ) : docs.length === 0 ? (
        <EmptyState title="No reports yet">
          Your advisor hasn't shared a report yet. When they do, you'll be able to read and download it here.
        </EmptyState>
      ) : (
        <Card>
          <ul className="owner-doclist">
            {docs.map((d) => (
              <li key={d.id} className="owner-doc">
                <div className="owner-doc-head">
                  <span>
                    <strong>Exit Readiness Report</strong>
                    <span className="muted"> · {fmtDate(d.created_at)}</span>
                  </span>
                  <span className="owner-doc-actions">
                    <button className="btn-ghost" onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                      {openId === d.id ? 'Hide' : 'Read'}
                    </button>
                    <button onClick={() => download(d.assessment_id)} disabled={busy === d.assessment_id}>
                      {busy === d.assessment_id ? 'Preparing…' : 'Download PDF'}
                    </button>
                  </span>
                </div>
                {openId === d.id && (
                  <div className="owner-doc-body md-body">{renderMarkdown(d.content_md)}</div>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
