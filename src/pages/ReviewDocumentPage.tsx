import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { documentDownloadUrl, invokeFunction } from '../lib/supabase';
import { qk } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { Card, PageHeader, SkeletonLines, useToast } from '../components/ui';

interface DetailField {
  id: string;
  field_key: string;
  value: string | null;
  verification_status: string;
  confidence: number | null;
}
interface DocumentDetail {
  document: {
    id: string;
    original_filename: string;
    mime_type: string;
    category: string | null;
    status: string;
    company_name: string;
    classification: string | null;
    parser_name: string | null;
  };
  fields: DetailField[];
}

// A field the reviewer is editing: existing rows carry their id, added rows don't.
interface EditField {
  id?: string;
  field_key: string;
  value: string;
}

export default function ReviewDocumentPage() {
  const { documentId } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();

  const detailQ = useQuery({
    queryKey: qk.documentDetail(documentId ?? ''),
    enabled: !!documentId,
    queryFn: () => invokeFunction<DocumentDetail>('get-document-detail', { document_id: documentId }),
  });

  const [fields, setFields] = useState<EditField[]>([]);
  const [srcUrl, setSrcUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seed the editable field list once the detail loads.
  useEffect(() => {
    if (detailQ.data) {
      setFields(
        detailQ.data.fields.map((f) => ({ id: f.id, field_key: f.field_key, value: f.value ?? '' })),
      );
    }
  }, [detailQ.data]);

  // Load the source via a short-expiry signed URL (R5) — usable directly as the
  // viewer src, no auth header, and it stops working after it expires.
  useEffect(() => {
    if (!documentId) return;
    let cancelled = false;
    invokeFunction<{ token: string }>('sign-document-url', { document_id: documentId })
      .then((r) => {
        if (!cancelled) setSrcUrl(documentDownloadUrl(documentId, r.token));
      })
      .catch(() => setSrcUrl(null));
    return () => {
      cancelled = true;
    };
  }, [documentId]);

  const setField = (i: number, patch: Partial<EditField>) =>
    setFields((prev) => prev.map((f, idx) => (idx === i ? { ...f, ...patch } : f)));
  const addField = () => setFields((prev) => [...prev, { field_key: '', value: '' }]);
  const removeField = (i: number) => setFields((prev) => prev.filter((_, idx) => idx !== i));

  const verify = async () => {
    if (!documentId) return;
    setBusy(true);
    setError(null);
    try {
      await invokeFunction('submit-document-review', {
        document_id: documentId,
        verify: true,
        fields: fields
          .filter((f) => f.field_key.trim())
          .map((f) => ({ id: f.id, field_key: f.field_key.trim(), value: f.value })),
      });
      track({
        type: 'review',
        name: 'document_verified',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        properties: { document_id: documentId, field_count: fields.filter((f) => f.field_key.trim()).length },
      });
      qc.invalidateQueries({ queryKey: qk.reviewQueue() });
      qc.invalidateQueries({ queryKey: qk.documentDetail(documentId) });
      toast.show('Document verified', 'good');
      navigate('/review');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  if (detailQ.isLoading) return <SkeletonLines lines={8} />;
  if (detailQ.error) return <p className="form-error">{(detailQ.error as Error).message}</p>;
  if (!detailQ.data) return <p className="form-error">Not found</p>;

  const doc = detailQ.data.document;
  const isImage = (doc.mime_type ?? '').startsWith('image/');

  return (
    <div className="stack-lg">
      <PageHeader
        title="Review document"
        subtitle={`${doc.original_filename} · ${doc.company_name}`}
        crumbs={[{ label: 'Review queue', to: '/review' }, { label: 'Review document' }]}
      />

      <div className="review-grid">
        <div className="review-source">
          <div className="review-source-head">
            <span className="muted">
              Source · {doc.category || 'Uncategorized'} · parser: {doc.parser_name ?? 'manual'}
            </span>
          </div>
          {srcUrl ? (
            isImage ? (
              <img className="review-source-view" src={srcUrl} alt={doc.original_filename} />
            ) : (
              <iframe className="review-source-view" src={srcUrl} title={doc.original_filename} />
            )
          ) : (
            <Card>
              <p className="muted">Loading source…</p>
            </Card>
          )}
        </div>

        <div className="review-fields">
          <h3>Extracted values</h3>
          <p className="muted">
            Confirm each value against the source, correct anything wrong, and add facts the parser
            missed. Corrections are logged to improve extraction over time.
          </p>

          {fields.length === 0 && (
            <p className="muted">
              No values were extracted (manual adapter) — add the facts you can confirm from the
              source.
            </p>
          )}

          <div className="review-field-list">
            {fields.map((f, i) => (
              <div key={f.id ?? `new-${i}`} className="review-field-row">
                <input
                  className="review-field-key"
                  placeholder="Field (e.g. Revenue FY24)"
                  value={f.field_key}
                  onChange={(e) => setField(i, { field_key: e.target.value })}
                />
                <input
                  className="review-field-val"
                  placeholder="Value"
                  value={f.value}
                  onChange={(e) => setField(i, { value: e.target.value })}
                />
                <button className="btn-ghost review-field-del" onClick={() => removeField(i)} type="button">
                  ✕
                </button>
              </div>
            ))}
          </div>

          <button className="linkish" type="button" onClick={addField}>
            + Add field
          </button>

          {error && <p className="form-error">{error}</p>}

          <div className="review-actions">
            <Link className="btn-ghost" to="/review">
              Cancel
            </Link>
            <button onClick={verify} disabled={busy}>
              {busy ? 'Verifying…' : 'Mark verified'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
