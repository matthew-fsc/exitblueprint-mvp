// Buyer matching (buyer-matching design doc). Assembles the deterministic
// subject for an engagement — the company's firmographics + its latest DRS + open
// gap codes — and the firm's OWN active buyers/mandates, ranks them with the pure
// shared/buyer-matching.ts engine, and persists the ranked snapshot to
// buyer_matches. Firm-scoped exactly like engagementComparables: the engagement is
// already authorized, and everything else is constrained to its firm_id, so a firm
// only ever matches against its own book (CLAUDE.md rule 5). No LLM touches the
// rank (rule 1) — this module only reads structured data and calls the pure engine.
import type pg from 'pg';
import { rankBuyers, type BuyerMatch, type BuyerMatchSubject, type MandateCandidate } from '../shared/buyer-matching';

export interface EngagementBuyerMatches {
  subject: BuyerMatchSubject;
  matches: BuyerMatch[];
}

export async function rankEngagementBuyers(
  db: pg.ClientBase,
  engagementId: string,
): Promise<EngagementBuyerMatches> {
  const current = (
    await db.query(
      `select e.firm_id, c.industry, c.revenue_band, c.ebitda_band, c.state
       from engagements e join companies c on c.id = e.company_id
       where e.id = $1`,
      [engagementId],
    )
  ).rows[0] as
    | { firm_id: string; industry: string | null; revenue_band: string | null; ebitda_band: string | null; state: string | null }
    | undefined;
  if (!current) return { subject: emptySubject(), matches: [] };

  // Latest completed, active assessment — its DRS and id drive readiness fit.
  const latest = (
    await db.query(
      `select aa.id, aa.drs_score from active_assessments aa
       where aa.engagement_id = $1 and aa.status = 'completed' and aa.drs_score is not null
       order by aa.sequence_number desc limit 1`,
      [engagementId],
    )
  ).rows[0] as { id: string; drs_score: string | number } | undefined;

  const openGapCodes = (
    await db.query(
      `select gd.code from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [engagementId],
    )
  ).rows.map((r) => r.code as string);

  const subject: BuyerMatchSubject = {
    industry: current.industry,
    revenueBand: current.revenue_band,
    ebitdaBand: current.ebitda_band,
    state: current.state,
    drs: latest?.drs_score != null ? Number(latest.drs_score) : null,
    openGapCodes,
  };

  // The firm's own active book: active, non-archived buyers and their active
  // mandates. Strictly firm-scoped to the engagement's firm.
  const candidates: MandateCandidate[] = (
    await db.query(
      `select b.id as buyer_id, b.name as buyer_name, b.buyer_kind, b.relationship_strength,
              m.id as mandate_id, m.mandate_version, m.target_industries, m.target_revenue_bands,
              m.target_ebitda_bands, m.target_states, m.dealbreaker_gap_codes, m.min_drs
       from buyer_mandates m
       join buyers b on b.id = m.buyer_id
       where b.firm_id = $1 and b.archived = false and b.status = 'active' and m.status = 'active'`,
      [current.firm_id],
    )
  ).rows.map((r) => ({
    buyerId: r.buyer_id,
    buyerName: r.buyer_name,
    buyerKind: r.buyer_kind,
    relationshipStrength: r.relationship_strength,
    mandateId: r.mandate_id,
    mandateVersion: Number(r.mandate_version),
    targetIndustries: r.target_industries ?? [],
    targetRevenueBands: r.target_revenue_bands ?? [],
    targetEbitdaBands: r.target_ebitda_bands ?? [],
    targetStates: r.target_states ?? [],
    dealbreakerGapCodes: r.dealbreaker_gap_codes ?? [],
    minDrs: r.min_drs != null ? Number(r.min_drs) : null,
  }));

  const matches = rankBuyers(subject, candidates);

  // Persist the latest snapshot: replace this engagement's rows, then insert the
  // fresh ranking. Firm-scoped delete so we only ever touch this firm's rows.
  await db.query(`delete from buyer_matches where engagement_id = $1 and firm_id = $2`, [
    engagementId,
    current.firm_id,
  ]);
  for (const m of matches) {
    await db.query(
      `insert into buyer_matches
         (firm_id, engagement_id, assessment_id, buyer_id, mandate_id, mandate_version,
          match_score, blocked, match_factors, blockers)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        current.firm_id,
        engagementId,
        latest?.id ?? null,
        m.buyerId,
        m.mandateId,
        m.mandateVersion,
        m.score,
        m.blocked,
        JSON.stringify(m.factors),
        JSON.stringify(m.blockers),
      ],
    );
  }

  return { subject, matches };
}

function emptySubject(): BuyerMatchSubject {
  return { industry: null, revenueBand: null, ebitdaBand: null, state: null, drs: null, openGapCodes: [] };
}
