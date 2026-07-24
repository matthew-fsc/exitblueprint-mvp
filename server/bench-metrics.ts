// ExitBlueprint Bench — server layer (docs/sellside-ai/02-evaluation-bench.md,
// docs/09-moats.md). Runs the deliverable-quality bench and persists its per-case
// grades as a new run in the service-role-only `analytics` schema
// (supabase/migrations/20260724030054_bench_results.sql), then reads the latest run
// back for the superadmin quality dashboard folded into GET /internal/metrics.
//
// TRUST BOUNDARY (CLAUDE.md rule #5): bench results are PLATFORM-QUALITY telemetry,
// NOT cross-firm client data. Like server/calibration.ts and server/financial-corpus.ts
// this runs ONLY on the service-role (RLS-bypass) connection behind the platform-
// superadmin gate. The generated tier reads ONE completed assessment to grade the
// real shipping code path, but everything WRITTEN here is a de-identified quality
// aggregate — doc_type/prompt_version/tier + two [0,1] scores; no firm_id, no company
// id, no PII crosses into the store. Never call this on a tenant JWT path.
//
// DETERMINISTIC & READ-ONLY-TO-SCORES (CLAUDE.md rules #1, #2): the bench GRADES a
// deliverable with the pure, rule-based checks in server/llm/evals/bench.ts — no LLM
// computes, adjusts, or influences a grade. Recording a run NEVER mutates an
// assessment or a DRS/ORI score; it only appends immutable quality rows.
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import {
  runBench,
  runGeneratedBench,
  BENCH_CASES,
  GENERATED_BENCH_CASES,
  subjectiveCriteria,
  type BenchScore,
  type BenchRubric,
  type LLMJudge,
} from './llm/evals/bench';
import { judgeDeliverable } from './llm/evals/judge';
import { getAgent } from './agents/registry';

// Either a pooled client or the Pool itself — both expose `.query`. The read path
// (used by the metrics rail) accepts either; the test passes a real client. The
// record path needs a client that can run its multi-statement insert.
type Queryable = Pick<pg.ClientBase, 'query'> | Pick<pg.Pool, 'query'>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// One persisted bench result row, in the shape the quality dashboard renders as
// snapshot.bench.results[i] (rendered VERBATIM by the console).
export interface BenchResultRow {
  doc_type: string;
  prompt_version: string;
  tier: 'static' | 'generated';
  case_name: string;
  answer_score: number;
  source_score: number;
  // The third, LLM-judge axis (subjective quality). NULL for a row graded with
  // deterministic checks only — the judge tier is secret-gated and off by default,
  // so most runs carry no judge score. A number in [0,1] when a judge graded it.
  judge_score: number | null;
  model: string;
  run_at: string;
}

export interface BenchSummary {
  last_run_at: string | null;
  results: BenchResultRow[];
}

// Resolve the prompt_version + model for a doc_type from the agent registry — the
// single source of truth for the shipping generators' versions. Both tiers grade the
// rule-based (deterministic composer / frozen fixture) path, so the model label is
// the agent's ruleBasedModel. An unregistered doc_type falls back to safe literals.
function agentMeta(docType: string): { promptVersion: string; model: string } {
  const a = getAgent(docType);
  if (a) return { promptVersion: a.promptVersion, model: a.ruleBasedModel };
  return { promptVersion: `${docType}.static`, model: 'rule-based' };
}

// doc_type for a static case: read the case's rubric docType (authoritative — the
// same field bench.ts grades against). Falls back to the name stem (`<docType>.<variant>`).
function staticDocTypeByName(): Map<string, string> {
  const m = new Map<string, string>();
  for (const c of BENCH_CASES) {
    let docType = c.name.replace(/\.[^.]+$/, '');
    try {
      const rubric = JSON.parse(readFileSync(c.rubricPath, 'utf8')) as { docType?: string };
      if (rubric.docType) docType = rubric.docType;
    } catch {
      // keep the name-stem fallback if the rubric can't be read
    }
    m.set(c.name, docType);
  }
  return m;
}

// A pending result row before it is stamped with the run grouping.
interface PendingRow {
  docType: string;
  promptVersion: string;
  model: string;
  caseName: string;
  tier: 'static' | 'generated';
  answerScore: number;
  sourceScore: number;
  // null unless a judge graded this case's subjective criteria (opts.judge).
  judgeScore: number | null;
}

function toPending(
  scores: BenchScore[],
  tier: 'static' | 'generated',
  docTypeFor: (name: string) => string,
): PendingRow[] {
  return scores.map((s) => {
    const docType = docTypeFor(s.name);
    const { promptVersion, model } = agentMeta(docType);
    return {
      docType,
      promptVersion,
      model,
      caseName: s.name,
      tier,
      answerScore: s.answerScore,
      sourceScore: s.sourceScore,
      judgeScore: null,
    };
  });
}

// Grade the static cases' SUBJECTIVE criteria with a judge, returning case_name →
// judge axis score. Only invoked when a caller explicitly passes a judge (the
// secret-gated [eval] path); the default DB run never calls a model. De-identified
// like everything else here — the output is a single [0,1] quality number.
async function judgeStaticScores(judge: LLMJudge): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const c of BENCH_CASES) {
    const rubric = JSON.parse(readFileSync(c.rubricPath, 'utf8')) as BenchRubric;
    if (subjectiveCriteria(rubric).length === 0) continue;
    const markdown = readFileSync(c.deliverablePath, 'utf8');
    const axis = await judgeDeliverable(judge, markdown, rubric);
    out.set(c.name, axis.judgeScore);
  }
  return out;
}

// Run the bench and persist its grades as one new run. Static tier always runs (pure
// checks over disk fixtures — no DB, no API key). The generated tier runs only when a
// completed assessment exists; it grades the REAL shipping code path via
// runGeneratedBench, which calls generateDocument with NO generator ⇒ the
// deterministic composer branch (rule-based, no API key). NOTE: that composer
// legitimately persists a generated_documents DRAFT as a side effect — acceptable for
// a superadmin-gated quality run. Superadmin/service-role only.
export async function recordBenchRun(
  db: pg.ClientBase,
  opts: { judge?: LLMJudge } = {},
): Promise<{ run_at: string; inserted: number }> {
  const staticScores = await runBench();
  const staticDocTypes = staticDocTypeByName();
  const rows: PendingRow[] = toPending(staticScores, 'static', (name) =>
    staticDocTypes.get(name) ?? name.replace(/\.[^.]+$/, ''),
  );

  // Judge axis (subjective quality) — persisted ONLY when a caller passes a judge
  // (the secret-gated [eval] path). Default runs leave judge_score NULL, so the DB
  // path stays deterministic and never makes an API call.
  if (opts.judge) {
    const judged = await judgeStaticScores(opts.judge);
    for (const r of rows) {
      const js = judged.get(r.caseName);
      if (js != null) r.judgeScore = js;
    }
  }

  // Generated tier — only if there is a completed assessment to grade against.
  const completed = (
    await db.query(`select id from active_assessments where status = 'completed' limit 1`)
  ).rows[0];
  if (completed) {
    const generatedScores = await runGeneratedBench(db, String(completed.id));
    const genDocTypes = new Map(GENERATED_BENCH_CASES.map((c) => [c.name, c.docType]));
    rows.push(
      ...toPending(generatedScores, 'generated', (name) => genDocTypes.get(name) ?? name.replace(/\.[^.]+$/, '')),
    );
  }

  // One run header groups this run's rows; results carry its run_at too.
  const header = (
    await db.query(`insert into analytics.bench_runs default values returning run_id, run_at`)
  ).rows[0];
  const runId = Number(header.run_id);
  const runAt: unknown = header.run_at;

  for (const r of rows) {
    await db.query(
      `insert into analytics.bench_results
         (run_id, run_at, doc_type, prompt_version, model, case_name, tier, answer_score, source_score, judge_score)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        runId,
        runAt,
        r.docType,
        r.promptVersion,
        r.model,
        r.caseName,
        r.tier,
        r.answerScore,
        r.sourceScore,
        r.judgeScore,
      ],
    );
  }

  return {
    run_at: runAt ? new Date(runAt as string).toISOString() : new Date().toISOString(),
    inserted: rows.length,
  };
}

// Read the latest run's rows for the quality dashboard. Read-only; used by the
// run-bench read side and the /internal/metrics operator rail. Empty (last_run_at
// null, no results) until the first run — and best-effort try/catch so a pre-migration
// DB (table absent) degrades to empty rather than 500-ing the whole metrics readout,
// mirroring how readCalibration tolerates a pre-migration DB.
export async function benchSummary(db: Queryable): Promise<BenchSummary> {
  try {
    const rows = (
      await db.query(
        `select run_at, doc_type, prompt_version, model, case_name, tier, answer_score, source_score, judge_score
           from analytics.bench_latest
          order by tier, doc_type, case_name`,
      )
    ).rows;

    if (rows.length === 0) return { last_run_at: null, results: [] };

    const results: BenchResultRow[] = rows.map((r) => ({
      doc_type: String(r.doc_type),
      prompt_version: String(r.prompt_version),
      tier: r.tier as 'static' | 'generated',
      case_name: String(r.case_name),
      answer_score: num(r.answer_score),
      source_score: num(r.source_score),
      judge_score: r.judge_score == null ? null : num(r.judge_score),
      model: String(r.model),
      run_at: r.run_at ? new Date(r.run_at).toISOString() : '',
    }));

    return { last_run_at: results[0].run_at || null, results };
  } catch {
    return { last_run_at: null, results: [] };
  }
}
