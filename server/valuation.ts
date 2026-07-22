// Phase 2: deterministic valuation. Turns a recast EBITDA into an enterprise-
// value range and the two gaps a CFP cares about — the value-creation gap (what
// finishing the roadmap is worth) and the wealth gap (can the owner afford to
// sell). Versioned valuation rules supply every number; no LLM computes a value.
//
//   defensible EBITDA = reported + add-backs a buyer likely accepts (low/medium)
//   base EV           = defensible EBITDA × multiple(industry,size) × readiness
//   EV range          = base ± width(verification tier)
//   net to owner       = base EV − debt − transaction costs − taxes
import type pg from 'pg';
import { verificationSummary } from './verification';
import { ownBookMultiple } from './comparables';
import { selectValuationMultiple, type OwnBookConfidence } from '../shared/own-book';

// Add-backs a buyer is likely to accept flow into the conservative EV base.
const DEFENSIBLE = new Set(['low', 'medium']);

function industryKeyFor(industry: string | null): string {
  const s = (industry ?? '').toLowerCase();
  if (/facilit|field|clean|hvac|landscap|electric|security|maintenance|roofing|services/.test(s)) return 'field_services';
  if (/manufactur|fabricat|machin|plastic|industrial|coating|precision/.test(s)) return 'manufacturing';
  if (/distribut|logistic|transport|supply|wholesale|marine/.test(s)) return 'distribution';
  if (/health|dental|medical|care|behavioral/.test(s)) return 'healthcare';
  if (/software|saas|tech|data|lattice|it\b/.test(s)) return 'software';
  return 'default';
}

export interface ValuationResult {
  has_recast: boolean;
  rules_version: string | null;
  currency: 'USD';
  reported_ebitda: number;
  defensible_ebitda: number;
  full_recast_ebitda: number;
  industry_key: string;
  size_band: string;
  base_multiple: number;
  multiple_source: 'table' | 'override' | 'own_book';
  // Own-book context (docs/09 §2, moat 2): the realized multiple from THIS FIRM'S
  // own closed deals in the same industry, shown ALONGSIDE the generic table
  // multiple. Null when the firm has no closed deals to draw on. `own_book_driving`
  // is true only when a versioned rules config elected to source the base multiple
  // from the own book — never an in-place recalibration (rule #6).
  own_book_sample_size: number | null;
  own_book_same_band: number | null;
  own_book_multiple: number | null; // median
  own_book_p25: number | null;
  own_book_p75: number | null;
  own_book_confidence: OwnBookConfidence | null;
  own_book_driving: boolean;
  drs_score: number | null;
  drs_tier: string | null;
  readiness_factor: number;
  verification_tier: string;
  range_width: number;
  ev_base: number;
  ev_low: number;
  ev_high: number;
  potential_ev: number; // EV if the business reached the target DRS tier
  value_creation_gap: number; // potential_ev − ev_base
  // Net-to-owner (from the base EV):
  interest_bearing_debt: number;
  transaction_cost_pct: number;
  transaction_costs: number;
  tax_rate: number;
  taxes: number;
  net_proceeds: number;
  owner_wealth_target: number | null;
  wealth_gap: number | null; // target − net_proceeds (positive = shortfall)
}

export async function computeValuation(
  db: pg.ClientBase,
  engagementId: string,
): Promise<ValuationResult> {
  const eng = (
    await db.query(`select id, firm_id, company_id from engagements where id = $1`, [engagementId])
  ).rows[0];
  if (!eng) throw new Error(`engagement ${engagementId} not found`);
  const company = (
    await db.query(`select industry, revenue_band from companies where id = $1`, [eng.company_id])
  ).rows[0];

  const rules = (
    await db.query(
      `select id, version_label, config from valuation_rules_versions
       where status = 'active' order by effective_date desc, created_at desc limit 1`,
    )
  ).rows[0];
  const config = (rules?.config ?? {}) as {
    size_bands?: { key: string; max: number | null }[];
    readiness_adjustments?: Record<string, number>;
    verification_widths?: Record<string, number>;
    transaction_cost_pct?: number;
    default_tax_rate?: number;
    target_drs?: number;
    // Own-book multiples (moat 2). Absent/disabled by default: the number is
    // unchanged. Enabling it is a NEW valuation_rules_version, never an in-place
    // edit (rule #6).
    corpus_multiples?: { enabled?: boolean; min_sample_size?: number };
  };

  const inputs = (
    await db.query(`select * from valuation_inputs where engagement_id = $1`, [engagementId])
  ).rows[0] ?? {};

  const recast = (
    await db.query(`select * from ebitda_recasts where engagement_id = $1`, [engagementId])
  ).rows[0];

  const empty = (): ValuationResult => ({
    has_recast: false,
    rules_version: rules?.version_label ?? null,
    currency: 'USD',
    reported_ebitda: 0, defensible_ebitda: 0, full_recast_ebitda: 0,
    industry_key: inputs.industry_key ?? industryKeyFor(company?.industry ?? null),
    size_band: 'lt_1m', base_multiple: 0, multiple_source: 'table',
    own_book_sample_size: null, own_book_same_band: null, own_book_multiple: null,
    own_book_p25: null, own_book_p75: null, own_book_confidence: null, own_book_driving: false,
    drs_score: null, drs_tier: null, readiness_factor: 1, verification_tier: 'self_reported',
    range_width: 0, ev_base: 0, ev_low: 0, ev_high: 0, potential_ev: 0, value_creation_gap: 0,
    interest_bearing_debt: Number(inputs.interest_bearing_debt ?? 0),
    transaction_cost_pct: 0, transaction_costs: 0, tax_rate: 0, taxes: 0, net_proceeds: 0,
    owner_wealth_target: inputs.owner_wealth_target != null ? Number(inputs.owner_wealth_target) : null,
    wealth_gap: null,
  });
  if (!recast) return empty();

  const addbacks = (
    await db.query(`select amount, challenge_likelihood from ebitda_addbacks where recast_id = $1`, [recast.id])
  ).rows;
  const reported = Number(recast.reported_ebitda);
  const fullRecast = reported + addbacks.reduce((s, a) => s + Number(a.amount), 0);
  const defensible = reported + addbacks
    .filter((a) => DEFENSIBLE.has(a.challenge_likelihood))
    .reduce((s, a) => s + Number(a.amount), 0);

  // Size band from the defensible EBITDA.
  const bands = config.size_bands ?? [{ key: 'gt_5m', max: null }];
  const sizeBand = (bands.find((b) => b.max != null && defensible <= b.max) ?? bands[bands.length - 1]).key;

  const industryKey = inputs.industry_key ?? industryKeyFor(company?.industry ?? null);
  const lookup = async (key: string) =>
    (
      await db.query(
        `select base_multiple from valuation_multiples
         where rules_version_id = $1 and industry_key = $2 and size_band = $3`,
        [rules.id, key, sizeBand],
      )
    ).rows[0]?.base_multiple;
  const tableMultiple = Number((await lookup(industryKey)) ?? (await lookup('default')) ?? 0);

  // Own-book multiple from this firm's realized deals (firm-scoped, service-role
  // read). Defensive: an own-book read must never break the authoritative number.
  let ownBook = null as Awaited<ReturnType<typeof ownBookMultiple>>;
  try {
    ownBook = await ownBookMultiple(db, {
      firmId: eng.firm_id,
      industry: company?.industry ?? null,
      sizeBand: company?.revenue_band ?? null,
    });
  } catch {
    ownBook = null;
  }
  const corpusCfg = config.corpus_multiples ?? {};
  const selection = selectValuationMultiple({
    tableMultiple,
    override: inputs.multiple_override != null ? Number(inputs.multiple_override) : null,
    ownBook,
    config: { enabled: !!corpusCfg.enabled, minSampleSize: corpusCfg.min_sample_size ?? 5 },
  });
  const baseMultiple = selection.multiple;
  const multipleSource = selection.source;

  // Readiness factor from the latest completed assessment's DRS tier.
  const assessment = (
    await db.query(
      `select id, drs_score, drs_tier from assessments
       where engagement_id = $1 and status = 'completed'
       order by completed_at desc nulls last, created_at desc limit 1`,
      [engagementId],
    )
  ).rows[0];
  const drsTier = assessment?.drs_tier ?? null;
  const readinessAdj = config.readiness_adjustments ?? {};
  const readinessFactor = drsTier ? readinessAdj[drsTier] ?? 1 : 1;

  // Verification tier → range width.
  let verificationTier = 'self_reported';
  if (assessment) verificationTier = (await verificationSummary(db, assessment.id)).tier;
  const width = (config.verification_widths ?? {})[verificationTier] ?? 0.3;

  const evBase = Math.round(defensible * baseMultiple * readinessFactor);
  const evLow = Math.round(evBase * (1 - width));
  const evHigh = Math.round(evBase * (1 + width));

  // Potential EV: same business at the target-DRS readiness tier.
  const targetTier = 'Institutional Grade';
  const potentialFactor = readinessAdj[targetTier] ?? readinessFactor;
  const potentialEv = Math.round(defensible * baseMultiple * potentialFactor);
  const valueCreationGap = Math.max(0, potentialEv - evBase);

  // Net to owner from the base EV.
  const debt = Number(inputs.interest_bearing_debt ?? 0);
  const tcostPct = inputs.transaction_cost_pct != null ? Number(inputs.transaction_cost_pct) : config.transaction_cost_pct ?? 0.08;
  const taxRate = inputs.tax_rate != null ? Number(inputs.tax_rate) : config.default_tax_rate ?? 0.28;
  const transactionCosts = Math.round(evBase * tcostPct);
  const equityBeforeTax = evBase - debt;
  const taxes = Math.round(Math.max(0, equityBeforeTax - transactionCosts) * taxRate);
  const netProceeds = equityBeforeTax - transactionCosts - taxes;
  const ownerTarget = inputs.owner_wealth_target != null ? Number(inputs.owner_wealth_target) : null;
  const wealthGap = ownerTarget != null ? ownerTarget - netProceeds : null;

  return {
    has_recast: true,
    rules_version: rules.version_label,
    currency: 'USD',
    reported_ebitda: reported,
    defensible_ebitda: defensible,
    full_recast_ebitda: fullRecast,
    industry_key: industryKey,
    size_band: sizeBand,
    base_multiple: baseMultiple,
    multiple_source: multipleSource,
    own_book_sample_size: ownBook?.sample_size ?? null,
    own_book_same_band: ownBook?.same_band_count ?? null,
    own_book_multiple: ownBook?.median ?? null,
    own_book_p25: ownBook?.p25 ?? null,
    own_book_p75: ownBook?.p75 ?? null,
    own_book_confidence: ownBook?.confidence ?? null,
    own_book_driving: selection.source === 'own_book',
    drs_score: assessment?.drs_score != null ? Number(assessment.drs_score) : null,
    drs_tier: drsTier,
    readiness_factor: readinessFactor,
    verification_tier: verificationTier,
    range_width: width,
    ev_base: evBase,
    ev_low: evLow,
    ev_high: evHigh,
    potential_ev: potentialEv,
    value_creation_gap: valueCreationGap,
    interest_bearing_debt: debt,
    transaction_cost_pct: tcostPct,
    transaction_costs: transactionCosts,
    tax_rate: taxRate,
    taxes,
    net_proceeds: netProceeds,
    owner_wealth_target: ownerTarget,
    wealth_gap: wealthGap,
  };
}
