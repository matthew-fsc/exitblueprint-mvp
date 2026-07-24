// ExitBlueprint Bench — LLM-judge tier (docs/sellside-ai/02, WS-JUDGE). These are
// HERMETIC unit tests: the judge's transport is a fake that returns canned
// verdicts, so NO network, NO API key, NO DB is ever touched — the same guarantee
// the CI path gives. They assert:
//   - the judge is secret-gated (judgeEnabled) so CI stays deterministic;
//   - verdict parsing is conservative (unparseable ⇒ FAIL);
//   - the judge agrees with the human golden anchors (calibration harness);
//   - the deterministic grader SKIPS subjective (llm_judge) criteria, so the
//     diligence_qa bench case scores answer/source with no judge at all;
//   - the new facts_carry_citation source check enforces the citation contract.
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  gradeDeliverable,
  scoreBenchCase,
  subjectiveCriteria,
  BENCH_CASES,
  type BenchRubric,
} from '../server/llm/evals/bench';
import type { LlmTransport } from '../server/llm/client';
import {
  createLLMJudge,
  judgeEnabled,
  parseVerdict,
  runJudgeCalibration,
  judgeDeliverable,
  loadJudgeGolden,
  JUDGE_PROMPT_VERSION,
} from '../server/llm/evals/judge';

const evalsDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'llm', 'evals');
const diligenceRubric = () =>
  JSON.parse(
    readFileSync(join(evalsDir, 'rubrics', 'diligence_qa.baseline.json'), 'utf8'),
  ) as BenchRubric;
const diligenceDeliverable = () =>
  readFileSync(join(evalsDir, 'fixtures', 'diligence_qa.baseline.deliverable.md'), 'utf8');

// A fake transport that mimics a competent judge: it PASSES a "why a buyer cares"
// or "what happens next" criterion only when the DELIVERABLE actually contains a
// plain-language explanatory span, and FAILS on numbers-only / jargon / vague
// prose. It reads the user turn the judge built (CRITERION + DELIVERABLE).
const fakeJudgeTransport: LlmTransport = async (req) => {
  const deliverable = req.user.toLowerCase();
  const explainsPlainly =
    deliverable.includes('why this matters') ||
    deliverable.includes('buyer is really buying') ||
    deliverable.includes('your advisor will');
  const verdict = explainsPlainly ? 'PASS' : 'FAIL';
  return {
    text: `VERDICT: ${verdict}\nRATIONALE: fake judge decision for the test`,
    model: 'fake-economy',
    usage: { input_tokens: 0, output_tokens: 0 },
  };
};

const ENV_KEYS = ['RUN_LLM_JUDGE', 'AI_GATEWAY_API_KEY'] as const;
const saved: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) saved[k] = process.env[k];
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('judgeEnabled — the CI secret gate', () => {
  it('is OFF unless BOTH RUN_LLM_JUDGE and AI_GATEWAY_API_KEY are set', () => {
    delete process.env.RUN_LLM_JUDGE;
    delete process.env.AI_GATEWAY_API_KEY;
    expect(judgeEnabled()).toBe(false);

    process.env.AI_GATEWAY_API_KEY = 'sk-test';
    expect(judgeEnabled()).toBe(false); // flag still missing

    process.env.RUN_LLM_JUDGE = 'true';
    expect(judgeEnabled()).toBe(true);

    process.env.RUN_LLM_JUDGE = 'false';
    expect(judgeEnabled()).toBe(false); // explicit off

    process.env.RUN_LLM_JUDGE = '1';
    delete process.env.AI_GATEWAY_API_KEY;
    expect(judgeEnabled()).toBe(false); // no provider
  });
});

describe('parseVerdict — conservative', () => {
  it('parses PASS/FAIL and treats an unparseable response as FAIL', () => {
    expect(parseVerdict('VERDICT: PASS\nRATIONALE: ok').pass).toBe(true);
    expect(parseVerdict('VERDICT: FAIL\nRATIONALE: nope').pass).toBe(false);
    const junk = parseVerdict('the model rambled and never voted');
    expect(junk.pass).toBe(false);
    expect(junk.rationale).toMatch(/unparseable/i);
  });
});

describe('LLM judge (hermetic, fake transport)', () => {
  it('exposes its prompt_version for attribution', () => {
    const judge = createLLMJudge({ transport: fakeJudgeTransport });
    expect(judge.promptVersion).toBe(JUDGE_PROMPT_VERSION);
  });

  it('agrees with every human golden anchor', async () => {
    const judge = createLLMJudge({ transport: fakeJudgeTransport });
    const cal = await runJudgeCalibration(judge);
    expect(cal.total).toBe(loadJudgeGolden().length);
    expect(cal.total).toBeGreaterThan(0);
    expect(cal.agreementRate).toBe(1);
    for (const r of cal.results) expect(r.agrees).toBe(true);
  });

  it('grades the diligence_qa deliverable subjective axis as passing', async () => {
    const judge = createLLMJudge({ transport: fakeJudgeTransport });
    const axis = await judgeDeliverable(judge, diligenceDeliverable(), diligenceRubric());
    expect(axis.total).toBe(1); // one llm_judge criterion in the rubric
    expect(axis.passed).toBe(1);
    expect(axis.judgeScore).toBe(1);
  });

  it('refuses a non-subjective criterion (defensive)', async () => {
    const judge = createLLMJudge({ transport: fakeJudgeTransport });
    await expect(
      judge.judge('x', {
        id: 'det',
        weight: 1,
        kind: 'positive',
        axis: 'answer',
        description: 'deterministic',
        check: { type: 'must_contain_any', phrases: ['x'] },
      }),
    ).rejects.toThrow(/not an llm_judge/);
  });
});

describe('deterministic grader ignores subjective criteria', () => {
  it('scores the diligence_qa bench case answer 1 / source 1 with NO judge', () => {
    const rubric = diligenceRubric();
    // The rubric carries one subjective answer criterion...
    expect(subjectiveCriteria(rubric).length).toBe(1);
    // ...but the pure grader skips it and still fully scores the deterministic axes.
    const score = gradeDeliverable(diligenceDeliverable(), {
      question: '',
      facts: JSON.parse(
        readFileSync(join(evalsDir, 'fixtures', 'diligence_qa.baseline.payload.json'), 'utf8'),
      ).facts,
    }, rubric);
    expect(score.answerScore).toBe(1);
    expect(score.sourceScore).toBe(1);
    expect(score.failures).toEqual([]);
  });

  it('the registered diligence_qa case grades clean over its own fixtures', () => {
    const c = BENCH_CASES.find((x) => x.name === 'diligence_qa.baseline');
    expect(c).toBeDefined();
    const score = scoreBenchCase(c!);
    expect(score.answerScore).toBeGreaterThanOrEqual(0.9);
    expect(score.sourceScore).toBe(1);
  });
});

describe('facts_carry_citation source check', () => {
  const rubric: BenchRubric = {
    docType: 'diligence_qa',
    answer: [],
    source: [
      {
        id: 'every-fact-cited',
        weight: 1,
        kind: 'negative',
        axis: 'source',
        description: 'every stated figure carries its [cite_id]',
        check: { type: 'facts_carry_citation', factsPath: 'facts' },
      },
    ],
  };
  const payload = {
    facts: [
      { cite_id: 'VF-A', body: 'Revenue was 40 percent recurring.', citation: 'x', source: 'verified_fact' },
    ],
  };

  it('passes when the figure is stated on the same line as its cite_id', () => {
    const md = 'Revenue was 40 percent recurring [VF-A].';
    expect(gradeDeliverable(md, payload, rubric).sourceScore).toBe(1);
  });

  it('fails when a retrieved figure is stated without its cite_id', () => {
    const md = 'Revenue was 40 percent recurring.'; // no [VF-A]
    const score = gradeDeliverable(md, payload, rubric);
    expect(score.sourceScore).toBe(0);
    expect(score.failures.some((f) => f.includes('every-fact-cited'))).toBe(true);
  });
});
