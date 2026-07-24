// Comparable engagements (docs/20/21 Category B): find prior engagements in the
// SAME firm that resemble this one (industry, size, shared gaps), so an advisor
// learns from their own book. Firm-scoped — the current engagement is already
// authorized; siblings are constrained to its firm_id (never cross-firm).
import type pg from 'pg';
import { rankComparables, type ComparableCandidate, type Comparable } from '../shared/comparables';
import { aggregateOwnBook, type OwnBookMultiple, type MarketMultiple } from '../shared/own-book';

// ── Own-book valuation multiple (docs/09 §2, moat 2) ──────────────────────────
// The realized EV/EBITDA multiple from THIS FIRM'S OWN closed deals in the same
// industry — so valuation can refine its multiple "from our own book" alongside
// the generic industry/size table. Firm-scoped, exactly like engagementComparables
// above: strictly `o.firm_id = $firmId`, so a firm only ever sees its own realized
// deals (CLAUDE.md §5). This is NOT the cross-firm benchmarking pool — that stays
// service-role-only in the `analytics` schema (server/financial-corpus.ts). The
// aggregation itself is the pure, unit-tested shared/own-book.ts.
//
// Runs on the service-role connection inside computeValuation; the explicit
// firm_id filter (the caller is already authorized on this engagement) is the
// isolation boundary, mirroring server/outcomes.ts firmCalibration.
export async function ownBookMultiple(
  db: pg.ClientBase,
  args: { firmId: string; industry: string | null; sizeBand: string | null },
): Promise<OwnBookMultiple | null> {
  if (!args.industry) return null; // no industry to match own-book deals against

  const deals = (
    await db.query(
      `select o.final_multiple as multiple, c.revenue_band as size_band
       from deal_outcomes o
       join engagements e on e.id = o.engagement_id
       join companies c on c.id = e.company_id
       where o.firm_id = $1
         and o.outcome = 'closed'
         and o.final_multiple is not null
         and c.industry = $2`,
      [args.firmId, args.industry],
    )
  ).rows.map((r) => ({ multiple: Number(r.multiple), sizeBand: r.size_band as string | null }));

  return aggregateOwnBook(deals, args.sizeBand);
}

// ── Market reference multiple (docs/sellside-ai/01, build order step 1) ───────────
// The licensed sector multiple for a subject's industry_key × size band, read from
// the NON-TENANT `market` schema (20260724013906_market_reference_schema.sql).
//
// ISOLATION — deliberately NOT firm-scoped. Unlike ownBookMultiple above (which is
// STRICTLY `o.firm_id = $firmId`, a firm only ever sees its own realized deals),
// `market` is GLOBAL LICENSED REFERENCE DATA, not any firm's tenant data — the
// explicit CLAUDE.md §5 non-tenant exception (docs/sellside-ai/01 "Data model").
// There is no firm_id to filter on; any per-license exposure limit is enforced by
// this retrieval layer, not RLS. The caller is already authorized on the engagement;
// the industry_key/size_band it passes were derived from that engagement's own data.
//
// Picks the most authoritative row: the most-recent dataset (`as_of`), breaking ties
// by the largest sample. Returns null when nothing matches — the caller (valuation)
// treats absence as "no market candidate" and falls back to the table multiple.
export async function marketMultiple(
  db: pg.ClientBase,
  args: { industryKey: string; sizeBand: string },
): Promise<MarketMultiple | null> {
  const row = (
    await db.query(
      `select m.median_multiple, m.p25_multiple, m.p75_multiple, m.sample_size
         from market.multiples m
         join market.datasets d on d.id = m.dataset_id
        where m.industry_key = $1 and m.size_band = $2
        order by d.as_of desc nulls last, m.as_of desc nulls last, m.sample_size desc
        limit 1`,
      [args.industryKey, args.sizeBand],
    )
  ).rows[0];
  if (!row) return null;

  return {
    median: Number(row.median_multiple),
    p25: row.p25_multiple != null ? Number(row.p25_multiple) : Number(row.median_multiple),
    p75: row.p75_multiple != null ? Number(row.p75_multiple) : Number(row.median_multiple),
    sample_size: Number(row.sample_size ?? 0),
  };
}

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
