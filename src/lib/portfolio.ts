// Portfolio row assembly (F2), extracted from the usePortfolio hook so it can be
// unit-tested without a browser/Supabase client. Pure: it takes already-fetched
// rows and returns the dashboard rows. No network, no React.
//
// The DRS delta is rubric-version-aware on purpose. A DRS produced under one
// rubric_version is not on the same scale as one produced under another, so the
// difference of two cross-version scores is meaningless. Build-plan S10 is
// explicit: "when the prior assessment is on a different rubric_version, the
// delta column shows the incomparable state distinctly (e.g. 'new rubric'),
// never blank or zero." So we never subtract across versions — we mark the row
// incomparable and let the UI say so, instead of silently showing a bogus number.

export interface PortfolioEngagementInput {
  id: string;
  company_id: string;
  status: string;
}

export interface PortfolioCompanyInput {
  id: string;
  name: string;
  industry: string | null;
}

export interface PortfolioAssessmentInput {
  id: string;
  engagement_id: string;
  rubric_version_id: string;
  sequence_number: number;
  status: 'in_progress' | 'completed';
  completed_at: string | null;
  drs_score: number | null;
  drs_tier: string | null;
  ori_score: number | null;
}

export interface PortfolioGapInput {
  engagement_id: string;
  status: string;
}

// 'none' — no prior assessment to compare against.
// 'value' — a real numeric delta (same rubric_version).
// 'incomparable' — a prior exists but on a different rubric_version, so no number.
export type DeltaState = 'none' | 'value' | 'incomparable';

export interface PortfolioRow {
  engagementId: string;
  companyName: string;
  industry: string | null;
  status: string;
  latestDrs: number | null;
  latestTier: string | null;
  latestOri: number | null;
  latestAt: string | null;
  priorDrs: number | null;
  delta: number | null;
  deltaState: DeltaState;
  points: { seq: number; drs: number; tier: string | null }[];
  openGaps: number;
  assessmentCount: number;
}

export function buildPortfolioRows(
  engagements: PortfolioEngagementInput[],
  companies: PortfolioCompanyInput[],
  assessments: PortfolioAssessmentInput[],
  gaps: PortfolioGapInput[],
): PortfolioRow[] {
  const companyById = new Map(companies.map((c) => [c.id, c]));

  const byEngagement = new Map<string, PortfolioAssessmentInput[]>();
  for (const a of assessments) {
    const list = byEngagement.get(a.engagement_id) ?? [];
    list.push(a);
    byEngagement.set(a.engagement_id, list);
  }

  const openByEngagement = new Map<string, number>();
  for (const g of gaps) {
    openByEngagement.set(g.engagement_id, (openByEngagement.get(g.engagement_id) ?? 0) + 1);
  }

  return engagements.map((e) => {
    const list = (byEngagement.get(e.id) ?? []).sort((a, b) => a.sequence_number - b.sequence_number);
    const latest = list[list.length - 1] ?? null;
    const prior = list.length > 1 ? list[list.length - 2] : null;
    const company = companyById.get(e.company_id);
    const latestDrs = latest?.drs_score != null ? Number(latest.drs_score) : null;
    const priorDrs = prior?.drs_score != null ? Number(prior.drs_score) : null;

    // Only subtract when both scores exist AND share a rubric_version. A prior on
    // a different rubric is reported as 'incomparable' — never a number, never a
    // silent zero (build-plan S10 / docs/03 "Deltas and rubric versioning").
    let delta: number | null = null;
    let deltaState: DeltaState = 'none';
    if (latest && prior && latestDrs != null && priorDrs != null) {
      if (latest.rubric_version_id === prior.rubric_version_id) {
        delta = Math.round((latestDrs - priorDrs) * 10) / 10;
        deltaState = 'value';
      } else {
        deltaState = 'incomparable';
      }
    }

    return {
      engagementId: e.id,
      companyName: company?.name ?? '—',
      industry: company?.industry ?? null,
      status: e.status,
      latestDrs,
      latestTier: latest?.drs_tier ?? null,
      latestOri: latest?.ori_score != null ? Number(latest.ori_score) : null,
      latestAt: latest?.completed_at ?? null,
      priorDrs,
      delta,
      deltaState,
      points: list
        .filter((a) => a.drs_score != null)
        .map((a) => ({ seq: a.sequence_number, drs: Number(a.drs_score), tier: a.drs_tier })),
      openGaps: openByEngagement.get(e.id) ?? 0,
      assessmentCount: list.length,
    } satisfies PortfolioRow;
  });
}
