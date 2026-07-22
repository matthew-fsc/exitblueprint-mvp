// Diligence Simulation (docs/20, docs/40 §3): the proactive buyer lens, built on
// top of the institutional reviewer. These tests hold the deterministic core
// honest — the ranked blind-spot report is assembled by pure functions from the
// institutional-review ReviewPayload plus a thin area/remediation enrichment,
// never by the model — and prove the narrative path stays inside the CLAUDE.md
// rule 1/2 boundary: draft labeling is always present, and no invented number
// survives the numeral firewall. DB-free and key-free: the pure assembler/composer
// run directly, and the draft+persist path is driven with an injected fake
// generator over a fake db.query (the same seam narrative.test.ts uses).
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  assembleDiligenceFindings,
  rankFindings,
  normalizeSeverity,
  buildNarrativePayload,
  composeDiligenceNarrative,
  draftAndPersistRun,
  DRAFT_BANNER,
  type DiligenceEnrichment,
  type SimContext,
  type DiligenceFinding,
} from '../server/diligence-simulation';
import type { ReviewPayload } from '../server/institutional-review';
import { numeralPostCheck } from '../server/narrative';

// --- Fixtures ------------------------------------------------------------------

// The deterministic ReviewPayload the institutional reviewer produces.
const payload: ReviewPayload = {
  company: { name: 'Cascade Facility Services', industry: 'Facilities' },
  engagement_target_window: '24-36 months',
  overall_score: 61.5,
  band: 'Needs Work',
  owner_readiness_index: 55,
  dimensions: [
    { name: 'Financial Integrity', score: 48 },
    { name: 'Revenue Quality', score: 72 },
  ],
  flagged_gaps: [
    { name: 'Owner Dependence', severity: 'critical' },
    { name: 'Reconciliation Discipline Gap', severity: 'med' },
  ],
  flags: [],
  evidence_gaps: {
    verified_inputs: 2,
    total_inputs: 5,
    pct: 40,
    tier: 'partly_verified',
    unverified: ['Are monthly statements reconciled?', 'Are add-backs supported by invoices?'],
  },
  likely_diligence_questions: [
    {
      title: 'Customer concentration',
      severity: 'high',
      buyer_type: 'strategic',
      concern: 'How exposed is the business if the top account leaves?',
    },
  ],
};

// The area + remediation enrichment (dimension names, Plan/library pointers) plus
// the engine's untracked flags — the supplement the DB assembly adds on top of the
// ReviewPayload.
const enrichment: DiligenceEnrichment = {
  gapMeta: {
    'Owner Dependence': {
      area: 'Owner Independence',
      remediation: { kind: 'plan', label: 'Build a management layer', ref: 'pl1' },
    },
    'Reconciliation Discipline Gap': { area: 'Financial Integrity', remediation: null },
  },
  questionMeta: {
    'Customer concentration': {
      area: 'Revenue Quality',
      remediation: { kind: 'library', label: 'Advisory library', ref: 'adv1' },
    },
  },
  untrackedFlags: ['NRR not tracked'],
};

const context: SimContext = {
  engagement_id: 'e1',
  assessment_id: 'a1',
  company: { name: 'Cascade Facility Services', industry: 'Facilities' },
  engagement_target_window: '24-36 months',
  overall_score: 61.5,
  band: 'Needs Work',
  owner_readiness_index: 55,
};

// --- Pure: severity normalization ----------------------------------------------

describe('normalizeSeverity', () => {
  it('maps the mixed vocabularies onto the four canonical bands', () => {
    expect(normalizeSeverity('critical')).toBe('critical');
    expect(normalizeSeverity('HIGH')).toBe('high');
    expect(normalizeSeverity('medium')).toBe('med');
    expect(normalizeSeverity('med')).toBe('med');
    expect(normalizeSeverity('low')).toBe('low');
    expect(normalizeSeverity(null)).toBe('med');
    expect(normalizeSeverity('weird')).toBe('med');
  });
});

// --- Pure: assembly + ranking (consumes the ReviewPayload) ---------------------

describe('assembleDiligenceFindings (pure, over the ReviewPayload)', () => {
  const findings = assembleDiligenceFindings(payload, enrichment);

  it('produces one finding per source item, ranked 1..N with no gaps', () => {
    // 2 gaps + 2 evidence + 1 buyer question + 1 untracked flag = 6
    expect(findings).toHaveLength(6);
    expect(findings.map((f) => f.rank)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('ranks by severity first, then source kind (gap < evidence < question < untracked)', () => {
    // The single critical gap is rank 1.
    expect(findings[0]).toMatchObject({ rank: 1, severity: 'critical', source_kind: 'gap', title: 'Owner Dependence' });
    // The high band holds the two evidence findings then the buyer question;
    // evidence (source rank 1) precedes the question (source rank 2), and within
    // evidence the alphabetical title tiebreak applies.
    const high = findings.filter((f) => f.severity === 'high');
    expect(high.map((f) => f.source_kind)).toEqual(['evidence', 'evidence', 'buyer_question']);
    expect(high.map((f) => f.title)).toEqual([
      'Unverified: Are add-backs supported by invoices?',
      'Unverified: Are monthly statements reconciled?',
      'Customer concentration',
    ]);
    // The med band: the gap (source 0) precedes the untracked flag (source 3).
    const med = findings.filter((f) => f.severity === 'med');
    expect(med.map((f) => f.source_kind)).toEqual(['gap', 'untracked']);
  });

  it('enriches each finding with the diligence area + remediation pointer', () => {
    const ownerGap = findings.find((f) => f.title === 'Owner Dependence')!;
    expect(ownerGap.area).toBe('Owner Independence');
    expect(ownerGap.remediation).toEqual({ kind: 'plan', label: 'Build a management layer', ref: 'pl1' });

    const evidence = findings.filter((f) => f.source_kind === 'evidence');
    expect(evidence.every((f) => f.severity === 'high')).toBe(true);
    expect(evidence.every((f) => f.area === 'Financial & Accounting')).toBe(true);
    expect(evidence.every((f) => f.remediation?.kind === 'evidence')).toBe(true);

    const untracked = findings.find((f) => f.source_kind === 'untracked')!;
    expect(untracked).toMatchObject({ severity: 'med', area: 'Not tracked', title: 'NRR not tracked' });
    expect(untracked.remediation?.kind).toBe('roadmap');

    const question = findings.find((f) => f.source_kind === 'buyer_question')!;
    expect(question.remediation).toEqual({ kind: 'library', label: 'Advisory library', ref: 'adv1' });
    expect(question.why.toLowerCase()).toContain('strategic'); // buyer_type surfaced in the why
  });

  it('is reproducible — same inputs yield an identical ranked report', () => {
    expect(assembleDiligenceFindings(payload, enrichment)).toEqual(assembleDiligenceFindings(payload, enrichment));
  });

  it('handles an empty payload without inventing findings', () => {
    const empty: ReviewPayload = {
      ...payload,
      flagged_gaps: [],
      evidence_gaps: { ...payload.evidence_gaps, unverified: [] },
      likely_diligence_questions: [],
    };
    expect(
      assembleDiligenceFindings(empty, { gapMeta: {}, questionMeta: {}, untrackedFlags: [] }),
    ).toEqual([]);
  });
});

describe('rankFindings (pure)', () => {
  it('is a stable sort with an alphabetical title tiebreak inside a severity+source band', () => {
    const raw: Omit<DiligenceFinding, 'rank'>[] = [
      { severity: 'high', area: 'X', source_kind: 'gap', title: 'Beta', why: '', remediation: null },
      { severity: 'high', area: 'X', source_kind: 'gap', title: 'Alpha', why: '', remediation: null },
      { severity: 'critical', area: 'X', source_kind: 'gap', title: 'Zed', why: '', remediation: null },
    ];
    const ranked = rankFindings(raw);
    expect(ranked.map((f) => f.title)).toEqual(['Zed', 'Alpha', 'Beta']);
    expect(ranked.map((f) => f.rank)).toEqual([1, 2, 3]);
  });
});

// --- Pure: narrative payload + deterministic composer --------------------------

describe('buildNarrativePayload (pure)', () => {
  it('flattens each finding remediation to its label and carries the scores', () => {
    const findings = assembleDiligenceFindings(payload, enrichment);
    const np = buildNarrativePayload(context, findings);
    expect(np.overall_score).toBe(61.5);
    expect(np.owner_readiness_index).toBe(55);
    expect(np.findings).toHaveLength(6);
    const ownerGap = np.findings.find((f) => f.title === 'Owner Dependence')!;
    expect(ownerGap.remediation).toBe('Build a management layer');
  });
});

describe('composeDiligenceNarrative (pure, firewall-clean)', () => {
  const np = buildNarrativePayload(context, assembleDiligenceFindings(payload, enrichment));

  it('labels the draft, leads with the company heading, and grades nothing', () => {
    const md = composeDiligenceNarrative(np);
    expect(md.startsWith(DRAFT_BANNER)).toBe(true);
    expect(md).toContain('# Diligence Simulation — Cascade Facility Services');
    expect(md).toContain('## Ranked blind spots');
    expect(md).toContain('Owner Dependence');
    expect(md).toContain('61.5'); // the score it cites is the engine's, verbatim
  });

  it('emits no numeral absent from the payload (numeral firewall clean)', () => {
    const md = composeDiligenceNarrative(np);
    expect(numeralPostCheck(md, np)).toEqual([]);
  });

  it('is deterministic (same payload → same narrative)', () => {
    expect(composeDiligenceNarrative(np)).toBe(composeDiligenceNarrative(np));
  });
});

// --- draft + persist path (fake db + injected generator) -----------------------
// The fake db answers only the writes draftAndPersistRun issues: the transaction
// bookends plus the run/finding inserts. No real database, no API key, no scoring.

function fakeDb() {
  const inserts = { runs: 0, findings: 0 };
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const db = {
    inserts,
    query: vi.fn(async (sql: string) => {
      const q = norm(sql);
      if (q === 'begin' || q === 'commit' || q === 'rollback') return { rows: [], rowCount: 0 };
      if (q.includes('insert into diligence_simulation_runs')) {
        inserts.runs++;
        return { rows: [{ id: 'run1', created_at: '2026-07-22T00:00:00.000Z' }], rowCount: 1 };
      }
      if (q.includes('insert into diligence_simulation_findings')) {
        inserts.findings++;
        return { rows: [], rowCount: 1 };
      }
      throw new Error(`fake db: unhandled query: ${q}`);
    }),
  };
  return db;
}

describe('draftAndPersistRun (fake db + injected generator)', () => {
  afterEach(() => {
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('stamps the draft label even when the model omits it, and persists run + findings', async () => {
    const db = fakeDb();
    const findings = assembleDiligenceFindings(payload, enrichment);
    const run = await draftAndPersistRun(db as never, 'f1', context, findings, async () => ({
      text: '## Ranked blind spots\n\nDiligence readiness sits at 61.5.',
      model: 'mock-model',
    }));
    expect(run.is_draft).toBe(true);
    expect(run.prompt_version).toBe('diligence_simulation.v1');
    expect(run.model).toBe('mock-model');
    expect(run.narrative_md.startsWith(DRAFT_BANNER)).toBe(true);
    expect(run.finding_count).toBe(findings.length);
    // one run row + one row per finding, all inside the transaction.
    expect(db.inserts.runs).toBe(1);
    expect(db.inserts.findings).toBe(findings.length);
  });

  it('regenerates once on an invented number, then fails loudly', async () => {
    const db = fakeDb();
    const findings = assembleDiligenceFindings(payload, enrichment);
    let calls = 0;
    await expect(
      draftAndPersistRun(db as never, 'f1', context, findings, async () => {
        calls++;
        return { text: 'A buyer would value this near 5000000 dollars.', model: 'mock-model' };
      }),
    ).rejects.toThrow(/numerals not present in the input payload/);
    expect(calls).toBe(2);
    expect(db.inserts.runs).toBe(0); // nothing persisted when the firewall rejects

    // A generator that fixes itself on the retry succeeds.
    let attempt = 0;
    const run = await draftAndPersistRun(db as never, 'f1', context, findings, async () => {
      attempt++;
      return attempt === 1
        ? { text: 'Concentration implies a 3.5x haircut.', model: 'mock-model' }
        : { text: 'Diligence will probe the ranked blind spots.', model: 'mock-model' };
    });
    expect(attempt).toBe(2);
    expect(run.narrative_md).toContain('ranked blind spots');
    expect(numeralPostCheck(run.narrative_md, buildNarrativePayload(context, findings))).toEqual([]);
  });

  it('falls back to the deterministic composer with no key and no generator', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const db = fakeDb();
    const findings = assembleDiligenceFindings(payload, enrichment);
    const run = await draftAndPersistRun(db as never, 'f1', context, findings);
    expect(run.model).toMatch(/^rule-based/);
    expect(run.is_draft).toBe(true);
    expect(run.narrative_md).toContain('# Diligence Simulation — Cascade Facility Services');
    expect(run.narrative_md.startsWith(DRAFT_BANNER)).toBe(true);
    expect(numeralPostCheck(run.narrative_md, buildNarrativePayload(context, findings))).toEqual([]);
  });
});
