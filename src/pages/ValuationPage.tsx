import { useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '../lib/supabase';
import {
  qk,
  useCompany,
  useEngagement,
  useRecast,
  useValuation,
  useValuationInputs,
  type AddbackRow,
} from '../lib/queries';
import { Card, EmptyState, EngagementNav, ErrorState, MoneyInput, PageHeader, SectionCard, SkeletonLines, useToast } from '../components/ui';
import { fmtCurrency, fmtCurrencyCompact, humanizeKey } from '../lib/format';
import { engagementCrumbs } from '../lib/nav';

const INDUSTRIES = [
  ['field_services', 'Field / facility services'],
  ['manufacturing', 'Manufacturing'],
  ['distribution', 'Distribution'],
  ['healthcare', 'Healthcare services'],
  ['software', 'Software / recurring'],
  ['default', 'Other'],
] as const;

const CHALLENGE = [
  ['low', 'Likely accepted'],
  ['medium', 'Some pushback'],
  ['high', 'Heavy pushback'],
  ['not_defensible', 'Not defensible'],
] as const;

const DEFENSIBLE = new Set(['low', 'medium']);

// How the base multiple was chosen — surfaced next to the own-book comparison.
const MULTIPLE_SOURCE_LABEL: Record<string, string> = {
  table: 'Generic table multiple',
  override: 'Manual override',
  own_book: 'Own-book median',
  market: 'Market comparables',
};

// size_band keys are coded revenue/EBITDA ranges (e.g. lt_1m, 1m_5m, gt_5m).
// Render them as legible money ranges rather than raw snake_case.
function fmtSizeBand(band: string | null | undefined): string {
  if (!band) return '—';
  const money = (t: string) => {
    const m = t.match(/^(\d+(?:\.\d+)?)([mk])$/i);
    return m ? `$${m[1]}${m[2].toUpperCase()}` : t;
  };
  const parts = band.split('_');
  if (parts[0] === 'lt' && parts[1]) return `< ${money(parts[1])}`;
  if (parts[0] === 'gt' && parts[1]) return `> ${money(parts[1])}`;
  if (parts.length === 2) return `${money(parts[0])}–${money(parts[1])}`;
  return parts.map(money).join('–');
}

export default function ValuationPage() {
  const { engagementId } = useParams();
  const qc = useQueryClient();
  const toast = useToast();

  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const recastQ = useRecast(engagementId);
  const inputsQ = useValuationInputs(engagementId);
  const valQ = useValuation(engagementId);
  const recast = recastQ.data?.recast ?? null;
  const addbacks = recastQ.data?.addbacks ?? [];
  const inputs = inputsQ.data ?? null;
  const val = valQ.data;

  const [reported, setReported] = useState('');
  const [abLabel, setAbLabel] = useState('');
  const [abAmount, setAbAmount] = useState('');
  const [abChallenge, setAbChallenge] = useState<AddbackRow['challenge_likelihood']>('medium');
  const [abFormKey, setAbFormKey] = useState(0); // remounts the amount field on reset
  const [goalDraft, setGoalDraft] = useState('');

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.recast(engagementId!) });
    qc.invalidateQueries({ queryKey: qk.valuationInputs(engagementId!) });
    qc.invalidateQueries({ queryKey: qk.valuation(engagementId!) });
  };

  const startRecast = async (e: FormEvent) => {
    e.preventDefault();
    if (!engagement) return;
    const { error } = await supabase.from('ebitda_recasts').insert([
      { firm_id: engagement.firm_id, engagement_id: engagementId, reported_ebitda: Number(reported) || 0 },
    ]);
    if (error) return toast.show(error.message, 'error');
    setReported('');
    refresh();
  };

  const updateReported = async (v: string) => {
    if (!recast) return;
    await supabase.from('ebitda_recasts').update({ reported_ebitda: Number(v) || 0, updated_at: new Date().toISOString() }).eq('id', recast.id);
    refresh();
  };

  const addAddback = async (e: FormEvent) => {
    e.preventDefault();
    if (!recast || !engagement || !abLabel) return;
    const { error } = await supabase.from('ebitda_addbacks').insert([
      { firm_id: engagement.firm_id, recast_id: recast.id, label: abLabel, amount: Number(abAmount) || 0, challenge_likelihood: abChallenge },
    ]);
    if (error) return toast.show(error.message, 'error');
    setAbLabel(''); setAbAmount(''); setAbChallenge('medium'); setAbFormKey((k) => k + 1);
    refresh();
  };

  const setAddbackChallenge = async (id: string, ch: AddbackRow['challenge_likelihood']) => {
    await supabase.from('ebitda_addbacks').update({ challenge_likelihood: ch }).eq('id', id);
    refresh();
  };
  const removeAddback = async (id: string) => {
    await supabase.from('ebitda_addbacks').delete().eq('id', id);
    refresh();
  };

  const saveInput = async (patch: Record<string, unknown>) => {
    if (!engagement) return;
    const { error } = await supabase.from('valuation_inputs').upsert(
      { firm_id: engagement.firm_id, engagement_id: engagementId, ...inputs, ...patch, updated_at: new Date().toISOString() },
      { onConflict: 'engagement_id' },
    );
    if (error) return toast.show(error.message, 'error');
    refresh();
  };

  const companyName = companyQ.data?.name ?? '';

  if (engagementQ.isLoading) return <Card><SkeletonLines lines={6} /></Card>;
  if (!engagement) return <ErrorState variant="section" title="Engagement not found" message="This engagement doesn’t exist or you don’t have access to it." />;

  return (
    <div className="page-shell stack-lg">
      <header className="page-masthead">
        <PageHeader
          title="Valuation"
          crumbs={engagementCrumbs(engagementId, companyName, 'Valuation')}
          subtitle="Current enterprise value, the value of completing the roadmap, and the owner's net proceeds."
        />
        <EngagementNav engagementId={engagementId!} />
      </header>

      {!recast ? (
        <Card>
          <EmptyState title="Start the EBITDA recast">
            Enter the reported EBITDA to begin. You'll add documented add-backs next, and the value
            range builds from there.
          </EmptyState>
          <form className="val-start" onSubmit={startRecast}>
            <label>Reported EBITDA (most recent year)
              <MoneyInput initial={reported} live onCommit={(v) => setReported(v == null ? '' : String(v))} placeholder="1,200,000" ariaLabel="Reported EBITDA" />
            </label>
            <button type="submit">Start recast</button>
          </form>
        </Card>
      ) : (
        <>
          {/* headline value */}
          {val?.has_recast && (
            <Card>
              <div className="val-headline">
                <div className="val-ev">
                  <span className="stat-block-label">Estimated enterprise value</span>
                  <div className="val-ev-range">
                    <span className="val-ev-low">{fmtCurrencyCompact(val.ev_low)}</span>
                    <span className="val-ev-base">{fmtCurrencyCompact(val.ev_base)}</span>
                    <span className="val-ev-high">{fmtCurrencyCompact(val.ev_high)}</span>
                  </div>
                  <div className="val-ev-bar">
                    <div className="val-ev-fill" />
                    <div className="val-ev-mid" />
                  </div>
                  <p className="muted val-ev-basis">
                    {fmtCurrency(val.defensible_ebitda)} defensible EBITDA × {val.base_multiple.toFixed(1)}×{' '}
                    ({INDUSTRIES.find((i) => i[0] === val.industry_key)?.[1] ?? val.industry_key}, {fmtSizeBand(val.size_band)})
                    {' · '}readiness ×{val.readiness_factor} · {humanizeKey(val.verification_tier)} range ±{Math.round(val.range_width * 100)}%
                  </p>
                </div>
                <div className="val-gaps">
                  <div className="val-gap">
                    <span className="val-gap-num">{fmtCurrencyCompact(val.value_creation_gap)}</span>
                    <span className="val-gap-label">Value-creation gap</span>
                    <span className="muted">upside from reaching Institutional Grade ({fmtCurrencyCompact(val.potential_ev)})</span>
                  </div>
                  {val.owner_wealth_target != null && val.wealth_gap != null ? (
                    <div className="val-gap">
                      <span className={`val-gap-num ${val.wealth_gap > 0 ? 'val-gap-short' : 'val-gap-ok'}`}>
                        {val.wealth_gap > 0 ? fmtCurrencyCompact(val.wealth_gap) : 'Covered'}
                      </span>
                      <span className="val-gap-label">Wealth gap</span>
                      <span className="muted">
                        {val.wealth_gap > 0
                          ? `net proceeds fall short of the ${fmtCurrencyCompact(val.owner_wealth_target)} target`
                          : `net proceeds meet the ${fmtCurrencyCompact(val.owner_wealth_target)} target`}
                      </span>
                    </div>
                  ) : (
                    <div className="val-gap val-gap-prompt">
                      <span className="val-gap-label">Wealth gap</span>
                      <span className="muted">
                        Set the owner's wealth goal (the number they need from the sale to fund their next
                        chapter) to size the gap and complete the financial readiness picture.
                      </span>
                      <form
                        className="val-goal-form"
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (goalDraft.trim() === '') return;
                          saveInput({ owner_wealth_target: Number(goalDraft) });
                          setGoalDraft('');
                        }}
                      >
                        <MoneyInput
                          initial={goalDraft}
                          live
                          onCommit={(v) => setGoalDraft(v == null ? '' : String(v))}
                          placeholder="Owner's wealth goal (e.g. 5,000,000)"
                          ariaLabel="Owner's wealth goal"
                        />
                        <button type="submit">Size the gap</button>
                      </form>
                    </div>
                  )}
                </div>
              </div>
            </Card>
          )}

          {/* comparables — the applied multiple against the own-book and market
              reference lanes (docs/09 §2, moat 2; docs/sellside-ai/01) */}
          {val?.has_recast && (
            <SectionCard title="Comparables">
              <div className="val-ob">
                <div className="val-ob-cols">
                  <div className="val-ob-col">
                    <span className="stat-block-label">Your estimate uses</span>
                    <span className="val-ob-mult">{val.base_multiple.toFixed(1)}×</span>
                    <span className="muted">{MULTIPLE_SOURCE_LABEL[val.multiple_source] ?? val.multiple_source}</span>
                  </div>
                  <div className="val-ob-col">
                    <span className="stat-block-label">Your closed deals</span>
                    {val.own_book_multiple != null ? (
                      <>
                        <span className="val-ob-mult">
                          {val.own_book_multiple.toFixed(1)}×
                          {val.own_book_driving && <span className="val-ob-tag">in use</span>}
                        </span>
                        <span className="muted">
                          {val.own_book_p25?.toFixed(1)}–{val.own_book_p75?.toFixed(1)}× range
                          {' · '}
                          {val.own_book_sample_size} closed deal{val.own_book_sample_size === 1 ? '' : 's'}
                          {val.own_book_same_band ? ` (${val.own_book_same_band} in band)` : ''}
                        </span>
                        {val.own_book_confidence && (
                          <span className={`val-ob-conf val-ob-conf-${val.own_book_confidence}`}>
                            {humanizeKey(val.own_book_confidence)} confidence
                          </span>
                        )}
                      </>
                    ) : (
                      <span className="muted">No closed deals in this industry yet to draw an own-book multiple from.</span>
                    )}
                  </div>
                  {val.market_multiple != null && (
                    <div className="val-ob-col">
                      <span className="stat-block-label">Sector median</span>
                      <span className="val-ob-mult">
                        {val.market_multiple.toFixed(1)}×
                        {val.market_source === 'market' && <span className="val-ob-tag">in use</span>}
                      </span>
                      <span className="muted">
                        {val.market_p25?.toFixed(1)}–{val.market_p75?.toFixed(1)}× range
                        {' · '}
                        {val.market_sample_size} comparable{val.market_sample_size === 1 ? '' : 's'}
                      </span>
                    </div>
                  )}
                </div>
                <p className="muted val-ob-note">
                  {val.own_book_driving
                    ? 'The estimate draws its multiple from your own realized deals. '
                    : val.multiple_source === 'override'
                      ? 'A manual multiple override is in effect; your own-book median is shown for reference. '
                      : 'The estimate uses the generic table multiple; your own realized median is shown for reference. '}
                  {val.market_multiple != null &&
                    (val.base_multiple < val.market_multiple
                      ? 'It sits below the sector median. Closing readiness gaps is what moves it up within the range. '
                      : val.base_multiple > val.market_multiple
                        ? 'It sits above the sector median, reflecting the readiness already in place. '
                        : 'It is in line with the sector median. ')}
                  Own-book multiples come from this firm’s closed deals only; the market median is a directional
                  reference, not a licensed data feed. Adopting either into the estimate ships as a new valuation
                  rules version.
                </p>
              </div>
            </SectionCard>
          )}

          <div className="eng-grid eng-grid-top">
            {/* recast builder */}
            <SectionCard title="EBITDA recast">
              <label className="val-reported">Reported EBITDA
                <MoneyInput initial={recast.reported_ebitda} onCommit={(v) => updateReported(String(v ?? 0))} ariaLabel="Reported EBITDA" />
              </label>
              <div className="scroll-x">
              <table className="val-addbacks">
                <tbody>
                  {addbacks.map((a) => (
                    <tr key={a.id} className={DEFENSIBLE.has(a.challenge_likelihood) ? '' : 'val-ab-excluded'}>
                      <td>{a.label}</td>
                      <td className="val-ab-amt">{fmtCurrency(a.amount)}</td>
                      <td>
                        <select value={a.challenge_likelihood} onChange={(e) => setAddbackChallenge(a.id, e.target.value as AddbackRow['challenge_likelihood'])}>
                          {CHALLENGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                      </td>
                      <td><button className="button-danger-link" onClick={() => removeAddback(a.id)} aria-label={`Remove add-back: ${a.label}`} title="Remove add-back">×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
              <form className="val-ab-form" onSubmit={addAddback}>
                <input placeholder="Add-back (e.g. Owner comp above market)" value={abLabel} onChange={(e) => setAbLabel(e.target.value)} required />
                <MoneyInput key={abFormKey} initial={abAmount} live onCommit={(v) => setAbAmount(v == null ? '' : String(v))} placeholder="Amount" ariaLabel="Add-back amount" />
                <select value={abChallenge} onChange={(e) => setAbChallenge(e.target.value as AddbackRow['challenge_likelihood'])}>
                  {CHALLENGE.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
                <button type="submit">Add</button>
              </form>
              {val && (
                <p className="muted val-recast-totals">
                  Defensible EBITDA <strong>{fmtCurrency(val.defensible_ebitda)}</strong>
                  {val.full_recast_ebitda !== val.defensible_ebitda && <> · full recast {fmtCurrency(val.full_recast_ebitda)} (not-defensible excluded)</>}
                </p>
              )}
            </SectionCard>

            {/* assumptions + net-to-owner */}
            <SectionCard title="Assumptions">
              <div className="val-inputs">
                <label>Industry
                  <select value={inputs?.industry_key ?? val?.industry_key ?? 'default'} onChange={(e) => saveInput({ industry_key: e.target.value })}>
                    {INDUSTRIES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                  </select>
                </label>
                <label>Multiple override
                  <input type="number" step="0.1" placeholder={val ? `table ${val.base_multiple}×` : 'table'} defaultValue={inputs?.multiple_override ?? ''} onBlur={(e) => saveInput({ multiple_override: e.target.value === '' ? null : Number(e.target.value) })} />
                </label>
                <label>Interest-bearing debt
                  <MoneyInput initial={inputs?.interest_bearing_debt ?? 0} onCommit={(v) => saveInput({ interest_bearing_debt: v ?? 0 })} ariaLabel="Interest-bearing debt" />
                </label>
                <label>Owner's target ("the number")
                  <MoneyInput initial={inputs?.owner_wealth_target ?? ''} onCommit={(v) => saveInput({ owner_wealth_target: v })} ariaLabel="Owner's wealth target" />
                </label>
              </div>
              {val?.has_recast && (
                <div className="scroll-x">
                <table className="val-net">
                  <tbody>
                    <tr><td>Enterprise value</td><td>{fmtCurrency(val.ev_base)}</td></tr>
                    <tr><td>− Interest-bearing debt</td><td>{fmtCurrency(-val.interest_bearing_debt)}</td></tr>
                    <tr><td>− Transaction costs ({Math.round(val.transaction_cost_pct * 100)}%)</td><td>{fmtCurrency(-val.transaction_costs)}</td></tr>
                    <tr><td>− Taxes ({Math.round(val.tax_rate * 100)}%)</td><td>{fmtCurrency(-val.taxes)}</td></tr>
                    <tr className="val-net-total"><td>Net to owner (estimated)</td><td>{fmtCurrency(val.net_proceeds)}</td></tr>
                  </tbody>
                </table>
                </div>
              )}
            </SectionCard>
          </div>
          <p className="muted val-disclaimer">
            Estimate only, from valuation rules {val?.rules_version}. Not an appraisal or a fairness opinion.
          </p>
        </>
      )}
    </div>
  );
}
