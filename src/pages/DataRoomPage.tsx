import { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabase';
import { qk } from '../lib/queries';
import { Card, SkeletonLines, useToast } from '../components/ui';

const toBase64 = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(',')[1] ?? '');
    r.onerror = () => reject(new Error('could not read file'));
    r.readAsDataURL(file);
  });

// Data Room Readiness (docs/15, work stream B): the buyer's real diligence
// request list, turned into the client's pre-built checklist. Deterministic — a
// readiness state per item, assembled over the pre-deal window. No score is
// touched here.

interface DataRoomItem {
  section_code: string;
  item_code: string;
  label: string;
  description: string | null;
  buyer_rationale: string | null;
  applies_to: string;
  gap_code: string | null;
  sort_order: number;
  readiness_state: string;
  note: string | null;
  document_id: string | null;
  document_filename: string | null;
  document_status: string | null;
  updated_at: string | null;
}
interface DataRoomSection {
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
}
interface DataRoomView {
  sections: DataRoomSection[];
  items: DataRoomItem[];
  summary: {
    total: number;
    ready: number;
    in_progress: number;
    gap: number;
    not_started: number;
    not_applicable: number;
    readiness_pct: number;
  };
}

const STATES: { value: string; label: string }[] = [
  { value: 'not_started', label: 'Not started' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'ready', label: 'Ready' },
  { value: 'gap', label: 'Gap' },
  { value: 'not_applicable', label: 'N/A' },
];
const STATE_CHIP: Record<string, string> = {
  ready: 'status-good',
  in_progress: 'status-warning',
  gap: 'status-critical',
  not_started: 'status-neutral',
  not_applicable: 'status-neutral',
};

function useDataRoom(engagementId: string | undefined): UseQueryResult<DataRoomView> {
  return useQuery({
    queryKey: engagementId ? qk.dataRoom(engagementId) : ['dataRoom', ''],
    enabled: !!engagementId,
    queryFn: () => invokeFunction<DataRoomView>('list-data-room', { engagement_id: engagementId }),
  });
}

export function DataRoomPanel() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const dataRoomQ = useDataRoom(engagementId);
  const [saving, setSaving] = useState<string | null>(null);
  const [uploading, setUploading] = useState<string | null>(null);
  const fileInputs = useRef<Record<string, HTMLInputElement | null>>({});

  const setState = async (itemCode: string, readinessState: string) => {
    if (!engagementId) return;
    setSaving(itemCode);
    try {
      await invokeFunction('set-data-room-item', {
        engagement_id: engagementId,
        item_code: itemCode,
        readiness_state: readinessState,
      });
      await qc.invalidateQueries({ queryKey: qk.dataRoom(engagementId) });
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setSaving(null);
  };

  const attachDocument = async (itemCode: string, file: File) => {
    if (!engagementId) return;
    setUploading(itemCode);
    try {
      const content_base64 = await toBase64(file);
      await invokeFunction('attach-data-room-document', {
        engagement_id: engagementId,
        item_code: itemCode,
        filename: file.name,
        mime_type: file.type || 'application/octet-stream',
        content_base64,
      });
      await qc.invalidateQueries({ queryKey: qk.dataRoom(engagementId) });
      toast.show('Uploaded — tagged to this item and sent for review', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setUploading(null);
  };

  const view = dataRoomQ.data;

  return (
    <div className="stack-lg">
      <Card>
        <p className="muted mt-0">
          The request list a buyer will actually send, assembled ahead of time. Mark each item as you
          build the binder — items flagged <strong>Gap</strong> are where a deal gets repriced or
          stalled. Nothing here changes a readiness score.
        </p>
        {view && (
          <div className="dr-summary">
            <span className="dr-summary-pct">{view.summary.readiness_pct}%</span>
            <span className="muted">
              of in-scope items ready · {view.summary.ready} ready · {view.summary.in_progress} in
              progress · {view.summary.gap} gap · {view.summary.not_started} not started
            </span>
          </div>
        )}
      </Card>

      {dataRoomQ.isLoading ? (
        <Card>
          <SkeletonLines lines={6} />
        </Card>
      ) : !view ? (
        <Card>Could not load the data room.</Card>
      ) : (
        view.sections.map((section) => {
          const items = view.items.filter((i) => i.section_code === section.code);
          if (items.length === 0) return null;
          return (
            <Card key={section.code}>
              <h3 className="mt-0">{section.name}</h3>
              {section.description && (
                <p className="muted mt-0">
                  {section.description}
                </p>
              )}
              <ul className="dr-list">
                {items.map((item) => (
                  <li key={item.item_code} className="dr-row">
                    <div className="dr-row-main">
                      <div className="dr-row-head">
                        <span className="dr-label">{item.label}</span>
                        <span className={`status-chip ${STATE_CHIP[item.readiness_state] ?? 'status-neutral'}`}>
                          {STATES.find((s) => s.value === item.readiness_state)?.label ??
                            item.readiness_state}
                        </span>
                        {item.gap_code && (
                          <span className="dr-gap-tag" title={`Maps to a scored gap (${item.gap_code})`}>
                            Scored gap
                          </span>
                        )}
                      </div>
                      {item.description && <p className="dr-desc">{item.description}</p>}
                      {item.buyer_rationale && (
                        <p className="dr-why">
                          <span className="dr-why-label">Why buyers ask:</span> {item.buyer_rationale}
                        </p>
                      )}
                      <div className="dr-doc">
                        {item.document_id ? (
                          <span className="dr-doc-linked" title={`Status: ${item.document_status ?? 'uploaded'}`}>
                            ◆ {item.document_filename ?? 'Document attached'}
                            {item.document_status && item.document_status !== 'verified' && (
                              <span className="dr-doc-status"> · {item.document_status.replace('_', ' ')}</span>
                            )}
                          </span>
                        ) : (
                          <span className="muted dr-doc-none">No document attached</span>
                        )}
                        <input
                          ref={(el) => {
                            fileInputs.current[item.item_code] = el;
                          }}
                          type="file"
                          className="sr-only"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) attachDocument(item.item_code, f);
                            e.target.value = '';
                          }}
                        />
                        <button
                          type="button"
                          className="dr-doc-btn"
                          disabled={uploading === item.item_code}
                          onClick={() => fileInputs.current[item.item_code]?.click()}
                        >
                          {uploading === item.item_code
                            ? 'Uploading…'
                            : item.document_id
                              ? 'Replace'
                              : 'Upload'}
                        </button>
                      </div>
                    </div>
                    <label className="dr-select">
                      <span className="sr-only">Readiness for {item.label}</span>
                      <select
                        value={item.readiness_state}
                        disabled={saving === item.item_code}
                        onChange={(e) => setState(item.item_code, e.target.value)}
                      >
                        {STATES.map((s) => (
                          <option key={s.value} value={s.value}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </li>
                ))}
              </ul>
            </Card>
          );
        })
      )}
    </div>
  );
}
