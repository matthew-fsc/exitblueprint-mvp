// Comparable engagements (docs/20/21 Category B): surface "relevant historical
// cases" from the advisor's OWN book — prior engagements like this one, by
// industry, size, and shared preparation gaps — so institutional memory informs
// the current engagement. Firm-scoped only (cross-firm benchmarking is a separate,
// anonymized, out-of-scope layer). Pure and deterministic; unit-tested.

export interface ComparableCandidate {
  engagementId: string;
  companyName: string;
  industry: string | null;
  sizeBand: string | null;
  drs: number | null;
  tier: string | null;
  outcomeStatus: string | null; // e.g. 'closed' | 'in_market' | null
  openGapCodes: string[];
}

export interface ComparableSubject {
  industry: string | null;
  sizeBand: string | null;
  openGapCodes: string[];
}

export interface Comparable extends ComparableCandidate {
  score: number;
  reasons: string[];
  sharedGaps: string[];
}

const W_INDUSTRY = 3;
const W_SIZE = 2;
const W_GAP = 1;

/**
 * Rank candidate engagements by similarity to the subject. Same industry and
 * size band weigh most; each shared open gap adds a point. Only positive matches
 * are returned, most-similar first, capped to `limit`.
 */
export function rankComparables(
  subject: ComparableSubject,
  candidates: ComparableCandidate[],
  limit = 5,
): Comparable[] {
  const subjectGaps = new Set(subject.openGapCodes);
  const out: Comparable[] = [];

  for (const c of candidates) {
    let score = 0;
    const reasons: string[] = [];

    if (subject.industry && c.industry && subject.industry === c.industry) {
      score += W_INDUSTRY;
      reasons.push(`Same industry (${c.industry})`);
    }
    if (subject.sizeBand && c.sizeBand && subject.sizeBand === c.sizeBand) {
      score += W_SIZE;
      reasons.push('Same size band');
    }
    const sharedGaps = c.openGapCodes.filter((g) => subjectGaps.has(g));
    if (sharedGaps.length > 0) {
      score += W_GAP * sharedGaps.length;
      reasons.push(`${sharedGaps.length} shared gap${sharedGaps.length > 1 ? 's' : ''}`);
    }

    if (score > 0) out.push({ ...c, score, reasons, sharedGaps });
  }

  // Sort by score desc; break ties by a closed outcome first (most instructive),
  // then by name for stability.
  out.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const ao = a.outcomeStatus === 'closed' ? 0 : 1;
    const bo = b.outcomeStatus === 'closed' ? 0 : 1;
    if (ao !== bo) return ao - bo;
    return a.companyName.localeCompare(b.companyName);
  });

  return out.slice(0, limit);
}
