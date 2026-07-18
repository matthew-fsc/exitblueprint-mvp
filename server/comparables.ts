// Comparable engagements (docs/20/21 Category B): find prior engagements in the
// SAME firm that resemble this one (industry, size, shared gaps), so an advisor
// learns from their own book. Firm-scoped — the current engagement is already
// authorized; siblings are constrained to its firm_id (never cross-firm).
import type pg from 'pg';
import { rankComparables, type ComparableCandidate, type Comparable } from '../shared/comparables';

export async function engagementComparables(
  db: pg.ClientBase,
  engagementId: string,
): Promise<{ comparables: Comparable[] }> {
  const current = (
    await db.query(
      `select e.firm_id, c.industry, c.revenue_band as size_band
       from engagements e join companies c on c.id = e.company_id
       where e.id = $1`,
      [engagementId],
    )
  ).rows[0] as { firm_id: string; industry: string | null; size_band: string | null } | undefined;
  if (!current) return { comparables: [] };

  const subjectGaps = (
    await db.query(
      `select gd.code from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')`,
      [engagementId],
    )
  ).rows.map((r) => r.code as string);

  // Sibling engagements in the same firm, with latest DRS and outcome status.
  const siblings = (
    await db.query(
      `select e.id as engagement_id, c.name as company_name, c.industry,
              c.revenue_band as size_band, a.drs_score as drs, a.drs_tier as tier,
              eo.process_status as outcome_status
       from engagements e
       join companies c on c.id = e.company_id
       left join lateral (
         select aa.drs_score, aa.drs_tier from active_assessments aa
         where aa.engagement_id = e.id and aa.status = 'completed' and aa.drs_score is not null
         order by aa.sequence_number desc limit 1
       ) a on true
       left join engagement_outcomes eo on eo.engagement_id = e.id
       where e.firm_id = $1 and e.id <> $2`,
      [current.firm_id, engagementId],
    )
  ).rows;

  // Open gaps per sibling, in one pass.
  const gapRows = (
    await db.query(
      `select g.engagement_id, gd.code
       from gaps g join gap_definitions gd on gd.id = g.gap_definition_id
       join engagements e on e.id = g.engagement_id
       where e.firm_id = $1 and g.status in ('open', 'in_remediation')`,
      [current.firm_id],
    )
  ).rows;
  const gapsByEngagement = new Map<string, string[]>();
  for (const r of gapRows) {
    const arr = gapsByEngagement.get(r.engagement_id) ?? [];
    arr.push(r.code);
    gapsByEngagement.set(r.engagement_id, arr);
  }

  const candidates: ComparableCandidate[] = siblings.map((s) => ({
    engagementId: s.engagement_id,
    companyName: s.company_name,
    industry: s.industry,
    sizeBand: s.size_band,
    drs: s.drs != null ? Number(s.drs) : null,
    tier: s.tier,
    outcomeStatus: s.outcome_status,
    openGapCodes: gapsByEngagement.get(s.engagement_id) ?? [],
  }));

  const comparables = rankComparables(
    { industry: current.industry, sizeBand: current.size_band, openGapCodes: subjectGaps },
    candidates,
  );
  return { comparables };
}
