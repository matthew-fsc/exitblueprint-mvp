import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { invokeFunction, supabase } from '../lib/supabase';
import { qk } from '../lib/queries';
import { humanizeKey, formatFieldValue } from '../lib/format';
import {
  ConfirmDialog,
  DataTable,
  EmptyState,
  ErrorState,
  GapSeverityChip,
  SectionCard,
  SkeletonLines,
  StatBlock,
  StatRow,
  useToast,
  type Column,
} from '../components/ui';

// Document-verified intelligence for one engagement. The advisor runs the
// pipeline over uploaded source documents, then sees what was verified, what
// conflicts / low-confidence values need a human, and the buy-side findings the
// graph surfaced — the sell-side "what will diligence find, and can we prove our
// numbers" view. Nothing here computes a score.

interface ReconRow {
  id: string;
  field_key: string;
  self_reported_value: unknown;
  verified_value: unknown;
  source: string;
  confidence: number | null;
  resolved_by: string | null;
}
interface FindingRow {
  id: string;
  pattern_key: string;
  severity: string;
  graph_evidence: { facts?: Record<string, unknown> };
  status: string;
}
interface ReviewRow {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
}
interface Metrics {
  reconciled_total: number;
  auto_resolved: number;
  human_required: number;
  automation_ratio: number;
}

function useReconciliation(engagementId?: string): UseQueryResult<ReconRow[]> {
  return useQuery({
    queryKey: qk.reconciliation(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('assessment_values')
        .select('id, field_key, self_reported_value, verified_value, source, confidence, resolved_by')
        .eq('engagement_id', engagementId!)
        .order('field_key');
      if (error) throw new Error(error.message);
      return (data as ReconRow[]) ?? [];
    },
  });
}

function useFindings(engagementId?: string): UseQueryResult<FindingRow[]> {
  return useQuery({
    queryKey: qk.engagementFindings(engagementId ?? ''),
    enabled: !!engagementId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('findings')
        .select('id, pattern_key, severity, graph_evidence, status')
        .eq('engagement_id', engagementId!)
        .order('severity');
      if (error) throw new Error(error.message);
      return (data as FindingRow[]) ?? [];
    },
  });
}

function useReviewItems(engagementId?: string): UseQueryResult<ReviewRow[]> {
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
      return (data as ReviewRow[]) ?? [];
    },
  });
}

function useMetrics(engagementId?: string): UseQueryResult<Metrics> {
  return useQuery({
    queryKey: ['verificationMetrics', engagementId ?? ''],
    enabled: !!engagementId,
    queryFn: () => invokeFunction<Metrics>('verification-metrics', { engagement_id: engagementId }),
  });
}

const SOURCE_LABEL: Record<string, { text: string; cls: string }> = {
  document_verified: { text: 'Verified', cls: 'good' },
  conflicting: { text: 'Conflict', cls: 'critical' },
  self_reported: { text: 'Self-reported', cls: 'warning' },
};

const TYPE_LABEL: Record<string, string> = {
  conflict: 'Conflict',
  low_confidence_extraction: 'Low confidence',
  finding_approval: 'Finding approval',
  report_signoff: 'Report sign-off',
};

function show(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

export function VerificationPanel() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const reconQ = useReconciliation(engagementId);
  const findingsQ = useFindings(engagementId);
  const reviewQ = useReviewItems(engagementId);
  const metricsQ = useMetrics(engagementId);
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  // the review item whose action is in flight (disables just that row's buttons)
  const [actingId, setActingId] = useState<string | null>(null);
  // a finding queued for reject confirmation (rejection is a decision of record)
  const [rejectId, setRejectId] = useState<string | null>(null);

  const refresh = () => {
    if (!engagementId) return;
    qc.invalidateQueries({ queryKey: qk.reconciliation(engagementId) });
    qc.invalidateQueries({ queryKey: qk.engagementFindings(engagementId) });
    qc.invalidateQueries({ queryKey: qk.engagementReviewItems(engagementId) });
    qc.invalidateQueries({ queryKey: ['verificationMetrics', engagementId] });
  };

  const run = async () => {
    if (!engagementId) return;
    setBusy(true);
    try {
      const r = await invokeFunction<{ findings: number; metrics: Metrics }>('run-verification', {
        engagement_id: engagementId,
      });
      toast.show(
        `Verification run: ${r.metrics.reconciled_total} field(s) reconciled, ${r.findings} finding(s)`,
        'good',
      );
      refresh();
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setBusy(false);
  };

  const act = async (id: string, fn: string, body: Record<string, unknown>, ok: string) => {
    setActingId(id);
    try {
      await invokeFunction(fn, body);
      toast.show(ok, 'good');
      refresh();
    } catch (err) {
      toast.show((err as Error).message, 'error');
    } finally {
      setActingId(null);
    }
  };

  const m = metricsQ.data;
  const recon = reconQ.data ?? [];
  const findings = findingsQ.data ?? [];
  const reviews = reviewQ.data ?? [];

  // Reconciliation is tabular data — the hero data surface — so it rides
  // DataTable (sticky header, sortable, built-in state ladder) rather than a
  // hand-rolled <table>. Sorted low-confidence first to surface conflicts.
  const reconCols: Column<ReconRow>[] = [
    { key: 'field', header: 'Field', sortValue: (r) => humanizeKey(r.field_key), render: (r) => humanizeKey(r.field_key) },
    { key: 'self', header: 'Self-reported', render: (r) => formatFieldValue(r.field_key, r.self_reported_value) },
    { key: 'verified', header: 'Verified', render: (r) => formatFieldValue(r.field_key, r.verified_value) },
    {
      key: 'confidence',
      header: 'Confidence',
      numeric: true,
      sortValue: (r) => (r.confidence === null ? -1 : Number(r.confidence)),
      render: (r) => (r.confidence === null ? '—' : `${Math.round(Number(r.confidence) * 100)}%`),
    },
    {
      key: 'status',
      header: 'Status',
      sortValue: (r) => SOURCE_LABEL[r.source]?.text ?? r.source,
      render: (r) => {
        const s = SOURCE_LABEL[r.source] ?? { text: humanizeKey(r.source), cls: 'neutral' };
        return (
          <>
            <span className={`status-chip status-${s.cls}`}>{s.text}</span>
            {r.resolved_by && <span className="doc-meta"> · by reviewer</span>}
          </>
        );
      },
    },
  ];

  return (
    <div className="stack-lg">
      <SectionCard
        title="Stage 3 · Run verification"
        subtitle="Parses the uploaded data-room documents, builds the knowledge graph, reconciles self-reported values against them, and runs the buy-side finding patterns."
        action={
          <button onClick={run} disabled={busy}>
            {busy ? 'Running…' : 'Run verification'}
          </button>
        }
      >
        <StatRow>
          <StatBlock
            label="Auto-reconciled"
            value={m ? `${Math.round(m.automation_ratio * 100)}%` : '—'}
            hint="cleared without review"
          />
          <StatBlock label="Auto-verified" value={m ? m.auto_resolved : '—'} hint="no review needed" />
          <StatBlock label="Needs review" value={m ? m.human_required : '—'} hint="awaiting review" />
          <StatBlock label="Findings" value={findings.length} hint="buy-side patterns" />
        </StatRow>
      </SectionCard>

      <SectionCard
        title="Reconciliation"
        subtitle="Self-reported answers checked against document-verified values."
      >
        <DataTable
          columns={reconCols}
          rows={recon}
          keyFor={(r) => r.id}
          loading={reconQ.isLoading}
          error={reconQ.error ? (reconQ.error as Error).message : null}
          initialSort={{ key: 'confidence', dir: 'asc' }}
          empty={
            <EmptyState title="Nothing reconciled yet" icon="empty">
              Upload source documents, then run verification to compare them against the questionnaire.
            </EmptyState>
          }
        />
      </SectionCard>

      <SectionCard
        title="Buy-side findings"
        subtitle="What diligence will surface, run in reverse against the graph. Approve before a finding reaches a report."
      >
        {findingsQ.isLoading ? (
          <SkeletonLines lines={2} />
        ) : findings.length === 0 ? (
          <EmptyState title="No findings" icon="check">
            No diligence patterns matched. Run verification after uploading documents.
          </EmptyState>
        ) : (
          <ul className="doc-list">
            {findings.map((f) => (
              <li key={f.id} className="doc-row">
                <div>
                  <span className="doc-name">{humanizeKey(f.pattern_key)}</span>
                  <span className="doc-meta">
                    {Object.entries(f.graph_evidence?.facts ?? {})
                      .map(([k, v]) => `${humanizeKey(k)}: ${formatFieldValue(k, v)}`)
                      .join(' · ')}
                  </span>
                </div>
                <div className="row-gap">
                  <GapSeverityChip severity={f.severity} />
                  <span className={`status-chip status-${f.status === 'approved' ? 'good' : 'neutral'}`}>
                    {humanizeKey(f.status)}
                  </span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </SectionCard>

      <SectionCard
        title="Review queue"
        subtitle="Conflicts, low-confidence extractions, and findings awaiting your decision."
      >
        {reviewQ.isLoading ? (
          <SkeletonLines lines={2} />
        ) : reviews.length === 0 ? (
          <EmptyState title="Queue is clear" icon="check">
            Nothing awaiting review for this engagement.
          </EmptyState>
        ) : (
          <ul className="review-queue">
            {reviews.map((it) => {
              const isRecon = it.type === 'conflict' || it.type === 'low_confidence_extraction';
              const isFinding = it.type === 'finding_approval';
              const draftKey = it.id;
              const acting = actingId === it.id;
              return (
                <li key={it.id} className="review-queue-row">
                  <div className="review-queue-main">
                    <span className="doc-name">
                      {TYPE_LABEL[it.type] ?? humanizeKey(it.type)}
                      {it.status === 'escalated' && (
                        <span className="status-chip status-warning review-queue-flag">
                          Escalated
                        </span>
                      )}
                    </span>
                    <span className="doc-meta">
                      {isRecon
                        ? `${humanizeKey(it.payload.field_key as string)}: self-reported ${formatFieldValue(
                            it.payload.field_key as string,
                            it.payload.self_reported,
                          )} vs document ${formatFieldValue(it.payload.field_key as string, it.payload.verified)}`
                        : `${humanizeKey(it.payload.pattern_key as string)} · ${
                            it.payload.severity ? humanizeKey(show(it.payload.severity)) : '—'
                          }`}
                    </span>
                  </div>
                  <div className="row-gap">
                    {isRecon && (
                      <>
                        <input
                          className="inline-input"
                          value={drafts[draftKey] ?? String(it.payload.verified ?? '')}
                          onChange={(e) => setDrafts((d) => ({ ...d, [draftKey]: e.target.value }))}
                          aria-label="Verified value"
                          disabled={acting}
                        />
                        <button
                          disabled={acting}
                          onClick={() =>
                            act(
                              it.id,
                              'resolve-review-item',
                              {
                                review_item_id: it.id,
                                resolution: { verified_value: drafts[draftKey] ?? it.payload.verified },
                              },
                              'Resolved',
                            )
                          }
                        >
                          {acting ? 'Confirming…' : 'Confirm'}
                        </button>
                      </>
                    )}
                    {isFinding && (
                      <>
                        <button
                          disabled={acting}
                          onClick={() =>
                            act(
                              it.id,
                              'resolve-review-item',
                              { review_item_id: it.id, resolution: { approve: true } },
                              'Finding approved',
                            )
                          }
                        >
                          {acting ? 'Approving…' : 'Approve'}
                        </button>
                        <button
                          className="button-secondary"
                          disabled={acting}
                          onClick={() => setRejectId(it.id)}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {it.status !== 'escalated' && (
                      <button
                        className="button-secondary"
                        disabled={acting}
                        onClick={() =>
                          act(it.id, 'escalate-review-item', { review_item_id: it.id }, 'Escalated')
                        }
                        title="Escalate to a senior reviewer"
                      >
                        {acting ? 'Escalating…' : 'Escalate'}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </SectionCard>

      {(reconQ.error || findingsQ.error || reviewQ.error) && (
        <ErrorState variant="section" error={reconQ.error || findingsQ.error || reviewQ.error} />
      )}

      <ConfirmDialog
        open={rejectId != null}
        title="Reject this finding?"
        danger
        busy={actingId != null && actingId === rejectId}
        confirmLabel="Reject finding"
        onConfirm={async () => {
          const id = rejectId;
          if (!id) return;
          await act(id, 'resolve-review-item', { review_item_id: id, resolution: { approve: false } }, 'Finding rejected');
          setRejectId(null);
        }}
        onCancel={() => setRejectId(null)}
      >
        <p className="m-0">
          Rejecting removes this finding from the engagement. This is a decision of record. It won't
          appear in reports or the buy-side view.
        </p>
      </ConfirmDialog>
    </div>
  );
}
