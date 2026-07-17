// The "three legs of the stool" — the CEPA Discover-gate frame. A successful
// exit needs the BUSINESS leg (transferable value), the PERSONAL leg (the
// owner's post-exit vision and plan — the most overlooked leg), and the
// FINANCIAL leg (does a sale actually fund the owner's goal?) to be balanced.
// If one leg is short, the stool wobbles. This assembles the three from data
// the platform already produces (DRS/tier, ORI, and the valuation's wealth gap)
// into the single aligned readout a CEPA leads an engagement with.
//
// Pure and deterministic — no engine, no LLM, no network. Unit-tested in
// tests/alignment.test.ts.

export type LegBand = 'strong' | 'building' | 'attention' | 'unknown';
export type LegKey = 'business' | 'personal' | 'financial';

export interface AlignmentLeg {
  key: LegKey;
  label: string;
  band: LegBand;
  /** Short headline value, e.g. "72 · Sale Ready" or "$1.2M gap". */
  headline: string;
  detail: string;
}

export interface Alignment {
  legs: AlignmentLeg[];
  /** The shortest known leg — where value acceleration should focus first. */
  shortest: LegKey | null;
  /** True when every known leg sits within one band of the others. */
  balanced: boolean;
  verdict: string;
  /** Which Value Acceleration gate the engagement is effectively at. */
  gate: 'Discover' | 'Prepare' | 'Decide';
  gateHint: string;
}

export interface AlignmentInput {
  drs: number | null;
  tier: string | null;
  ori: number | null;
  hasValuation: boolean;
  wealthGap: number | null; // > 0 = shortfall vs the owner's goal
  netProceeds: number | null;
  ownerWealthTarget: number | null;
  openGapCodes: string[];
}

const BAND_RANK: Record<LegBand, number> = { attention: 0, building: 1, strong: 2, unknown: 3 };
const STRONG_TIERS = new Set(['Institutional Grade', 'Sale Ready']);
const WEAK_TIERS = new Set(['High Risk', 'Not Saleable (Yet)']);

export function fmtUsdShort(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${sign}$${Math.round(abs / 1_000)}K`;
  return `${sign}$${Math.round(abs)}`;
}

function businessLeg(input: AlignmentInput): AlignmentLeg {
  const { drs, tier } = input;
  let band: LegBand = 'unknown';
  if (tier && STRONG_TIERS.has(tier)) band = 'strong';
  else if (tier && WEAK_TIERS.has(tier)) band = 'attention';
  else if (tier) band = 'building'; // Needs Work
  const headline = drs != null ? `${Math.round(drs)}${tier ? ` · ${tier}` : ''}` : 'Not assessed';
  const detail =
    band === 'strong'
      ? 'Transferable value a buyer can underwrite.'
      : band === 'building'
        ? 'Real value, but gaps a buyer will price. Keep building transferability.'
        : band === 'attention'
          ? 'The business is not yet transferable — build value before a sale is forced.'
          : 'Run an assessment to measure business readiness.';
  return { key: 'business', label: 'Business', band, headline, detail };
}

function personalLeg(input: AlignmentInput): AlignmentLeg {
  const { ori, openGapCodes } = input;
  const timelineMismatch = openGapCodes.includes('TIMELINE_MISMATCH');
  let band: LegBand = 'unknown';
  if (ori != null) {
    if (ori >= 70) band = 'strong';
    else if (ori >= 55) band = 'building';
    else band = 'attention';
  }
  // Wanting to exit soon while readiness lags pulls the personal leg down.
  if (timelineMismatch && band !== 'unknown' && BAND_RANK[band] > BAND_RANK.attention) {
    band = band === 'strong' ? 'building' : 'attention';
  }
  const headline = ori != null ? `ORI ${Math.round(ori)}${timelineMismatch ? ' · timeline risk' : ''}` : 'Not assessed';
  const detail = timelineMismatch
    ? 'The owner wants to exit sooner than the business is ready — align the timeline and the transition plan.'
    : band === 'strong'
      ? 'Clear post-exit vision and transition plan.'
      : band === 'building'
        ? 'Goals are forming; firm up the post-exit vision and the owner’s next chapter.'
        : band === 'attention'
          ? 'The most overlooked leg — the owner’s post-exit identity and plan need work.'
          : 'Capture the owner’s goals, timeline, and post-exit vision.';
  return { key: 'personal', label: 'Personal', band, headline, detail };
}

function financialLeg(input: AlignmentInput): AlignmentLeg {
  const { hasValuation, wealthGap, netProceeds, ownerWealthTarget, openGapCodes } = input;
  const personalValueGap = openGapCodes.includes('VALUE_GAP');

  if (!hasValuation || (wealthGap == null && netProceeds == null)) {
    return {
      key: 'financial',
      label: 'Financial',
      band: personalValueGap ? 'attention' : 'unknown',
      headline: personalValueGap ? 'Value gap flagged' : 'Not yet quantified',
      detail: personalValueGap
        ? 'The owner’s outside assets and confidence suggest a shortfall — quantify it: capture financials and a wealth target.'
        : 'Capture financials and the owner’s wealth target to size the wealth gap a sale must close.',
    };
  }

  let band: LegBand;
  let headline: string;
  let detail: string;
  if (wealthGap == null) {
    band = personalValueGap ? 'attention' : 'building';
    headline = netProceeds != null ? `${fmtUsdShort(netProceeds)} net` : 'Partly quantified';
    detail = 'Net proceeds are estimated, but no wealth target is set — add one to size the gap.';
  } else if (wealthGap <= 0) {
    band = 'strong';
    headline = 'Goal covered';
    detail = `A sale today nets ${netProceeds != null ? fmtUsdShort(netProceeds) : 'enough'} — at or above the owner’s target. The financial leg is solid.`;
  } else {
    const target = ownerWealthTarget ?? 0;
    const ratio = target > 0 ? wealthGap / target : 1;
    band = ratio <= 0.2 ? 'building' : 'attention';
    headline = `${fmtUsdShort(wealthGap)} gap`;
    detail = `A sale today nets ${netProceeds != null ? fmtUsdShort(netProceeds) : 'less than'} against a ${
      ownerWealthTarget != null ? fmtUsdShort(ownerWealthTarget) : 'stated'
    } goal — a ${fmtUsdShort(wealthGap)} wealth gap value acceleration must close.`;
  }
  if (personalValueGap && BAND_RANK[band] > BAND_RANK.attention) band = 'building';
  return { key: 'financial', label: 'Financial', band, headline, detail };
}

export function buildAlignment(input: AlignmentInput): Alignment {
  const legs = [businessLeg(input), personalLeg(input), financialLeg(input)];
  const known = legs.filter((l) => l.band !== 'unknown');

  // Shortest known leg (business tie-breaks before personal before financial only
  // as a stable order; the band rank is what matters).
  let shortest: LegKey | null = null;
  let worst = 99;
  for (const l of known) {
    if (BAND_RANK[l.band] < worst) {
      worst = BAND_RANK[l.band];
      shortest = l.key;
    }
  }

  const ranks = known.map((l) => BAND_RANK[l.band]);
  const balanced = known.length > 0 && Math.max(...ranks) - Math.min(...ranks) <= 1;
  const allStrong = known.length === 3 && known.every((l) => l.band === 'strong');
  const anyAttention = legs.some((l) => l.band === 'attention');
  const anyUnknown = legs.some((l) => l.band === 'unknown');

  const shortLeg = legs.find((l) => l.key === shortest);
  let verdict: string;
  if (anyUnknown && known.length < 3) {
    verdict =
      'The picture is incomplete — finish the assessment and capture financials so all three legs can be aligned.';
  } else if (allStrong) {
    verdict = 'The three legs are aligned and strong. This owner can weigh holding versus a transaction from a position of strength.';
  } else if (balanced) {
    verdict = 'The three legs move together but none is yet strong — early in the arc. Prioritize the action plan across all three.';
  } else if (shortLeg?.key === 'financial') {
    verdict = `The financial leg is the short one: ${shortLeg.headline.toLowerCase().includes('gap') ? `a ${shortLeg.headline}` : shortLeg.headline}. A sale won’t fund the owner’s goal yet — value acceleration must close it before a triggering event.`;
  } else if (shortLeg?.key === 'personal') {
    verdict = 'The personal leg is the short one — the business may be sellable, but the owner’s post-exit plan isn’t ready. Align it before going to market.';
  } else if (shortLeg?.key === 'business') {
    verdict = 'The business leg is the short one — build transferable value before the owner’s timeline or a life event forces a sale.';
  } else {
    verdict = 'Keep the three legs moving together toward a balanced, sale-ready position.';
  }

  // Value Acceleration gate the engagement is effectively at.
  let gate: Alignment['gate'];
  let gateHint: string;
  if (anyUnknown && known.length < 3) {
    gate = 'Discover';
    gateHint = 'Discover gate — assess, value, and align the three legs into a prioritized action plan.';
  } else if (allStrong) {
    gate = 'Decide';
    gateHint = 'Decide gate — weigh advanced value creation against going to market.';
  } else {
    gate = 'Prepare';
    gateHint = anyAttention
      ? `Prepare gate — run 90-day sprints on the ${shortLeg?.label.toLowerCase() ?? 'short'} leg first.`
      : 'Prepare gate — execute the plan on parallel paths (business + personal-financial).';
  }

  return { legs, shortest, balanced, verdict, gate, gateHint };
}
