// DEV verification page for Phase 1: runs the real scoring engine live in the
// browser against the three reference fixtures and compares every output to
// the expected values shipped with the fixtures. The rubric here is parsed
// from the bundled /seed CSVs for display only — production scoring always
// reads the rubric from the database (CLAUDE.md rule 3).
import { useMemo, useState } from 'react';
import dimensionsCsv from '../../seed/drs-rubric-dimensions.csv?raw';
import questionsCsv from '../../seed/drs-rubric-questions.csv?raw';
import subScoresCsv from '../../seed/drs-rubric-subscores.csv?raw';
import gapDefsCsv from '../../seed/gap-definitions.csv?raw';
import fixture1 from '../../seed/fixtures/company-1-meridian-managed-it.json';
import fixture2 from '../../seed/fixtures/company-2-apex-fabrication.json';
import fixture3 from '../../seed/fixtures/company-3-harborview-staffing.json';
import { buildRubric } from '../../shared/rubric-seed';
import { scoreFromAnswers } from '../../shared/scoring/engine';
import type { Answers, ScoreResult } from '../../shared/scoring/types';
import { tierStatusOf } from '../lib/tokens';
import { gapSeverityStatus } from '../lib/severity';

interface FixtureFile {
  profile: string;
  answers: Answers;
  expected: {
    sub_scores: Record<string, number>;
    dimension_scores: Record<string, number>;
    drs: number;
    tier: string;
    owner_readiness_index: number;
    gaps: string[];
    flags: string[];
  };
}

const fixtures: { name: string; file: FixtureFile }[] = [
  { name: 'Meridian Managed IT', file: fixture1 as FixtureFile },
  { name: 'Apex Fabrication', file: fixture2 as FixtureFile },
  { name: 'Harborview Staffing', file: fixture3 as FixtureFile },
];

interface Comparison {
  label: string;
  computed: string;
  expected: string;
  pass: boolean;
}

function compareFixture(result: ScoreResult, expected: FixtureFile['expected']): Comparison[] {
  const rows: Comparison[] = [
    {
      label: 'DRS',
      computed: String(result.drsScore),
      expected: String(expected.drs),
      pass: result.drsScore === expected.drs,
    },
    {
      label: 'Tier',
      computed: result.drsTier,
      expected: expected.tier,
      pass: result.drsTier === expected.tier,
    },
    {
      label: 'ORI',
      computed: String(result.oriScore),
      expected: String(expected.owner_readiness_index),
      pass: result.oriScore === expected.owner_readiness_index,
    },
    {
      label: 'Gap set',
      computed: result.gapCodes.join(', ') || '—',
      expected: expected.gaps.join(', ') || '—',
      pass: JSON.stringify(result.gapCodes) === JSON.stringify(expected.gaps),
    },
    {
      label: 'Flags',
      computed: result.flags.join(', ') || '—',
      expected: expected.flags.join(', ') || '—',
      pass: JSON.stringify(result.flags) === JSON.stringify(expected.flags),
    },
  ];
  for (const [code, want] of Object.entries(expected.dimension_scores)) {
    const got = result.dimensionScores.find((d) => d.code === code)?.score;
    rows.push({
      label: `Dimension ${code}`,
      computed: String(got),
      expected: String(want),
      pass: got === want,
    });
  }
  for (const [code, want] of Object.entries(expected.sub_scores)) {
    const got = result.subScores.find((s) => s.code === code)?.points;
    rows.push({
      label: `Sub-score ${code}`,
      computed: String(got),
      expected: String(want),
      pass: got === want,
    });
  }
  return rows;
}

export default function VerifyPage() {
  const rubric = useMemo(
    () =>
      buildRubric({
        dimensions: dimensionsCsv,
        questions: questionsCsv,
        subScores: subScoresCsv,
        gapDefinitions: gapDefsCsv,
      }),
    [],
  );

  const runs = useMemo(
    () =>
      fixtures.map(({ name, file }) => {
        const result = scoreFromAnswers(rubric, file.answers);
        const comparisons = compareFixture(result, file.expected);
        return { name, file, result, comparisons };
      }),
    [rubric],
  );

  const totalChecks = runs.reduce((n, r) => n + r.comparisons.length, 0);
  const totalPassed = runs.reduce((n, r) => n + r.comparisons.filter((c) => c.pass).length, 0);
  const allPass = totalPassed === totalChecks;
  const gapDefsByCode = new Map(rubric.gapDefinitions.map((g) => [g.code, g]));

  return (
    <div>
      <section className="banner-row">
        <div className={`tile tile-${allPass ? 'good' : 'critical'}`}>
          <span className="tile-value">
            {totalPassed}/{totalChecks}
          </span>
          <span className="tile-label">engine outputs matching the reference scorer</span>
        </div>
        <div className="tile">
          <span className="tile-value">DRS-1.0</span>
          <span className="tile-label">rubric version (from /seed)</span>
        </div>
        <div className="tile">
          <span className="tile-value">
            {rubric.dimensions.length}·{rubric.subScores.length}·{rubric.questions.length}
          </span>
          <span className="tile-label">dimensions · sub-scores · questions</span>
        </div>
        <div className="tile">
          <span className="tile-value">{rubric.gapDefinitions.length}</span>
          <span className="tile-label">gap definitions</span>
        </div>
      </section>
      <p className="dev-note">
        DEV verification — the deterministic engine (shared/scoring) is executing live on this
        page against the bundled seed rubric. Production scoring reads the rubric from the
        database; no AI touches any number shown here.
      </p>

      {runs.map(({ name, file, result, comparisons }) => {
        const failed = comparisons.filter((c) => c.pass === false);
        return (
          <section key={name} className="fixture-card">
            <header className="fixture-header">
              <div>
                <h2>{name}</h2>
                <p className="fixture-profile">{file.profile}</p>
              </div>
              <span className={`status-chip status-${failed.length === 0 ? 'good' : 'critical'}`}>
                {failed.length === 0 ? '✓' : '✕'}{' '}
                {failed.length === 0 ? `${comparisons.length} checks exact` : `${failed.length} mismatches`}
              </span>
            </header>

            <div className="fixture-body">
              <div className="score-block">
                <div className="hero-score">
                  <span className="hero-value">{result.drsScore}</span>
                  <span className="hero-caption">DRS</span>
                </div>
                <span className={`status-chip status-${tierStatusOf(result.drsTier)}`}>
                  ● {result.drsTier}
                </span>
                <div className="ori-line">
                  Owner Readiness Index <strong>{result.oriScore}</strong>
                </div>
              </div>

              <div className="dimension-block">
                {result.dimensionScores.map((d) => {
                  const dim = rubric.dimensions.find((r) => r.code === d.code)!;
                  return (
                    <div key={d.code} className="dim-row" title={`${dim.name}: ${d.score} / 100`}>
                      <span className="dim-name">{dim.name}</span>
                      <span className="dim-track">
                        <span className="dim-fill" style={{ width: `${d.score}%` }} />
                      </span>
                      <span className="dim-value">{d.score}</span>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="gap-row">
              {result.gapCodes.length === 0 ? (
                <span className="gap-none">No gaps flagged</span>
              ) : (
                result.gapCodes.map((code) => {
                  const def = gapDefsByCode.get(code);
                  return (
                    <span
                      key={code}
                      className={`gap-chip gap-${gapSeverityStatus(def?.severity)}`}
                      title={def?.name}
                    >
                      {def?.severity}: {def?.name ?? code}
                    </span>
                  );
                })
              )}
              {result.flags.map((f) => (
                <span key={f} className="gap-chip gap-neutral">
                  flag: {f}
                </span>
              ))}
            </div>

            <ComparisonTable comparisons={comparisons} />
          </section>
        );
      })}
    </div>
  );
}

function ComparisonTable({ comparisons }: { comparisons: Comparison[] }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="comparison">
      <button className="comparison-toggle" onClick={() => setOpen(!open)}>
        {open ? 'Hide' : 'Show'} all {comparisons.length} comparisons vs reference
      </button>
      {open && (
        <div className="comparison-scroll">
          <table>
            <thead>
              <tr>
                <th>Output</th>
                <th>Engine</th>
                <th>Reference</th>
                <th>Match</th>
              </tr>
            </thead>
            <tbody>
              {comparisons.map((c) => (
                <tr key={c.label}>
                  <td>{c.label}</td>
                  <td>{c.computed}</td>
                  <td>{c.expected}</td>
                  <td className={c.pass ? 'cell-pass' : 'cell-fail'}>{c.pass ? '✓ pass' : '✕ FAIL'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
