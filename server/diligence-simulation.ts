// Diligence Simulation (docs/20 "AI as an intelligence layer", docs/40 §3): the
// PROACTIVE half of the buyer lens, built directly on top of the institutional
// reviewer. server/institutional-review.ts assembles the read-only picture of an
// assessment (the deterministic scores + gaps, the evidence/verification posture,
// the fired buyer-lens items) and drafts prose. This module takes that SAME
// ReviewPayload and turns it into a RANKED, SEVERITY-KEYED BLIND-SPOT REPORT: each
// finding carries a severity, the diligence area it maps to, WHY a sophisticated
// diligence process would flag it, and a remediation pointer to the relevant Plan
// / Library item / evidence / roadmap. It then PERSISTS the run as an immutable
// snapshot. The point is to run diligence against the business while the owner
// still has 12-36 months to fix what it surfaces.
//
// This is an extension of institutional-review, not a parallel scorer:
//   * The deterministic facts come from buildInstitutionalReviewPayload (reused
//     verbatim) plus a thin remediation/area enrichment. The findings, their
//     severity, and their pointers are assembled server-side by pure functions
//     (assembleDiligenceFindings / rankFindings), NEVER by the model (CLAUDE.md
//     rule 1).
//   * The AI is an institutional reviewer of NARRATIVE ONLY: given the finished,
//     ranked findings it frames them as a diligence rehearsal. It never computes,
//     adjusts, influences, or grades a score. numeralPostCheck (reused from
//     narrative.ts) rejects any numeral the payload did not already contain
//     (rule 2). Every run narrative is labeled DRAFT and carries a prompt_version.
//   * Runs are immutable snapshots (rule 4): a run and its findings are inserted
//     once and never updated; re-running produces a NEW run (rule 6 versioning).
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type pg from 'pg';
import { explainAssessment } from './scoring';
import { numeralPostCheck, type GenerateFn, type GeneratedText } from './narrative';
import { fireAdvisoryItems } from './advisory';
import { buildInstitutionalReviewPayload, type ReviewPayload } from './institutional-review';

const PROMPT_VERSION = 'diligence_simulation.v1';
const MODEL = 'claude-opus-4-8';
// Model label stored on a run drafted by the deterministic composer, so a reader
// can always tell a rule-based narrative from an AI-drafted one.
const RULE_BASED_MODEL = 'rule-based:diligence_simulation.v1';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

// The unmissable label on every run narrative, AI- or rule-composed. It carries
// no numeral, so prepending it never trips the numeral firewall.
export const DRAFT_BANNER =
  '_DRAFT — Diligence Simulation. AI-assisted observations assembled for advisor ' +
  'review only. This simulation rehearses the questions and blind spots a ' +
  'sophisticated diligence process would surface. The findings, their severity, ' +
  'and their remediation pointers are produced by the deterministic engine; the ' +
  'narrative frames them. It does not compute, adjust, or grade any score._';

// ── Deterministic finding model ────────────────────────────────────────────────

export type FindingSourceKind = 'gap' | 'evidence' | 'buyer_question' | 'untracked';
export type FindingSeverity = 'critical' | 'high' | 'med' | 'low';

// Where the advisor should go to close the finding. `ref` is an opaque id (a Plan
// template id, an advisory-library item id) the UI can deep-link; null when the
// pointer is a surface (Evidence, Roadmap) rather than a specific row.
export interface FindingRemediation {
  kind: 'plan' | 'library' | 'evidence' | 'roadmap';
  label: string;
  ref: string | null;
}

export interface DiligenceFinding {
  rank: number;
  severity: FindingSeverity;
  // The diligence area a buyer's team would file this under (a dimension name, or
  // the evidence/tracking area for non-gap findings).
  area: string;
  source_kind: FindingSourceKind;
  title: string;
  // WHY a diligence process would flag it — deterministic, buyer-framed, no numerals.
  why: string;
  remediation: FindingRemediation | null;
}

// The area + remediation lookups that enrich the ReviewPayload into findings.
// Keyed by the gap name / question title the payload already carries, so the pure
// assembler consumes institutional-review's output plus this map and nothing else.
export interface FindingMeta {
  area: string;
  remediation: FindingRemediation | null;
}
export interface DiligenceEnrichment {
  gapMeta: Record<string, FindingMeta>;
  questionMeta: Record<string, FindingMeta>;
  // The engine's "not tracked" markers (explain trace), which institutional-review
  // deliberately omits from its payload; here they are surfaced as blind spots.
  untrackedFlags: string[];
}

// Critical first (enum storage order is not severity order).
const SEVERITY_RANK: Record<FindingSeverity, number> = { critical: 0, high: 1, med: 2, low: 3 };
// Within a severity, a confirmed gap outranks missing proof outranks a fired
// question outranks an untracked metric — the order a diligence team would work.
const SOURCE_RANK: Record<FindingSourceKind, number> = {
  gap: 0,
  evidence: 1,
  buyer_question: 2,
  untracked: 3,
};

// Normalize the mixed severity vocabularies (gaps use med, some catalogs use
// medium) onto the canonical four-band scale. Anything unknown is treated as med.
export function normalizeSeverity(s: string | null | undefined): FindingSeverity {
  const v = (s ?? '').toLowerCase();
  if (v === 'critical' || v === 'high' || v === 'low') return v;
  return 'med';
}

const WHY_GAP: Record<FindingSeverity, string> = {
  critical: 'A buyer will open here first. Left unaddressed this can stall a process or force a real price cut, so it is the finding to close before any other.',
  high: 'Diligence weights this heavily. Resolving it early protects both price and the certainty of getting to close.',
  med: 'This is a routine diligence question. Getting ahead of it keeps the process on the owner\'s terms rather than the buyer\'s.',
  low: 'A smaller item, but worth clearing so nothing avoidable surfaces late in the process.',
};

function whyGap(severity: FindingSeverity): string {
  return WHY_GAP[severity];
}
function whyEvidence(area: string): string {
  return `This ${area.toLowerCase()} figure still rests on self-report. A buyer will independently re-verify it in quality-of-earnings, so until it is backed by a document or a connected ledger they will assume the conservative case.`;
}
function whyQuestion(buyerType: string | null): string {
  const who = buyerType ? `A ${buyerType} buyer` : 'A buyer';
  return `${who} is likely to raise this in management meetings. Rehearsing the answer now, with the supporting evidence in hand, turns a probe into a footnote.`;
}
function whyUntracked(metric: string): string {
  return `${metric} is not currently measured, so a buyer cannot verify it and will underwrite the conservative case. Tracking it is the cheapest way to remove the discount.`;
}

// Pure: order the raw findings deterministically and stamp a 1-based rank. Same
// inputs always yield the same ranking (reproducibility): severity, then source
// kind, then a stable alphabetical tiebreak on title. No score is computed.
export function rankFindings(raw: Omit<DiligenceFinding, 'rank'>[]): DiligenceFinding[] {
  return [...raw]
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
        SOURCE_RANK[a.source_kind] - SOURCE_RANK[b.source_kind] ||
        a.title.localeCompare(b.title),
    )
    .map((f, i) => ({ ...f, rank: i + 1 }));
}

// Pure: fold the institutional-review ReviewPayload (plus the area/remediation
// enrichment) into the ranked blind-spot report. It reshapes deterministic output
// and assigns deterministic why/remediation copy; it derives no new number and
// computes no score. This is the seam that makes the simulation an extension of
// the reviewer rather than a second scorer.
export function assembleDiligenceFindings(
  payload: ReviewPayload,
  enrichment: DiligenceEnrichment,
): DiligenceFinding[] {
  const raw: Omit<DiligenceFinding, 'rank'>[] = [];

  for (const g of payload.flagged_gaps) {
    const severity = normalizeSeverity(g.severity);
    const meta = enrichment.gapMeta[g.name];
    raw.push({
      severity,
      area: meta?.area ?? 'General',
      source_kind: 'gap',
      title: g.name,
      why: whyGap(severity),
      remediation: meta?.remediation ?? null,
    });
  }
  for (const prompt of payload.evidence_gaps.unverified) {
    const area = 'Financial & Accounting';
    raw.push({
      severity: 'high',
      area,
      source_kind: 'evidence',
      title: `Unverified: ${prompt}`,
      why: whyEvidence(area),
      remediation: { kind: 'evidence', label: 'Evidence & data room', ref: null },
    });
  }
  for (const q of payload.likely_diligence_questions) {
    const meta = enrichment.questionMeta[q.title];
    raw.push({
      severity: normalizeSeverity(q.severity),
      area: meta?.area ?? 'General',
      source_kind: 'buyer_question',
      title: q.title,
      why: whyQuestion(q.buyer_type),
      remediation: meta?.remediation ?? { kind: 'library', label: 'Advisory library', ref: null },
    });
  }
  for (const f of enrichment.untrackedFlags) {
    raw.push({
      severity: 'med',
      area: 'Not tracked',
      source_kind: 'untracked',
      title: f,
      why: whyUntracked(f),
      remediation: { kind: 'roadmap', label: 'Add to the roadmap', ref: null },
    });
  }

  return rankFindings(raw);
}

// ── Context (the only numbers the model may cite) ──────────────────────────────

export interface SimContext {
  engagement_id: string;
  assessment_id: string;
  company: { name: string; industry: string | null };
  engagement_target_window: string | null;
  overall_score: number;
  band: string;
  owner_readiness_index: number;
}

// ── DB assembly — reuse the reviewer payload, add area/remediation enrichment ───
// Read-only. buildInstitutionalReviewPayload produces every figure; the enrichment
// queries only resolve the diligence area (dimension name) and remediation pointer
// for each finding — neither reads nor writes a score.
export async function buildDiligenceInput(
  db: pg.ClientBase,
  assessmentId: string,
): Promise<{ payload: ReviewPayload; enrichment: DiligenceEnrichment; context: SimContext }> {
  const payload = await buildInstitutionalReviewPayload(db, assessmentId);

  const header = (
    await db.query(
      `select engagement_id, rubric_version_id from active_assessments
       where id = $1 and status = 'completed'`,
      [assessmentId],
    )
  ).rows[0];
  if (!header) throw new Error(`assessment ${assessmentId} not found, not completed, or superseded`);
  const engagementId: string = header.engagement_id;

  // Gap enrichment: diligence area (dimension name) + the remediation Plan mapped
  // to the gap. Keyed by gap name (the field the ReviewPayload carries). First
  // plan by priority wins.
  const gapMeta: Record<string, FindingMeta> = {};
  for (const r of (
    await db.query(
      `select gd.name, d.name as area, pt.id as plan_id, pt.name as plan_name, m.priority
       from gaps g
       join gap_definitions gd on gd.id = g.gap_definition_id
       join dimensions d on d.id = gd.dimension_id
       left join gap_plan_map m on m.gap_definition_id = gd.id
       left join plan_templates pt on pt.id = m.plan_template_id
       where g.engagement_id = $1 and g.status in ('open', 'in_remediation')
       order by m.priority nulls last`,
      [engagementId],
    )
  ).rows) {
    if (gapMeta[r.name]) continue; // first (highest-priority) plan wins
    gapMeta[r.name] = {
      area: r.area,
      remediation: r.plan_id ? { kind: 'plan', label: r.plan_name, ref: r.plan_id } : null,
    };
  }

  // Question enrichment: diligence area (dimension name) + a pointer to the
  // advisory-library row that fired. fireAdvisoryItems is the same catalog the
  // ReviewPayload's likely_diligence_questions come from; here we key by title to
  // recover each one's dimension + id.
  const dimNames = new Map<string, string>(
    (
      await db.query(`select code, name from dimensions where rubric_version_id = $1`, [
        header.rubric_version_id,
      ])
    ).rows.map((r) => [r.code as string, r.name as string]),
  );
  const questionMeta: Record<string, FindingMeta> = {};
  const advisory = await fireAdvisoryItems(db, engagementId);
  for (const it of advisory.items) {
    if (it.item_type !== 'buyer_question' && it.item_type !== 'risk_flag') continue;
    if (questionMeta[it.title]) continue;
    questionMeta[it.title] = {
      area: (it.dimension_code ? dimNames.get(it.dimension_code) : null) ?? 'General',
      remediation: { kind: 'library', label: 'Advisory library', ref: it.id },
    };
  }

  // The engine's untracked-metric flags (explain trace) — blind spots a buyer
  // cannot verify. institutional-review omits these; the simulation surfaces them.
  const explain = await explainAssessment(db, assessmentId);

  return {
    payload,
    enrichment: { gapMeta, questionMeta, untrackedFlags: explain.flags },
    context: {
      engagement_id: engagementId,
      assessment_id: assessmentId,
      company: payload.company,
      engagement_target_window: payload.engagement_target_window,
      overall_score: payload.overall_score,
      band: payload.band,
      owner_readiness_index: payload.owner_readiness_index,
    },
  };
}

// ── Narrative payload + deterministic composer ─────────────────────────────────
// The narrative is FRAMING over the finished findings. The payload it (and the
// firewall) sees carries only the deterministic scores plus the findings; the
// only numerals are payload numerals, so a rule-based composition is firewall-
// clean by construction and the AI path is held to the same bar.

export interface NarrativePayload {
  company: { name: string; industry: string | null };
  band: string;
  overall_score: number;
  owner_readiness_index: number;
  engagement_target_window: string | null;
  findings: {
    rank: number;
    severity: FindingSeverity;
    area: string;
    source_kind: FindingSourceKind;
    title: string;
    why: string;
    remediation: string | null;
  }[];
}

export function buildNarrativePayload(
  context: SimContext,
  findings: DiligenceFinding[],
): NarrativePayload {
  return {
    company: context.company,
    band: context.band,
    overall_score: context.overall_score,
    owner_readiness_index: context.owner_readiness_index,
    engagement_target_window: context.engagement_target_window,
    findings: findings.map((f) => ({
      rank: f.rank,
      severity: f.severity,
      area: f.area,
      source_kind: f.source_kind,
      title: f.title,
      why: f.why,
      remediation: f.remediation ? f.remediation.label : null,
    })),
  };
}

function withDraftBanner(text: string): string {
  return text.startsWith(DRAFT_BANNER) ? text : `${DRAFT_BANNER}\n\n${text}`;
}

// Rule-based narrative — invents nothing, computes nothing (rule 1/2-safe). Every
// numeral it emits is a payload numeral, so numeralPostCheck(compose(p), p) is
// empty by construction. Always available (demos, key-less environments).
export function composeDiligenceNarrative(payload: NarrativePayload): string {
  const { company } = payload;
  const lines: string[] = [];
  lines.push(`# Diligence Simulation — ${company.name}`);
  lines.push('');
  lines.push(DRAFT_BANNER);
  lines.push('');
  lines.push(
    `This simulation reads the latest assessment the way a sophisticated buyer's ` +
      `diligence team would, and ranks what they will probe before they do. The ` +
      `Diligence Readiness Score of ${payload.overall_score} (${payload.band}) and the ` +
      `Owner Readiness Index of ${payload.owner_readiness_index} come from the ` +
      `deterministic engine; nothing below is a grade.`,
  );
  lines.push('');

  lines.push('## Ranked blind spots');
  if (payload.findings.length === 0) {
    lines.push(
      'Nothing was flagged at the current scores, no financial input rests on self-report, and the buyer-lens catalog fired no questions. The focus shifts to holding the position and assembling materials for scrutiny.',
    );
  } else {
    for (const f of payload.findings) {
      lines.push(`### ${f.rank}. ${f.title}`);
      lines.push(`**Severity:** ${f.severity} · **Diligence area:** ${f.area}`);
      lines.push(f.why);
      if (f.remediation) lines.push(`_Where to close it: ${f.remediation}._`);
      lines.push('');
    }
  }

  lines.push('## For the advisor');
  const window = payload.engagement_target_window
    ? ` within the ${payload.engagement_target_window} target window`
    : '';
  lines.push(
    `Treat the ranked items above as a diligence rehearsal${window}. Each is a question to answer, or a gap to close, before the market asks. Legal and tax structure belong with the advisor and counsel; this simulation does not opine on them.`,
  );

  return withDraftBanner(lines.join('\n'));
}

// ── AI generation (injectable generator + numeral firewall) ────────────────────

async function callClaude(systemPrompt: string, userContent: string): Promise<GeneratedText> {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'diligence simulation service not configured: set ANTHROPIC_API_KEY in the server environment',
    );
  }
  const client = new Anthropic();
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 16000,
    thinking: { type: 'adaptive' },
    system: systemPrompt,
    messages: [{ role: 'user', content: userContent }],
  });
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('');
  if (!text) throw new Error(`diligence simulation returned no text (${response.stop_reason})`);
  return { text, model: response.model };
}

// Read the versioned prompt, generate, enforce the numeral firewall (one
// regeneration, then fail loudly), and stamp the DRAFT banner. Mirrors
// narrative.ts / institutional-review.ts exactly.
async function narrativeWithGenerator(
  payload: NarrativePayload,
  generate: GenerateFn,
): Promise<GeneratedText> {
  const systemPrompt = readFileSync(join(root, 'prompts', `${PROMPT_VERSION}.md`), 'utf8');
  const userContent = `Diligence simulation data (JSON):\n${JSON.stringify(payload, null, 2)}`;

  let generated = await generate(systemPrompt, userContent);
  let violations = numeralPostCheck(generated.text, payload);
  if (violations.length > 0) {
    generated = await generate(
      systemPrompt,
      `${userContent}\n\nIMPORTANT: your previous draft used numbers not present in the data (${violations.join(', ')}). Use only numbers from the payload, and never compute a number of your own.`,
    );
    violations = numeralPostCheck(generated.text, payload);
    if (violations.length > 0) {
      throw new Error(
        `diligence simulation rejected: output contains numerals not present in the input payload: ${violations.join(', ')}`,
      );
    }
  }
  return { text: withDraftBanner(generated.text), model: generated.model };
}

// ── Run (persist an immutable snapshot) & read (latest) ─────────────────────────

export interface DiligenceRunView {
  id: string;
  created_at: string;
  prompt_version: string;
  model: string;
  is_draft: true;
  narrative_md: string;
  finding_count: number;
  company: { name: string; industry: string | null };
  band: string;
  overall_score: number;
  owner_readiness_index: number;
  findings: DiligenceFinding[];
}

export interface DiligenceRunResult {
  assessment_id: string | null;
  run: DiligenceRunView | null;
}

// Draft the (labeled) narrative for a set of findings and persist a new immutable
// run + its findings. Generator selection matches narrative.ts exactly: an
// explicit generator forces the AI path (tests); otherwise Claude when a key is
// set, else the deterministic composer — so a run always produces. Kept as its own
// seam (no scoring reads) so the draft+persist path is testable with a fake db.
export async function draftAndPersistRun(
  db: pg.ClientBase,
  firmId: string,
  context: SimContext,
  findings: DiligenceFinding[],
  generate?: GenerateFn,
): Promise<DiligenceRunView> {
  const payload = buildNarrativePayload(context, findings);

  let narrative: string;
  let model: string;
  if (generate) {
    ({ text: narrative, model } = await narrativeWithGenerator(payload, generate));
  } else if (process.env.ANTHROPIC_API_KEY) {
    ({ text: narrative, model } = await narrativeWithGenerator(payload, callClaude));
  } else {
    narrative = composeDiligenceNarrative(payload);
    model = RULE_BASED_MODEL;
  }

  // Persist the immutable snapshot: one run row + one row per finding, atomically.
  await db.query('begin');
  let runRow;
  try {
    runRow = (
      await db.query(
        `insert into diligence_simulation_runs
           (firm_id, engagement_id, assessment_id, prompt_version, model, finding_count, narrative_md)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning id, created_at`,
        [firmId, context.engagement_id, context.assessment_id, PROMPT_VERSION, model, findings.length, narrative],
      )
    ).rows[0];
    for (const f of findings) {
      await db.query(
        `insert into diligence_simulation_findings
           (firm_id, run_id, rank, severity, area, source_kind, title, why,
            remediation_kind, remediation_label, remediation_ref)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          firmId,
          runRow.id,
          f.rank,
          f.severity,
          f.area,
          f.source_kind,
          f.title,
          f.why,
          f.remediation?.kind ?? null,
          f.remediation?.label ?? null,
          f.remediation?.ref ?? null,
        ],
      );
    }
    await db.query('commit');
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }

  return {
    id: runRow.id,
    created_at: runRow.created_at,
    prompt_version: PROMPT_VERSION,
    model,
    is_draft: true,
    narrative_md: narrative,
    finding_count: findings.length,
    company: context.company,
    band: context.band,
    overall_score: context.overall_score,
    owner_readiness_index: context.owner_readiness_index,
    findings,
  };
}

// Assemble the deterministic findings for an engagement's latest completed
// assessment, then draft + persist the run. Read-only up to the persist; returns
// { run: null } when there is no completed assessment to simulate. firmId is the
// caller's firm, resolved upstream (manage-engagement scope) and trusted.
export async function runDiligenceSimulation(
  db: pg.ClientBase,
  firmId: string,
  engagementId: string,
  generate?: GenerateFn,
): Promise<DiligenceRunResult> {
  const assessment = (
    await db.query(
      `select id from assessments where engagement_id = $1 and status = 'completed'
       order by completed_at desc nulls last, created_at desc limit 1`,
      [engagementId],
    )
  ).rows[0];
  if (!assessment) return { assessment_id: null, run: null };

  const { payload, enrichment, context } = await buildDiligenceInput(db, assessment.id);
  const findings = assembleDiligenceFindings(payload, enrichment);
  const run = await draftAndPersistRun(db, firmId, context, findings, generate);
  return { assessment_id: assessment.id, run };
}

// Read the latest persisted run for an engagement, with its findings in rank
// order. Read-only; returns { run: null } when none has been produced yet.
export async function latestDiligenceSimulation(
  db: pg.ClientBase,
  engagementId: string,
): Promise<DiligenceRunResult> {
  const run = (
    await db.query(
      `select r.id, r.created_at, r.assessment_id, r.prompt_version, r.model,
              r.finding_count, r.narrative_md,
              c.name as company_name, c.industry, a.drs_score, a.drs_tier, a.ori_score
       from diligence_simulation_runs r
       join engagements e on e.id = r.engagement_id
       join companies c on c.id = e.company_id
       left join assessments a on a.id = r.assessment_id
       where r.engagement_id = $1
       order by r.created_at desc limit 1`,
      [engagementId],
    )
  ).rows[0];
  if (!run) return { assessment_id: null, run: null };

  const findings: DiligenceFinding[] = (
    await db.query(
      `select rank, severity, area, source_kind, title, why,
              remediation_kind, remediation_label, remediation_ref
       from diligence_simulation_findings
       where run_id = $1 order by rank`,
      [run.id],
    )
  ).rows.map((r) => ({
    rank: r.rank,
    severity: r.severity as FindingSeverity,
    area: r.area,
    source_kind: r.source_kind as FindingSourceKind,
    title: r.title,
    why: r.why,
    remediation: r.remediation_kind
      ? { kind: r.remediation_kind, label: r.remediation_label, ref: r.remediation_ref }
      : null,
  }));

  return {
    assessment_id: run.assessment_id ?? null,
    run: {
      id: run.id,
      created_at: run.created_at,
      prompt_version: run.prompt_version,
      model: run.model,
      is_draft: true,
      narrative_md: run.narrative_md,
      finding_count: run.finding_count,
      company: { name: run.company_name, industry: run.industry ?? null },
      band: run.drs_tier ?? '',
      overall_score: run.drs_score == null ? 0 : Number(run.drs_score),
      owner_readiness_index: run.ori_score == null ? 0 : Number(run.ori_score),
      findings,
    },
  };
}
