import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from '../lib/supabase';
import { qk, useEngagement, useCompany } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { Card, EmptyState, EngagementNav, PageHeader, SkeletonLines, useToast } from '../components/ui';

interface DocumentRow {
  id: string;
  original_filename: string;
  category: string | null;
  status: string;
  scan_status: string;
  created_at: string;
}

function useEngagementSourceDocs(engagementId: string | undefined): UseQueryResult<DocumentRow[]> {
  return useQuery({
    queryKey: ['sourceDocuments', engagementId ?? ''],
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('documents')
        .select('id, original_filename, category, status, scan_status, created_at')
        .eq('engagement_id', engagementId!)
        .order('created_at', { ascending: false });
      if (error) throw new Error(error.message);
      return (data as DocumentRow[]) ?? [];
    },
  });
}

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });

const STATUS_LABEL: Record<string, string> = {
  uploaded: 'Uploaded',
  scanning: 'Scanning',
  scanned: 'Scanned',
  classified: 'Classified',
  extracting: 'Extracting',
  in_review: 'In review',
  verified: 'Verified',
  rejected: 'Rejected',
};

export default function DocumentsPage() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const engagementQ = useEngagement(engagementId);
  const companyQ = useCompany(engagementQ.data?.company_id);
  const docsQ = useEngagementSourceDocs(engagementId);

  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0); // bump to reset the native file input

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !engagementId) return;
    setBusy(true);
    setError(null);
    try {
      const content_base64 = await toBase64(file);
      await invokeFunction('upload-document', {
        engagement_id: engagementId,
        category: category.trim() || null,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64,
      });
      track({
        type: 'document',
        name: 'document_uploaded',
        firmId: profile?.firm_id,
        profileId: profile?.id,
        engagementId,
        properties: { category: category.trim() || null, mime_type: file.type || null },
      });
      setFile(null);
      setCategory('');
      setFormKey((k) => k + 1);
      qc.invalidateQueries({ queryKey: qk.sourceDocuments(engagementId) });
      qc.invalidateQueries({ queryKey: qk.reviewQueue() });
      toast.show('Uploaded — sent to the review queue', 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const docs = docsQ.data ?? [];

  return (
    <div className="stack-lg">
      <PageHeader
        title="Documents"
        subtitle={companyQ.data ? `Source documents for ${companyQ.data.name}` : 'Source documents'}
      />
      {engagementId && <EngagementNav engagementId={engagementId} />}

      <form className="inline-form doc-upload" onSubmit={upload}>
        <h3>Upload a document</h3>
        <p className="muted m-0">
          Uploads run through virus scan, classification, and extraction, then land in the review
          queue for a human to confirm against the source before any value is trusted.
        </p>
        <input
          key={formKey}
          type="file"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          required
        />
        <input
          placeholder="Category (optional) — e.g. Financials, Operations"
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        />
        <button type="submit" disabled={!file || busy}>
          {busy ? 'Uploading…' : 'Upload'}
        </button>
        {error && <p className="form-error">{error}</p>}
      </form>

      {docsQ.isLoading ? (
        <Card>
          <SkeletonLines lines={4} />
        </Card>
      ) : docs.length === 0 ? (
        <EmptyState title="No documents yet" icon="empty">
          Upload financial statements, contracts, or org charts to begin building verified facts.
        </EmptyState>
      ) : (
        <ul className="doc-list">
          {docs.map((d) => (
            <li key={d.id} className="doc-row">
              <div>
                <span className="doc-name">{d.original_filename}</span>
                <span className="doc-meta">{d.category || 'Uncategorized'}</span>
              </div>
              <span className={`status-chip status-${d.status === 'verified' ? 'good' : 'warning'}`}>
                {STATUS_LABEL[d.status] ?? d.status}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
