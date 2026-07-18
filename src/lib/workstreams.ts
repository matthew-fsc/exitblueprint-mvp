// Work-stream progress model (docs/17 follow-up; docs/22). The engagement
// navigation already groups every surface under the five sell-side preparation
// work streams — Readiness → Remediation → Evidence → Value → Deliverables. This
// turns those five tabs into a first-class progress rail on the Overview so an
// advisor sees the *arc* and where the engagement stands in it, not a checklist
// of tabs. Pure and deterministic: it reads the structured data the Overview
// already loads and returns a state per stream. It computes no score and writes
// nothing — it only summarizes progress a buyer's process moves through.

export type StreamKey = 'readiness' | 'remediation' | 'evidence' | 'value' | 'deliverables';

// done   — this stream's job is substantially complete.
// active — in motion, partial progress.
// todo   — ready to start but nothing done.
// blocked— can't start yet because an upstream stream hasn't produced its input
//          (everything downstream of Readiness needs a scored assessment first).
export type StreamState = 'done' | 'active' | 'todo' | 'blocked';

export interface WorkstreamStatus {
  key: StreamKey;
  label: string;
  state: StreamState;
  headline: string; // short status shown on the chip
  detail: string; // one clause of context (tooltip / second line)
  to: string; // path suffix under /engagement/:id for the stream's working tab
}

export interface WorkstreamInput {
  assessed: boolean; // a completed assessment with a score exists
  inProgress: boolean; // an intake is underway but not yet scored
  drsScore: number | null;
  openGapCount: number | null; // null when not assessed
  tasksTotal: number;
  tasksDone: number;
  verifiedPct: number | null; // 0–100 share of financial inputs proven; null = unknown
  valuationSet: boolean; // enterprise value has been modeled (recast present)
  valueGap: number | null; // dollar value-creation gap, when sized
  reportDraftCount: number; // generated narratives not yet finalized
  reportFinalCount: number; // finalized narratives
}

const EVIDENCE_DONE_PCT = 80; // "substantially proven" — the binder a buyer diligences

function usd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

// The measurement layer: is there a current, scored assessment?
function readiness(i: WorkstreamInput): WorkstreamStatus {
  const base = { key: 'readiness' as const, label: 'Readiness', to: '/buyer-lens' };
  if (i.assessed) {
    return { ...base, state: 'done', headline: i.drsScore != null ? `DRS ${Math.round(i.drsScore)}` : 'Scored', detail: 'A current assessment is scored — gaps and buyer questions are named.' };
  }
  if (i.inProgress) {
    return { ...base, state: 'active', headline: 'Intake in progress', detail: 'Finish the assessment to produce a score.', to: '' };
  }
  return { ...base, state: 'todo', headline: 'Not assessed', detail: 'Run the baseline assessment to begin the engagement.', to: '' };
}

// The prescription layer: are the open gaps owned by a sequenced plan?
function remediation(i: WorkstreamInput): WorkstreamStatus {
  const base = { key: 'remediation' as const, label: 'Remediation', to: '/roadmap' };
  if (!i.assessed) return { ...base, state: 'blocked', headline: 'Awaiting assessment', detail: 'Gaps open once the baseline is scored.' };
  if ((i.openGapCount ?? 0) === 0) return { ...base, state: 'done', headline: 'No open gaps', detail: 'A clean book — nothing to remediate.' };
  const gaps = i.openGapCount ?? 0;
  if (i.tasksTotal === 0) return { ...base, state: 'todo', headline: `${gaps} open gap${gaps === 1 ? '' : 's'}, no plan`, detail: 'Build the roadmap from the open gaps.' };
  return { ...base, state: 'active', headline: `${i.tasksDone}/${i.tasksTotal} tasks done`, detail: `${gaps} gap${gaps === 1 ? '' : 's'} still open — work the roadmap to close them.` };
}

// The proof layer: how much of the self-reported story is document-verified?
function evidence(i: WorkstreamInput): WorkstreamStatus {
  const base = { key: 'evidence' as const, label: 'Evidence', to: '/data-room' };
  if (!i.assessed) return { ...base, state: 'blocked', headline: 'Awaiting assessment', detail: 'Inputs are verified against a scored assessment.' };
  const pct = i.verifiedPct ?? 0;
  if (pct >= EVIDENCE_DONE_PCT) return { ...base, state: 'done', headline: `${pct}% verified`, detail: 'The diligence binder is substantially proven.' };
  if (pct > 0) return { ...base, state: 'active', headline: `${pct}% verified`, detail: 'Upload source documents to prove the rest.' };
  return { ...base, state: 'todo', headline: 'Nothing verified', detail: 'Assemble the data room and upload evidence.' };
}

// The quantification layer: has enterprise value been modeled?
function value(i: WorkstreamInput): WorkstreamStatus {
  const base = { key: 'value' as const, label: 'Value', to: '/valuation' };
  if (!i.assessed) return { ...base, state: 'blocked', headline: 'Awaiting assessment', detail: 'Valuation reads from the DRS.' };
  if (i.valuationSet) {
    const gap = i.valueGap != null && i.valueGap > 0 ? ` · ${usd(i.valueGap)} gap` : '';
    return { ...base, state: 'done', headline: `EV modeled${gap}`, detail: 'Current EV, target EV, and the value gap are sized.' };
  }
  return { ...base, state: 'todo', headline: 'Not sized', detail: 'Model current and target enterprise value.' };
}

// The output layer: is the narrative drafted and finalized?
function deliverables(i: WorkstreamInput): WorkstreamStatus {
  const base = { key: 'deliverables' as const, label: 'Deliverables', to: '/delta' };
  if (!i.assessed) return { ...base, state: 'blocked', headline: 'Awaiting assessment', detail: 'Reports draft from a scored assessment.' };
  if (i.reportFinalCount > 0) return { ...base, state: 'done', headline: 'Report finalized', detail: 'A finalized narrative is ready to hand over.' };
  if (i.reportDraftCount > 0) return { ...base, state: 'active', headline: 'Draft in progress', detail: 'Finalize the narrative to deliver it.' };
  return { ...base, state: 'todo', headline: 'No report yet', detail: 'Draft the report from the structured data.' };
}

// The five streams in the fixed arc order the work happens in.
export function buildWorkstreamProgress(i: WorkstreamInput): WorkstreamStatus[] {
  return [readiness(i), remediation(i), evidence(i), value(i), deliverables(i)];
}
