// Buyer matching (buyer-matching design doc): rank the firm's OWN book of
// buyers against an assessed company. Deterministic and pure, unit-tested exactly
// like the scoring engine — CLAUDE.md rule 1: no LLM ever computes or influences a
// match; the rank is rule-based, versioned code. AI only drafts the "why this
// fits" prose downstream, never the ranking.
//
// The differentiator (R7): a generic CRM matches on industry + size. Because we
// hold the DRS and the verified gap profile, we also match on READINESS FIT — a
// buyer whose mandate forbids key-person dependency against a company with an open
// OWNER_DEP gap is a BAD match today and a GOOD one once remediated. So a match is
// not a static lookup: dealbreakers and the DRS floor produce BLOCKERS ("clear
// these gaps → this buyer opens"), never silent exclusion, so the advisor can see
// the path.
//
// Industry is the one HARD gate: a buyer with an explicit sector box that the
// company falls outside of is not a match at all (real buyer boxes are hard on
// sector). Size and geography mismatches are soft (adjacent / flexible), so they
// cost points but never exclude.

export interface BuyerMatchSubject {
  industry: string | null;
  revenueBand: string | null;
  ebitdaBand: string | null;
  state: string | null;
  drs: number | null;
  openGapCodes: string[];
}

export interface MandateCandidate {
  buyerId: string;
  buyerName: string;
  buyerKind: string;
  relationshipStrength: string; // 'strong' | 'moderate' | 'weak' | 'unknown'
  mandateId: string;
  mandateVersion: number;
  targetIndustries: string[];
  targetRevenueBands: string[];
  targetEbitdaBands: string[];
  targetStates: string[];
  dealbreakerGapCodes: string[];
  minDrs: number | null;
}

export interface BuyerMatch extends MandateCandidate {
  score: number;
  blocked: boolean;
  factors: string[]; // positive: why it fits
  blockers: string[]; // what blocks it now — the "clear these to unblock" trace
}

const W_INDUSTRY = 4;
const W_REVENUE = 2;
const W_EBITDA = 2;
const W_STATE = 1;
const W_READINESS = 2; // meets the mandate's DRS floor
const W_CLEAN = 2; // no dealbreaker gap is open

// Strong relationships break score ties — who the advisor can actually call.
const RELATIONSHIP_RANK: Record<string, number> = { strong: 0, moderate: 1, weak: 2, unknown: 3 };

function inList(value: string | null, list: string[]): boolean {
  return value != null && list.includes(value);
}

/**
 * Rank the firm's buyer mandates against an assessed company. Industry is a hard
 * gate (a buyer outside its declared sector box is dropped); size/geography are
 * soft (points, never exclusion). Dealbreaker gaps and the DRS floor mark a match
 * `blocked` with the reason to clear, rather than hiding it. Unblocked matches
 * sort ahead of blocked ones, then by score, then by relationship strength.
 */
export function rankBuyers(
  subject: BuyerMatchSubject,
  candidates: MandateCandidate[],
  limit?: number,
): BuyerMatch[] {
  const openGaps = new Set(subject.openGapCodes);
  const out: BuyerMatch[] = [];

  for (const c of candidates) {
    // Hard gate: an explicit sector box the company falls outside of is a no-match.
    if (
      c.targetIndustries.length > 0 &&
      subject.industry != null &&
      !c.targetIndustries.includes(subject.industry)
    ) {
      continue;
    }

    let score = 0;
    const factors: string[] = [];
    const blockers: string[] = [];

    if (inList(subject.industry, c.targetIndustries)) {
      score += W_INDUSTRY;
      factors.push(`Industry match (${subject.industry})`);
    }
    if (inList(subject.revenueBand, c.targetRevenueBands)) {
      score += W_REVENUE;
      factors.push('Revenue in target band');
    }
    if (inList(subject.ebitdaBand, c.targetEbitdaBands)) {
      score += W_EBITDA;
      factors.push('EBITDA in target band');
    }
    if (inList(subject.state, c.targetStates)) {
      score += W_STATE;
      factors.push('In target geography');
    }

    // Readiness fit — the DRS floor. Unknown DRS with a floor set can't be
    // confirmed, so it blocks (honest: we haven't proven readiness).
    if (c.minDrs != null) {
      if (subject.drs == null) {
        blockers.push(`Not yet assessed (mandate floor DRS ${c.minDrs})`);
      } else if (subject.drs >= c.minDrs) {
        score += W_READINESS;
        factors.push(`Meets DRS floor (${c.minDrs})`);
      } else {
        blockers.push(`Below DRS floor (${subject.drs} < ${c.minDrs})`);
      }
    }

    // Dealbreaker gaps — the readiness-fit differentiator. An open dealbreaker
    // gap blocks the match with the code to clear; a clean profile earns points.
    const openDealbreakers = c.dealbreakerGapCodes.filter((g) => openGaps.has(g));
    if (openDealbreakers.length > 0) {
      for (const g of openDealbreakers) blockers.push(`Open dealbreaker: ${g}`);
    } else if (c.dealbreakerGapCodes.length > 0) {
      score += W_CLEAN;
      factors.push('No dealbreakers open');
    }

    out.push({ ...c, score, blocked: blockers.length > 0, factors, blockers });
  }

  // Unblocked first, then score desc, then relationship strength, then name.
  out.sort((a, b) => {
    if (a.blocked !== b.blocked) return a.blocked ? 1 : -1;
    if (b.score !== a.score) return b.score - a.score;
    const ar = RELATIONSHIP_RANK[a.relationshipStrength] ?? 3;
    const br = RELATIONSHIP_RANK[b.relationshipStrength] ?? 3;
    if (ar !== br) return ar - br;
    return a.buyerName.localeCompare(b.buyerName);
  });

  return limit != null ? out.slice(0, limit) : out;
}
