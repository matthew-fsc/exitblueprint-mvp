import { useState } from 'react';
import { useOwnerContext } from '../../lib/owner';
import { useEngagementDocuments } from '../../lib/queries';
import { downloadDocumentPdf } from '../../lib/download';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines, useToast } from '../../components/ui';
import { fmtDate } from '../../lib/format';
import { renderMarkdown } from '../../lib/markdown';
import { documentType } from '../../../shared/documents/catalog';

export default function OwnerDocumentsPage() {
  const { engagement, loading, isError, error, refetch } = useOwnerContext();
  const docsQ = useEngagementDocuments(engagement?.id);
  // Only the document types meant for the owner. RLS already filters what the
  // owner may read (owner report anytime; CIM once finalized); the catalog's
  // ownerVisible flag is the belt-and-braces client-side filter so the labels and
  // download types stay in lockstep with the one shared source of truth.
  const docs = (docsQ.data ?? []).filter((d) => documentType(d.doc_type)?.ownerVisible);
  const toast = useToast();
  const [openId, setOpenId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const download = async (id: string, assessmentId: string, docType: string, filename: string) => {
    setBusy(id);
    try {
      await downloadDocumentPdf(assessmentId, docType, filename);
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
            {docs.map((d) => {
              const meta = documentType(d.doc_type)!;
              return (
                <li key={d.id} className="owner-doc">
                  <div className="owner-doc-head">
                    <span>
                      <strong>{meta.title}</strong>
                      <span className="muted"> · {fmtDate(d.created_at)}</span>
                    </span>
                    <span className="owner-doc-actions">
                      <button className="btn-ghost" onClick={() => setOpenId(openId === d.id ? null : d.id)}>
                        {openId === d.id ? 'Hide' : 'Read'}
                      </button>
                      <button
                        onClick={() => download(d.id, d.assessment_id, d.doc_type, meta.filename)}
                        disabled={busy === d.id}
                      >
                        {busy === d.id ? 'Preparing…' : 'Download PDF'}
                      </button>
                    </span>
                  </div>
                  {openId === d.id && (
                    <div className="owner-doc-body md-body">{renderMarkdown(d.content_md)}</div>
                  )}
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
