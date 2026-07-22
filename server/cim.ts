// CIM (Confidential Information Memorandum) — the market-facing deliverable that
// packages an engagement's collected evidence into the buyer's marketing
// document. Two jobs live here:
//
//   1. buildCimCoverage — "posture evidence collection for the CIM": a rollup of
//      the existing per-engagement data-room readiness, grouped into CIM sections
//      via the shared template (shared/cim/template.ts). This is what tells an
//      advisor which parts of the CIM are backed by Ready/verified evidence and
//      what is still missing, and routes them back to the Evidence work stream.
//
//   2. buildCimPayload + composeCim — the structured inputs and the deterministic
//      composer for the generated CIM. Like every other narrative on the
//      platform this is prose assembled FROM structured data (CLAUDE.md rule 2):
//      it reads the explain trace, the valuation, the company profile and the
//      evidence coverage, and NEVER computes or writes a score. Because the CIM
//      is buyer-facing marketing, the payload deliberately carries strengths and
//      verified facts only — no gaps, no weaknesses, no internal DRS score — so
//      neither the composer nor the AI model can surface them.
import type pg from 'pg';
import { explainAssessment } from './scoring';
import { computeValuation } from './valuation';
import { listDataRoom, type DataRoomState } from './data-room';
import { interpretSubScore } from '../shared/scoring/interpret';
import { CIM_SECTIONS, type CimSectionDef } from '../shared/cim/template';

// --- Evidence coverage (posture) ---------------------------------------------

export interface CimMissingItem {
  item_code: string;
  label: string;
  section_code: string;
  readiness_state: DataRoomState;
}

export interface CimSectionCoverage {
  code: string;
  name: string;
  // Narrative-synthesis sections (no mapped evidence folder) carry no bar.
  narrative: boolean;
  itemsTotal: number; // in-scope items (excludes not_applicable)
  itemsReady: number; // readiness_state = 'ready'
  itemsVerified: number; // ready AND backed by a verified document
  pct: number; // itemsReady / itemsTotal, 0–100
  missing: CimMissingItem[]; // in-scope items not yet Ready — the work to collect
}

export interface CimCoverage {
  sections: CimSectionCoverage[];
  summary: {
    evidenceSections: number;
    itemsTotal: number;
    itemsReady: number;
    itemsVerified: number;
    pct: number;
  };
}

// The minimal per-item shape the rollup reads (a subset of DataRoomItemState).
export interface CoverageItem {
  section_code: string;
  item_code: string;
  label: string;
  readiness_state: DataRoomState;
  document_status: string | null;
}

/**
 * Pure rollup of data-room items into the CIM section structure — the testable
 * heart of buildCimCoverage. Groups items by their data-room section, maps those
 * onto CIM sections via the shared template, and counts Ready/verified/missing.
 * Adds no scoring; it only tallies readiness states.
 */
export function rollupCimCoverage(items: CoverageItem[]): CimCoverage {
  const bySection = new Map<string, CoverageItem[]>();
  for (const it of items) {
    const list = bySection.get(it.section_code) ?? [];
    list.push(it);
    bySection.set(it.section_code, list);
  }

  const sections: CimSectionCoverage[] = CIM_SECTIONS.map((def) => {
    const backing = def.evidence.flatMap((code) => bySection.get(code) ?? []);
    const inScope = backing.filter((i) => i.readiness_state !== 'not_applicable');
    const ready = inScope.filter((i) => i.readiness_state === 'ready');
    const verified = ready.filter((i) => i.document_status === 'verified');
    const missing = inScope
      .filter((i) => i.readiness_state !== 'ready')
      .map((i) => ({
        item_code: i.item_code,
        label: i.label,
        section_code: i.section_code,
        readiness_state: i.readiness_state,
      }));
    return {
      code: def.code,
      name: def.name,
      narrative: def.evidence.length === 0,
      itemsTotal: inScope.length,
      itemsReady: ready.length,
      itemsVerified: verified.length,
      pct: inScope.length === 0 ? 0 : Math.round((ready.length / inScope.length) * 100),
      missing,
    };
  });

  const evidenceSections = sections.filter((s) => !s.narrative);
  const itemsTotal = evidenceSections.reduce((a, s) => a + s.itemsTotal, 0);
  const itemsReady = evidenceSections.reduce((a, s) => a + s.itemsReady, 0);
  const itemsVerified = evidenceSections.reduce((a, s) => a + s.itemsVerified, 0);

  return {
    sections,
    summary: {
      evidenceSections: evidenceSections.length,
      itemsTotal,
      itemsReady,
      itemsVerified,
      pct: itemsTotal === 0 ? 0 : Math.round((itemsReady / itemsTotal) * 100),
    },
  };
}

/**
 * Roll up this engagement's data-room readiness into the CIM section structure.
 * Reuses listDataRoom (the same template + per-engagement state the Evidence page
 * reads), so the CIM and the data room can never drift. The caller is already
 * authorized on the engagement (functions.ts); no scoring happens here.
 */
export async function buildCimCoverage(
  db: pg.ClientBase,
  engagementId: string,
): Promise<CimCoverage> {
  const { items } = await listDataRoom(db, engagementId);
  return rollupCimCoverage(items);
}

// --- Generation payload (strengths + verified facts only) --------------------

export interface CimHighlight {
  area: string; // the business area (dimension) name
  facts: string[]; // plain-language, buyer-relevant readings from the explain trace
}

export interface CimPayload {
  company: {
    name: string;
    industry: string | null;
    revenue_band: string | null;
    ebitda_band: string | null;
    state: string | null;
  };
  highlights: CimHighlight[];
  financial: {
    adjusted_ebitda: number | null; // defensible (buyer-likely) recast EBITDA
    reported_ebitda: number | null;
    // Pre-formatted compact figures ("$3.2M"). Formatting happens server-side so
    // the narrative can present a clean currency figure without the numeral
    // firewall tripping on comma groups the model would otherwise introduce.
    adjusted_ebitda_display: string | null;
    reported_ebitda_display: string | null;
  };
  // Labels of diligence items already Ready — the evidence a buyer can verify.
  verified_evidence: string[];
  // The section scaffold (structure + guidance) the composer/prompt writes to.
  sections: { code: string; name: string; guidance: string }[];
}

// Strong sub-scores read as buyer-relevant facts; a weak one inside an otherwise
// strong dimension is left out so the CIM never leads with a soft point.
const STRENGTH_DIMENSION_MIN = 60; // dimension score to count as a headline strength
const STRENGTH_SUBSCORE_MIN = 50; // sub-score to surface as a supporting fact

export async function buildCimPayload(db: pg.ClientBase, assessmentId: string): Promise<CimPayload> {
  const assessment = (
    await db.query(
      `select a.id, a.engagement_id, e.company_id
       from active_assessments a join engagements e on e.id = a.engagement_id
       where a.id = $1 and a.status = 'completed'`,
      [assessmentId],
    )
  ).rows[0];
  if (!assessment) throw new Error(`assessment ${assessmentId} not found, not completed, or superseded`);

  const company = (
    await db.query(
      `select name, industry, revenue_band, ebitda_band, state from companies where id = $1`,
      [assessment.company_id],
    )
  ).rows[0];

  const explain = await explainAssessment(db, assessmentId);

  // Top business dimensions → investment highlights, each carried by its own
  // strongest sub-score readings. Gaps/weaknesses are never included.
  const subsByDim = new Map<string, typeof explain.subScores>();
  for (const s of explain.subScores) {
    const list = subsByDim.get(s.dimensionCode) ?? [];
    list.push(s);
    subsByDim.set(s.dimensionCode, list);
  }
  const highlights: CimHighlight[] = [...explain.dimensions]
    .sort((a, b) => b.score - a.score)
    .filter((d) => d.score >= STRENGTH_DIMENSION_MIN)
    .slice(0, 3)
    .map((d) => ({
      area: d.name,
      facts: (subsByDim.get(d.code) ?? [])
        .filter((s) => s.points >= STRENGTH_SUBSCORE_MIN)
        .sort((a, b) => b.points - a.points)
        .slice(0, 2)
        .map((s) => interpretSubScore(s).reading),
    }))
    .filter((h) => h.facts.length > 0);

  // Adjusted EBITDA (a real marketing figure) when a recast exists; never an
  // enterprise value or asking price — the CIM invites bids, it does not set one.
  const valuation = await computeValuation(db, assessment.engagement_id);
  const financial = valuation.has_recast
    ? {
        adjusted_ebitda: valuation.defensible_ebitda,
        reported_ebitda: valuation.reported_ebitda,
        adjusted_ebitda_display: fmtCompactUsd(valuation.defensible_ebitda),
        reported_ebitda_display: fmtCompactUsd(valuation.reported_ebitda),
      }
    : { adjusted_ebitda: null, reported_ebitda: null, adjusted_ebitda_display: null, reported_ebitda_display: null };

  // Ready evidence labels: the diligence-ready proof a buyer can request. Pulled
  // straight from the data room (Ready = the advisor has assembled that item).
  const dataRoom = await listDataRoom(db, assessment.engagement_id);
  const readyLabels = dataRoom.items
    .filter((i) => i.readiness_state === 'ready')
    .map((i) => i.label);

  return {
    company: {
      name: company.name,
      industry: company.industry ?? null,
      revenue_band: company.revenue_band ?? null,
      ebitda_band: company.ebitda_band ?? null,
      state: company.state ?? null,
    },
    highlights,
    financial,
    verified_evidence: readyLabels,
    sections: CIM_SECTIONS.map((s: CimSectionDef) => ({
      code: s.code,
      name: s.name,
      guidance: s.narrativeGuidance,
    })),
  };
}

// --- Deterministic composer (numeral-firewall-safe fallback) -----------------
// Assembles a structured CIM draft from the payload alone — no new numbers, no
// invented facts. Used when no AI_GATEWAY_API_KEY is set (demos, environments
// without a key) so a CIM always generates; the AI path produces richer prose
// from the same payload. Every number it emits comes from the payload, so
// numeralPostCheck(composeCim(payload), payload) is empty by construction.

// Compact USD for narrative figures: 3200000 -> "$3.2M", 850000 -> "$850K".
// Kept deliberately coarse (one decimal) so the presented figure is a clean
// marketing number; the exact value is never the point of a CIM.
export function fmtCompactUsd(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (abs >= 1_000) return `$${Math.round(n / 1_000)}K`;
  return `$${Math.round(n)}`;
}

export function composeCim(payload: CimPayload): string {
  const { company } = payload;
  const lines: string[] = [];

  lines.push(`# Confidential Information Memorandum — ${company.name}`);
  lines.push('');
  lines.push(
    '_This memorandum is confidential and is provided for the sole purpose of evaluating a potential transaction. It is a working draft assembled from the company’s prepared materials and is subject to the advisor’s review before distribution._',
  );
  lines.push('');

  for (const def of payload.sections) {
    lines.push(`## ${def.name}`);
    switch (def.code) {
      case 'HIGHLIGHTS': {
        if (payload.highlights.length === 0) {
          lines.push('Investment highlights will be finalized with the advisor from the assessment strengths.');
        } else {
          for (const h of payload.highlights) {
            const fact = h.facts[0] ? ` ${h.facts[0].replace(/\.$/, '')}.` : '';
            lines.push(`- **${h.area}.**${fact}`);
          }
        }
        break;
      }
      case 'OVERVIEW': {
        const bits: string[] = [];
        if (company.industry) bits.push(`operates in ${company.industry}`);
        if (company.state) bits.push(`is based in ${company.state}`);
        const tail = bits.length ? ` The company ${bits.join(' and ')}.` : '';
        lines.push(`${company.name} is presented here for a prospective buyer’s evaluation.${tail}`);
        break;
      }
      case 'FINANCIAL': {
        const adj = payload.financial.adjusted_ebitda_display;
        if (adj) {
          lines.push(
            `On a normalized basis the business generates adjusted EBITDA of ${adj}. Supporting financial statements are prepared for buyer diligence. No asking price is stated in this memorandum.`,
          );
        } else {
          const band = company.ebitda_band ? ` The company’s earnings profile is in the ${company.ebitda_band} range.` : '';
          lines.push(
            `A normalized financial summary will accompany this memorandum.${band} No asking price is stated here.`,
          );
        }
        if (company.revenue_band) lines.push(`Reported revenue is in the ${company.revenue_band} range.`);
        break;
      }
      default: {
        lines.push(def.guidance);
        break;
      }
    }

    // Note the diligence-ready evidence a buyer can request, where relevant.
    if (def.code === 'FINANCIAL' && payload.verified_evidence.length > 0) {
      lines.push('');
      lines.push(`Diligence-ready materials include: ${payload.verified_evidence.slice(0, 6).join('; ')}.`);
    }
    lines.push('');
  }

  return lines.join('\n').trimEnd();
}

// --- Teaser (blind profile) ---------------------------------------------------
// The first document a sell-side process sends: a short, ANONYMIZED summary that
// goes to the whole buyer universe before anyone signs an NDA. It reuses the
// CIM's strengths-only payload but must never reveal the company's identity — no
// company name — so a buyer can gauge interest without knowing whose business it
// is. Like the CIM it is numeral-firewall-safe by construction (only payload
// figures) and surfaces strengths only. The AI path (prompts/teaser.v1.md)
// writes richer prose from the same payload; this composer is the always-available
// fallback.
export function composeTeaser(payload: CimPayload): string {
  const { company, financial } = payload;
  const lines: string[] = [];

  lines.push('# Confidential Teaser');
  lines.push('');
  lines.push(
    '_This blind profile is confidential and is circulated to gauge interest in an acquisition opportunity. The company is not identified here; its identity and detailed materials are released only under a signed confidentiality agreement._',
  );
  lines.push('');

  // Anonymized overview — described by what it is, never who it is.
  lines.push('## The Opportunity');
  const bits: string[] = [];
  if (company.industry) bits.push(`operates in ${company.industry}`);
  if (company.state) bits.push(`is based in ${company.state}`);
  const descriptor = company.industry ? `a ${company.industry} business` : 'an established business';
  const overview = bits.length
    ? `The opportunity is ${descriptor} that ${bits.join(' and ')}.`
    : `The opportunity is ${descriptor}.`;
  lines.push(`${overview} The owner is exploring a sale and has prepared the business for a buyer's evaluation.`);
  lines.push('');

  // Investment highlights — the same strengths the CIM leads with.
  lines.push('## Why It Is Attractive');
  if (payload.highlights.length === 0) {
    lines.push('- Investment highlights will be finalized with the advisor from the assessment strengths.');
  } else {
    for (const h of payload.highlights) {
      const fact = h.facts[0] ? ` ${h.facts[0].replace(/\.$/, '')}.` : '';
      lines.push(`- **${h.area}.**${fact}`);
    }
  }
  lines.push('');

  // Financial snapshot — a marketing figure only; never an asking price.
  lines.push('## Financial Snapshot');
  if (financial.adjusted_ebitda_display) {
    lines.push(
      `On a normalized basis the business generates adjusted EBITDA of ${financial.adjusted_ebitda_display}. No asking price is stated in this teaser.`,
    );
  } else if (company.ebitda_band) {
    lines.push(`The company's earnings profile is in the ${company.ebitda_band} range. No asking price is stated here.`);
  } else {
    lines.push('A normalized financial summary is available under NDA. No asking price is stated here.');
  }
  if (company.revenue_band) lines.push(`Reported revenue is in the ${company.revenue_band} range.`);
  lines.push('');

  // Next step — the whole point of a teaser is to route an interested buyer to
  // the NDA and the full memorandum.
  lines.push('## Next Step');
  lines.push(
    'Interested parties should contact the advisor to execute a confidentiality agreement and receive the full Confidential Information Memorandum.',
  );

  return lines.join('\n').trimEnd();
}

// --- Management presentation ---------------------------------------------------
// The narrative an owner walks serious buyers through in a management meeting,
// after the CIM and behind an NDA — so it names the company. It is the equity
// story as a talking-point outline (agenda + one block per theme), not the
// prose memorandum the CIM is. Reuses the CIM's strengths-only payload, so it is
// buyer-safe and numeral-firewall-safe by construction; the AI path
// (prompts/management_presentation.v1.md) writes it out from the same payload.
export function composeManagementPresentation(payload: CimPayload): string {
  const { company, financial } = payload;
  const lines: string[] = [];

  lines.push(`# Management Presentation — ${company.name}`);
  lines.push('');
  lines.push(
    '_Talking-point outline for the management meeting. It is confidential and is provided under the parties’ confidentiality agreement as a working draft for the advisor’s review before use._',
  );
  lines.push('');

  // Agenda — the meeting's spine, drawn from the CIM section scaffold.
  lines.push('## Agenda');
  lines.push('- Company overview and history');
  lines.push('- The equity story: why this business is attractive');
  lines.push('- Products, market, and customers');
  lines.push('- Operations and the team');
  lines.push('- Financial summary');
  lines.push('- Growth plan and the opportunity ahead');
  lines.push('- Questions and diligence next steps');
  lines.push('');

  // Company overview.
  lines.push('## Company Overview');
  const bits: string[] = [];
  if (company.industry) bits.push(`operates in ${company.industry}`);
  if (company.state) bits.push(`is based in ${company.state}`);
  const tail = bits.length ? ` The company ${bits.join(' and ')}.` : '';
  lines.push(`${company.name} is presented here for the buyer's management meeting.${tail}`);
  lines.push('');

  // The equity story — the highlights, framed as the reasons to buy.
  lines.push('## The Equity Story');
  if (payload.highlights.length === 0) {
    lines.push('- The equity story will be finalized with the advisor from the assessment strengths.');
  } else {
    for (const h of payload.highlights) {
      lines.push(`- **${h.area}.**`);
      for (const f of h.facts) lines.push(`  - ${f.replace(/\.$/, '')}.`);
    }
  }
  lines.push('');

  // The remaining CIM sections become talking-point prompts, in order.
  const spoken = new Set(['HIGHLIGHTS', 'OVERVIEW', 'FINANCIAL']);
  for (const def of payload.sections) {
    if (spoken.has(def.code)) continue;
    lines.push(`## ${def.name}`);
    lines.push(`- ${def.guidance}`);
    lines.push('');
  }

  // Financial summary — a marketing figure only, never a price.
  lines.push('## Financial Summary');
  if (financial.adjusted_ebitda_display) {
    lines.push(
      `- On a normalized basis the business generates adjusted EBITDA of ${financial.adjusted_ebitda_display}.`,
    );
  } else if (company.ebitda_band) {
    lines.push(`- The company's earnings profile is in the ${company.ebitda_band} range.`);
  }
  if (company.revenue_band) lines.push(`- Reported revenue is in the ${company.revenue_band} range.`);
  lines.push('- No asking price is discussed in the management meeting; bids follow the process.');
  if (payload.verified_evidence.length > 0) {
    lines.push(`- Diligence-ready materials include: ${payload.verified_evidence.slice(0, 6).join('; ')}.`);
  }

  return lines.join('\n').trimEnd();
}
