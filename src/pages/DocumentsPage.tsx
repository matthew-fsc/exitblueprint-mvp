import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from '../lib/supabase';
import { qk } from '../lib/queries';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { humanizeKey, fmtDate } from '../lib/format';
import { Card, EmptyState, ErrorState, SkeletonLines, useToast } from '../components/ui';

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

// Client-side gate mirroring the server allow-list + size cap
// (server/documents/pipeline.ts) — fail fast before base64-encoding a file the
// server would only reject. The extension is the reliable signal; the browser's
// file.type is often empty or generic.
const MAX_BYTES = 15 * 1024 * 1024; // 15 MB, matches the server cap
const ALLOWED_EXTENSIONS = ['pdf', 'csv', 'txt', 'xls', 'xlsx', 'doc', 'docx', 'png', 'jpg', 'jpeg'];
const ACCEPT_ATTR = ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',');

function validateFile(file: File): string | null {
  const dot = file.name.lastIndexOf('.');
  const ext = dot >= 0 ? file.name.slice(dot + 1).toLowerCase() : '';
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `That file type isn't accepted. Allowed: ${ALLOWED_EXTENSIONS.join(', ')}.`;
  }
  if (file.size === 0) return 'That file is empty.';
  if (file.size > MAX_BYTES) return 'That file is larger than the 15 MB limit.';
  return null;
}

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

// Tone per status so the chip distinguishes "failed" (rejected) from "in
// progress" (pipeline) from "done" (verified) — not everything-non-verified as
// amber, which hid rejections.
const STATUS_TONE: Record<string, string> = {
  verified: 'good',
  rejected: 'critical',
  in_review: 'warning',
  uploaded: 'neutral',
  scanning: 'neutral',
  scanned: 'neutral',
  classified: 'neutral',
  extracting: 'neutral',
};

// A document uploaded from the Data room tab is tagged `data_room:<item_code>`;
// a generic upload here carries a free-text category or none. Deriving a human
// "Attached to" label from that tag is what makes the SAME file recognisable
// across both surfaces, instead of looking like two unrelated lists.
const DATA_ROOM_PREFIX = 'data_room:';
function docLinkage(category: string | null): { label: string; linked: boolean } {
  if (category && category.startsWith(DATA_ROOM_PREFIX)) {
    return {
      label: `Attached to a data-room item · ${humanizeKey(category.slice(DATA_ROOM_PREFIX.length))}`,
      linked: true,
    };
  }
  if (category) return { label: `${category} · not linked to a request-list item`, linked: false };
  return { label: 'Not linked to a request-list item', linked: false };
}

export function DocumentsPanel() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const docsQ = useEngagementSourceDocs(engagementId);

  const [file, setFile] = useState<File | null>(null);
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0); // bump to reset the native file input

  const upload = async (e: FormEvent) => {
    e.preventDefault();
    if (!file || !engagementId) return;
    const invalid = validateFile(file);
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const content_base64 = await toBase64(file);
      const result = await invokeFunction<{ status?: string }>('upload-document', {
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
      // A virus scan can reject the upload before it ever reaches the queue.
      if (result?.status === 'rejected') {
        toast.show('Upload rejected — the file failed the virus scan', 'error');
      } else {
        toast.show('Uploaded — sent to the review queue', 'good');
      }
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const docs = docsQ.data ?? [];

  return (
    <div className="stack-lg">
      <form className="inline-form doc-upload" onSubmit={upload}>
        <h3>Upload an unlinked document</h3>
        <p className="muted m-0">
          Most files belong to a specific item on the buyer's request list — upload those from the{' '}
          <Link to={`/engagement/${engagementId}/evidence/data-room`}>Data room</Link> tab so they're
          tagged to the item and tracked toward readiness. Use this secondary path only for extra
          documents that don't map to a request-list item. Everything still runs virus scan,
          classification, and extraction, then lands in the review queue for a human to confirm.
        </p>
        <input
          key={formKey}
          type="file"
          accept={ACCEPT_ATTR}
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
        {error && <ErrorState variant="inline" error={error} />}
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
          {docs.map((d) => {
            const link = docLinkage(d.category);
            return (
              <li key={d.id} className="doc-row">
                <div>
                  <span className="doc-name">{d.original_filename}</span>
                  <span className="doc-meta">
                    {link.label} · {fmtDate(d.created_at)}
                  </span>
                </div>
                <div className="row-gap">
                  {link.linked && (
                    <span className="status-chip status-neutral" title="Uploaded against a data-room request-list item">
                      Data room
                    </span>
                  )}
                  <span className={`status-chip status-${STATUS_TONE[d.status] ?? 'neutral'}`}>
                    {d.scan_status === 'infected'
                      ? 'Infected'
                      : STATUS_LABEL[d.status] ?? humanizeKey(d.status)}
                  </span>
                  <Link className="button-link" to={`/review/${d.id}`}>
                    Review →
                  </Link>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
