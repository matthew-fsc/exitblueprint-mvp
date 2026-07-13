import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { invokeFunction } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { qk, useDealOutcome, type DealOutcome } from '../lib/queries';
import { Card, SkeletonLines, useToast } from './ui';
import { fmtCurrencyCompact, fmtDate } from '../lib/format';

// The capture point for the outcome-calibration moat (docs/09-moats.md). At close
// (or when a deal breaks), the advisor records the *result*; we snapshot the
// prediction we made at the same moment so predicted-vs-actual is frozen. This is
// advisor-reported fact — nothing here is inferred, and nothing writes to a score.
const OUTCOMES: { id: DealOutcome['outcome']; label: string }[] = [
  { id: 'closed', label: 'Closed' },
  { id: 'broken', label: 'Broke' },
  { id: 'withdrawn', label: 'Withdrawn' },
];
const BUYER_TYPES: { id: NonNullable<DealOutcome['buyer_type']>; label: string }[] = [
  { id: 'strategic', label: 'Strategic' },
  { id: 'financial', label: 'Financial / PE' },
  { id: 'individual', label: 'Individual' },
  { id: 'management', label: 'Management (MBO)' },
  { id: 'other', label: 'Other' },
];
const STRUCTURES: { id: NonNullable<DealOutcome['structure']>; label: string }[] = [
  { id: 'all_cash', label: 'All cash' },
  { id: 'cash_and_note', label: 'Cash + seller note' },
  { id: 'earnout', label: 'Earnout' },
  { id: 'equity_rollover', label: 'Equity rollover' },
  { id: 'other', label: 'Other' },
];

function PredVsActual({ o }: { o: DealOutcome }) {
  if (o.predicted_ev_base == null && o.final_ev == null) return null;
  const inRange =
    o.predicted_ev_low != null && o.predicted_ev_high != null && o.final_ev != null
      ? o.final_ev >= o.predicted_ev_low && o.final_ev <= o.predicted_ev_high
      : null;
  return (
    <div className="deal-compare">
      <div className="deal-compare-col">
        <span className="deal-compare-label">Predicted EV</span>
        <span className="deal-compare-val">{fmtCurrencyCompact(o.predicted_ev_base)}</span>
        {o.predicted_drs != null && <span className="muted deal-compare-sub">DRS {o.predicted_drs}</span>}
      </div>
      <div className="deal-compare-arrow" aria-hidden>→</div>
      <div className="deal-compare-col">
        <span className="deal-compare-label">Actual EV</span>
        <span className="deal-compare-val">{fmtCurrencyCompact(o.final_ev)}</span>
        {o.final_multiple != null && <span className="muted deal-compare-sub">{o.final_multiple}× EBITDA</span>}
      </div>
      {inRange != null && (
        <span className={`verif-badge ${inRange ? 'verif-tier-high' : 'verif-tier-low'}`}>
          {inRange ? 'In predicted range' : 'Outside range'}
        </span>
      )}
    </div>
  );
}

export function DealOutcomeCard({ engagementId }: { engagementId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { profile } = useAuth();
  const outcomeQ = useDealOutcome(engagementId);
  const recorded = outcomeQ.data;
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState({
    outcome: 'closed' as DealOutcome['outcome'],
    close_date: '',
    final_ev: '',
    final_multiple: '',
    ebitda_at_close: '',
    days_on_market: '',
    buyer_type: '' as '' | NonNullable<DealOutcome['buyer_type']>,
    structure: '' as '' | NonNullable<DealOutcome['structure']>,
    retrade: false,
    buyer_flagged_risks: '',
    notes: '',
  });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await invokeFunction('record-deal-outcome', {
        engagement_id: engagementId,
        input: {
          outcome: form.outcome,
          close_date: form.close_date || null,
          final_ev: form.final_ev || null,
          final_multiple: form.final_multiple || null,
          ebitda_at_close: form.ebitda_at_close || null,
          days_on_market: form.days_on_market ? Number(form.days_on_market) : null,
          buyer_type: form.buyer_type || null,
          structure: form.structure || null,
          retrade: form.retrade,
          buyer_flagged_risks: form.buyer_flagged_risks
            ? form.buyer_flagged_risks.split(',').map((s) => s.trim()).filter(Boolean)
            : [],
          notes: form.notes || null,
          recorded_by: profile?.id ?? null,
        },
      });
      qc.invalidateQueries({ queryKey: qk.dealOutcome(engagementId) });
      qc.invalidateQueries({ queryKey: qk.calibration() });
      setEditing(false);
      toast.show('Deal outcome recorded', 'good');
    } catch (err) {
      toast.show((err as Error).message, 'error');
    }
    setBusy(false);
  };

  const startEdit = () => {
    if (recorded) {
      setForm({
        outcome: recorded.outcome,
        close_date: recorded.close_date ?? '',
        final_ev: recorded.final_ev?.toString() ?? '',
        final_multiple: recorded.final_multiple?.toString() ?? '',
        ebitda_at_close: recorded.ebitda_at_close?.toString() ?? '',
        days_on_market: recorded.days_on_market?.toString() ?? '',
        buyer_type: recorded.buyer_type ?? '',
        structure: recorded.structure ?? '',
        retrade: recorded.retrade,
        buyer_flagged_risks: Array.isArray(recorded.buyer_flagged_risks)
          ? recorded.buyer_flagged_risks.join(', ')
          : '',
        notes: recorded.notes ?? '',
      });
    }
    setEditing(true);
  };

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <Card>
      <div className="verif-head">
        <span className="stat-block-label">Deal outcome</span>
        {recorded && !editing && (
          <span className="verif-badge verif-tier-high">
            {OUTCOMES.find((o) => o.id === recorded.outcome)?.label ?? recorded.outcome}
          </span>
        )}
      </div>

      {outcomeQ.isLoading ? (
        <SkeletonLines lines={2} />
      ) : recorded && !editing ? (
        <>
          <p className="muted" style={{ margin: '0.4rem 0 0.75rem' }}>
            Recorded {recorded.close_date ? `· closed ${fmtDate(recorded.close_date)}` : ''}. This feeds
            the firm's predicted-vs-actual calibration.
          </p>
          <PredVsActual o={recorded} />
          <button className="btn-ghost" style={{ marginTop: '0.75rem' }} onClick={startEdit}>
            Edit outcome
          </button>
        </>
      ) : !editing ? (
        <div className="deal-collapsed">
          <p className="muted" style={{ margin: '0.4rem 0 0' }}>
            When the deal closes (or breaks), record the result. We snapshot the score and valuation we
            predicted so the firm learns how its readiness scores map to real prices.
          </p>
          <button className="btn-secondary" onClick={() => setEditing(true)}>Record deal outcome</button>
        </div>
      ) : (
        <>
          <p className="muted" style={{ margin: '0.4rem 0 0.9rem' }}>
            Record the result at close (or when a deal breaks). We snapshot the score and valuation we
            predicted so the firm learns how its readiness scores map to real prices.
          </p>
          <form className="deal-form" onSubmit={submit}>
            <label className="deal-field">
              <span>Outcome</span>
              <select value={form.outcome} onChange={(e) => set('outcome', e.target.value as DealOutcome['outcome'])}>
                {OUTCOMES.map((o) => (
                  <option key={o.id} value={o.id}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="deal-field">
              <span>Close date</span>
              <input type="date" value={form.close_date} onChange={(e) => set('close_date', e.target.value)} />
            </label>
            <label className="deal-field">
              <span>Final EV ($)</span>
              <input inputMode="numeric" placeholder="6250000" value={form.final_ev} onChange={(e) => set('final_ev', e.target.value)} />
            </label>
            <label className="deal-field">
              <span>Multiple (×)</span>
              <input inputMode="decimal" placeholder="5.0" value={form.final_multiple} onChange={(e) => set('final_multiple', e.target.value)} />
            </label>
            <label className="deal-field">
              <span>EBITDA at close ($)</span>
              <input inputMode="numeric" placeholder="1250000" value={form.ebitda_at_close} onChange={(e) => set('ebitda_at_close', e.target.value)} />
            </label>
            <label className="deal-field">
              <span>Days on market</span>
              <input inputMode="numeric" placeholder="240" value={form.days_on_market} onChange={(e) => set('days_on_market', e.target.value)} />
            </label>
            <label className="deal-field">
              <span>Buyer type</span>
              <select value={form.buyer_type} onChange={(e) => set('buyer_type', e.target.value as typeof form.buyer_type)}>
                <option value="">—</option>
                {BUYER_TYPES.map((b) => (
                  <option key={b.id} value={b.id}>{b.label}</option>
                ))}
              </select>
            </label>
            <label className="deal-field">
              <span>Structure</span>
              <select value={form.structure} onChange={(e) => set('structure', e.target.value as typeof form.structure)}>
                <option value="">—</option>
                {STRUCTURES.map((s) => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </select>
            </label>
            <label className="deal-field deal-field-wide">
              <span>Risks the buyer flagged (comma-separated)</span>
              <input placeholder="customer concentration, owner dependence" value={form.buyer_flagged_risks} onChange={(e) => set('buyer_flagged_risks', e.target.value)} />
            </label>
            <label className="deal-field deal-field-wide deal-check">
              <input type="checkbox" checked={form.retrade} onChange={(e) => set('retrade', e.target.checked)} />
              <span>Buyer retraded (cut price after LOI)</span>
            </label>
            <label className="deal-field deal-field-wide">
              <span>Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
            </label>
            <div className="deal-actions">
              <button type="submit" disabled={busy}>{busy ? 'Saving…' : 'Record outcome'}</button>
              <button type="button" className="btn-ghost" onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </form>
        </>
      )}
    </Card>
  );
}
