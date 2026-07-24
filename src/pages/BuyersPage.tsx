// The firm's buyer book (buyer-matching design doc). The advisor already
// HAS buyers; this is where their own book of relationships is codified into
// structured, versioned acquisition mandates so the deterministic engine can
// match assessed companies against them. Firm-scoped and staff-writable (RLS),
// exactly like the professional directory — the person with the relationships
// owns the book. Writes go directly through the supabase client under RLS.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import { useAuth } from '../lib/auth';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  useBuyers,
  useBuyerMandates,
  type BuyerKind,
  type BuyerRow,
  type BuyerMandateRow,
} from '../lib/queries';
import { Card, EmptyState, LoadingState, PageHeader, PageSection, useToast } from '../components/ui';

const KIND_LABEL: Record<BuyerKind, string> = {
  strategic: 'Strategic acquirer',
  financial_sponsor: 'Financial sponsor (PE)',
  family_office: 'Family office',
  search_fund: 'Search fund',
  individual: 'Individual buyer',
  strategic_competitor: 'Competitor',
  esop_internal: 'ESOP / internal',
};

const STRENGTH_LABEL: Record<string, string> = {
  strong: 'Strong', moderate: 'Moderate', weak: 'Weak', unknown: 'Unknown',
};

// Comma / newline separated free text → a clean string[] (trimmed, de-duped).
function toList(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[,\n]/)) {
    const v = raw.trim();
    if (v) seen.add(v);
  }
  return [...seen];
}

const EMPTY_BUYER = {
  name: '', organization: '', buyer_kind: 'strategic' as BuyerKind,
  relationship_strength: 'unknown', contact_name: '', contact_email: '', notes: '',
};

export default function BuyersPage() {
  const { profile } = useAuth();
  const firmId = profile?.firm_id ?? undefined;
  const qc = useQueryClient();
  const { data: buyers, isLoading } = useBuyers(firmId);
  const [form, setForm] = useState(EMPTY_BUYER);
  const { busy, run } = useAsyncAction();

  const addBuyer = () =>
    run(
      async () => {
        if (!firmId || !form.name.trim()) throw new Error('A buyer name is required.');
        const { error } = await supabase.from('buyers').insert({
          firm_id: firmId,
          name: form.name.trim(),
          organization: form.organization.trim() || null,
          buyer_kind: form.buyer_kind,
          relationship_strength: form.relationship_strength,
          contact_name: form.contact_name.trim() || null,
          contact_email: form.contact_email.trim() || null,
          notes: form.notes.trim() || null,
          created_by: profile?.id ?? null,
        });
        if (error) throw new Error(error.message);
        setForm(EMPTY_BUYER);
        qc.invalidateQueries({ queryKey: qk.buyers(firmId) });
      },
      { success: 'Buyer added' },
    );

  return (
    <div className="page-shell">
      <header className="page-masthead">
        <PageHeader
          title="Buyer book"
          subtitle="Your own book of buyers and their acquisition mandates. Matching ranks these against each engagement. It never reaches outside your firm."
        />
      </header>

      <PageSection title="Add a buyer">
        <Card>
          <div
            className="settings-grid"
            style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 'var(--space-2)' }}
          >
            <label className="field">
              <span className="field-label">Name</span>
              <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Meridian Industrial Partners" />
            </label>
            <label className="field">
              <span className="field-label">Organization</span>
              <input value={form.organization} onChange={(e) => setForm({ ...form, organization: e.target.value })} placeholder="Meridian Capital" />
            </label>
            <label className="field">
              <span className="field-label">Type</span>
              <select value={form.buyer_kind} onChange={(e) => setForm({ ...form, buyer_kind: e.target.value as BuyerKind })}>
                {(Object.keys(KIND_LABEL) as BuyerKind[]).map((k) => (
                  <option key={k} value={k}>{KIND_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Relationship</span>
              <select value={form.relationship_strength} onChange={(e) => setForm({ ...form, relationship_strength: e.target.value })}>
                {Object.keys(STRENGTH_LABEL).map((k) => (
                  <option key={k} value={k}>{STRENGTH_LABEL[k]}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field-label">Contact name</span>
              <input value={form.contact_name} onChange={(e) => setForm({ ...form, contact_name: e.target.value })} placeholder="Jordan Ellis" />
            </label>
            <label className="field">
              <span className="field-label">Contact email</span>
              <input type="email" value={form.contact_email} onChange={(e) => setForm({ ...form, contact_email: e.target.value })} placeholder="jordan@meridian.com" />
            </label>
            <label className="field" style={{ gridColumn: '1 / -1' }}>
              <span className="field-label">Notes</span>
              <textarea rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="How you know them, what they've bought before, appetite." />
            </label>
          </div>
          <div className="control-row" style={{ marginTop: 'var(--space-3)' }}>
            <button onClick={addBuyer} disabled={busy || !form.name.trim()}>
              {busy ? 'Saving…' : 'Add buyer'}
            </button>
          </div>
        </Card>
      </PageSection>

      <PageSection title={<>Your buyers {buyers ? <span className="muted">· {buyers.length}</span> : null}</>}>
        {isLoading ? (
          <LoadingState variant="inline" />
        ) : (buyers ?? []).length === 0 ? (
          <EmptyState title="No buyers yet">
            Add the buyers you already know above. Give each one a mandate (the industries, size, geography,
            and dealbreakers they care about) and matching does the rest.
          </EmptyState>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
            {(buyers ?? []).map((b) => (
              <BuyerCard key={b.id} buyer={b} firmId={firmId!} meProfileId={profile?.id} />
            ))}
          </div>
        )}
      </PageSection>
    </div>
  );
}

const EMPTY_MANDATE = {
  label: '', target_industries: '', target_revenue_bands: '', target_ebitda_bands: '',
  target_states: '', deal_structures: '', must_haves: '', dealbreaker_gap_codes: '', min_drs: '',
};

function BuyerCard({ buyer, firmId, meProfileId }: { buyer: BuyerRow; firmId: string; meProfileId?: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const { data: mandates } = useBuyerMandates(open ? buyer.id : undefined);
  const [form, setForm] = useState(EMPTY_MANDATE);
  const [adding, setAdding] = useState(false);
  const { busy, run } = useAsyncAction();
  const toast = useToast();

  const nextVersion = (mandates ?? []).reduce((m, r) => Math.max(m, r.mandate_version), 0) + 1;

  const addMandate = () =>
    run(
      async () => {
        const minDrs = form.min_drs.trim() ? Number(form.min_drs) : null;
        if (minDrs != null && Number.isNaN(minDrs)) throw new Error('DRS floor must be a number.');
        const { error } = await supabase.from('buyer_mandates').insert({
          firm_id: firmId,
          buyer_id: buyer.id,
          mandate_version: nextVersion,
          label: form.label.trim() || null,
          target_industries: toList(form.target_industries),
          target_revenue_bands: toList(form.target_revenue_bands),
          target_ebitda_bands: toList(form.target_ebitda_bands),
          target_states: toList(form.target_states),
          deal_structures: toList(form.deal_structures),
          must_haves: toList(form.must_haves),
          dealbreaker_gap_codes: toList(form.dealbreaker_gap_codes),
          min_drs: minDrs,
          created_by: meProfileId ?? null,
        });
        if (error) throw new Error(error.message);
        setForm(EMPTY_MANDATE);
        setAdding(false);
        qc.invalidateQueries({ queryKey: qk.buyerMandates(buyer.id) });
        toast.show('Mandate added', 'good');
      },
    );

  return (
    <Card>
      <div className="eb-list-row">
        <div className="eb-list-row-main">
          <div style={{ fontWeight: 600 }}>
            {buyer.name}
            {buyer.organization && <span className="muted text-sm"> · {buyer.organization}</span>}
          </div>
          <div className="muted text-sm">
            {[buyer.contact_name, buyer.contact_email].filter(Boolean).join(' · ') || '—'}
          </div>
        </div>
        <span className="status-chip status-neutral eb-list-row-push">{KIND_LABEL[buyer.buyer_kind]}</span>
        <span className="status-chip status-neutral">{STRENGTH_LABEL[buyer.relationship_strength]}</span>
        <button className="linkish" type="button" onClick={() => setOpen((v) => !v)}>
          {open ? 'Hide mandates' : 'Mandates'}
        </button>
      </div>

      {open && (
        <div style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)', marginTop: 'var(--space-3)' }}>
          {(mandates ?? []).length === 0 ? (
            <p className="muted text-sm m-0">No mandate yet. Add the buyer's box below so matching can rank them.</p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
              {(mandates ?? []).map((m) => <MandateSummary key={m.id} mandate={m} />)}
            </div>
          )}

          {adding ? (
            <div
              className="settings-grid"
              style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 'var(--space-2)', marginTop: 'var(--space-3)' }}
            >
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field-label">Label</span>
                <input value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} placeholder="Southeast HVAC add-ons" />
              </label>
              <label className="field">
                <span className="field-label">Target industries</span>
                <input value={form.target_industries} onChange={(e) => setForm({ ...form, target_industries: e.target.value })} placeholder="hvac, plumbing" />
                <span className="field-hint">Comma-separated. Matches the company's industry.</span>
              </label>
              <label className="field">
                <span className="field-label">Target revenue bands</span>
                <input value={form.target_revenue_bands} onChange={(e) => setForm({ ...form, target_revenue_bands: e.target.value })} placeholder="3_5m, gt_5m" />
                <span className="field-hint">lt_1m · 1_3m · 3_5m · gt_5m</span>
              </label>
              <label className="field">
                <span className="field-label">Target EBITDA bands</span>
                <input value={form.target_ebitda_bands} onChange={(e) => setForm({ ...form, target_ebitda_bands: e.target.value })} placeholder="1_3m, 3_5m" />
                <span className="field-hint">lt_1m · 1_3m · 3_5m · gt_5m</span>
              </label>
              <label className="field">
                <span className="field-label">Target states</span>
                <input value={form.target_states} onChange={(e) => setForm({ ...form, target_states: e.target.value })} placeholder="GA, FL, TN" />
              </label>
              <label className="field">
                <span className="field-label">Dealbreaker gap codes</span>
                <input value={form.dealbreaker_gap_codes} onChange={(e) => setForm({ ...form, dealbreaker_gap_codes: e.target.value })} placeholder="OWNER_DEP, CUST_CONC" />
                <span className="field-hint">An open gap in this list blocks the match until cleared.</span>
              </label>
              <label className="field">
                <span className="field-label">Minimum DRS</span>
                <input value={form.min_drs} onChange={(e) => setForm({ ...form, min_drs: e.target.value })} placeholder="65" inputMode="numeric" />
              </label>
              <label className="field" style={{ gridColumn: '1 / -1' }}>
                <span className="field-label">Must-haves</span>
                <input value={form.must_haves} onChange={(e) => setForm({ ...form, must_haves: e.target.value })} placeholder="Recurring revenue, second-in-command in place" />
              </label>
              <div className="control-row" style={{ gridColumn: '1 / -1', gap: 'var(--space-2)' }}>
                <button onClick={addMandate} disabled={busy}>{busy ? 'Saving…' : `Add mandate v${nextVersion}`}</button>
                <button className="button-secondary" type="button" onClick={() => { setAdding(false); setForm(EMPTY_MANDATE); }} disabled={busy}>Cancel</button>
              </div>
            </div>
          ) : (
            <div className="control-row" style={{ marginTop: 'var(--space-3)' }}>
              <button className="button-secondary" type="button" onClick={() => setAdding(true)}>Add a mandate</button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function chips(label: string, values: string[]) {
  if (values.length === 0) return null;
  return (
    <span className="muted text-sm">
      <strong>{label}:</strong> {values.join(', ')}
    </span>
  );
}

function MandateSummary({ mandate: m }: { mandate: BuyerMandateRow }) {
  return (
    <div className="eb-list-row" style={{ alignItems: 'flex-start' }}>
      <div className="eb-list-row-main" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-1)' }}>
        <div style={{ fontWeight: 600 }}>
          {m.label || 'Mandate'} <span className="muted text-sm">· v{m.mandate_version}</span>
        </div>
        {chips('Industries', m.target_industries)}
        {chips('Revenue', m.target_revenue_bands)}
        {chips('EBITDA', m.target_ebitda_bands)}
        {chips('Geography', m.target_states)}
        {chips('Dealbreakers', m.dealbreaker_gap_codes)}
        {m.min_drs != null && <span className="muted text-sm"><strong>Min DRS:</strong> {m.min_drs}</span>}
      </div>
      {m.status === 'retired' && <span className="status-chip status-warning">Retired</span>}
    </div>
  );
}
