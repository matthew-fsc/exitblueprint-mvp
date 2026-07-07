import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { supabase } from '../lib/supabase';

// Shape returned by the explain-assessment server function (docs/03).
interface SubScoreExplain {
  code: string;
  name: string;
  dimensionCode: string;
  formulaType: string;
  inputs: Record<string, unknown>;
  computed: Record<string, unknown>;
  points: number;
  weight: number;
  contribution: number;
}

interface Explain {
  subScores: SubScoreExplain[];
  dimensions: { code: string; name: string; score: number; drsWeight: number; contributionToDrs: number }[];
  drsScore: number;
  drsTier: string;
  oriScore: number;
  firedGaps: { code: string; name: string; severity: string; trigger: unknown }[];
  flags: string[];
}

interface AssessmentRow {
  id: string;
  engagement_id: string;
  rubric_version_id: string;
  sequence_number: number;
  completed_at: string | null;
  status: string;
}

const severityStatus: Record<string, string> = {
  critical: 'critical',
  high: 'serious',
  med: 'warning',
  low: 'neutral',
};

const tierStatus: Record<string, string> = {
  'Institutional Grade': 'good',
  'Sale Ready': 'good',
  'Needs Work': 'warning',
  'High Risk': 'serious',
  'Not Saleable (Yet)': 'critical',
};

function triggerText(trigger: unknown): string {
  const t = trigger as Record<string, unknown>;
  switch (t?.type) {
    case 'sub_score_below':
      return `sub-score ${t.code} below ${t.threshold}`;
    case 'answer_in':
      return `${t.question_code} is ${(t.values as string[]).join(' or ')}`;
    case 'answer_lte':
      return `${t.question_code} ≤ ${t.value}`;
    case 'composite_below':
      return `DRS below ${t.threshold}`;
    case 'all':
      return (t.conditions as unknown[]).map(triggerText).join(' AND ');
    default:
      return JSON.stringify(t);
  }
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return '—';
  if (Array.isArray(v)) return v.join(', ');
  return String(v);
}

export default function ResultsPage() {
  const { assessmentId } = useParams();
  const [assessment, setAssessment] = useState<AssessmentRow | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [versionLabel, setVersionLabel] = useState('');
  const [ownerDimNames, setOwnerDimNames] = useState<Map<string, string>>(new Map());
  const [explain, setExplain] = useState<Explain | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Longitudinal read path: active assessments only (docs/02).
        const { data: a, error: aErr } = await supabase
          .from('active_assessments')
          .select('*')
          .eq('id', assessmentId!)
          .single();
        if (aErr) throw new Error(aErr.message);
        setAssessment(a as AssessmentRow);
        const { data: engagement } = await supabase
          .from('engagements')
          .select('*')
          .eq('id', a.engagement_id)
          .single();
        if (engagement) {
          const { data: company } = await supabase
            .from('companies')
            .select('*')
            .eq('id', engagement.company_id)
            .single();
          setCompanyName(company?.name ?? '');
        }
        const { data: version } = await supabase
          .from('rubric_versions')
          .select('*')
          .eq('id', a.rubric_version_id)
          .single();
        setVersionLabel(version?.version_label ?? '');
        const { data: dims } = await supabase
          .from('dimensions')
          .select('*')
          .eq('rubric_version_id', a.rubric_version_id)
          .eq('score_group', 'owner_readiness');
        setOwnerDimNames(new Map((dims ?? []).map((d: { code: string; name: string }) => [d.code, d.name])));
        const { data: ex, error: exErr } = await supabase.functions.invoke('explain-assessment', {
          body: { assessment_id: assessmentId },
        });
        if (exErr) throw new Error(exErr.message);
        setExplain(ex as Explain);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [assessmentId]);

  if (error) return <p className="form-error">{error}</p>;
  if (!assessment || !explain) return <p className="muted">Loading results…</p>;

  const ownerSubs = explain.subScores.filter((s) => ownerDimNames.has(s.dimensionCode));
  const ownerGroups = [...ownerDimNames.keys()]
    .map((code) => ({
      code,
      name: ownerDimNames.get(code)!,
      subs: ownerSubs.filter((s) => s.dimensionCode === code),
    }))
    .filter((g) => g.subs.length > 0);

  return (
    <div className="results">
      <div className="page-title-row">
        <h2>
          {companyName} <span className="muted">· assessment #{assessment.sequence_number}</span>
        </h2>
        <span className="muted">
          {versionLabel}
          {assessment.completed_at ? ` · ${new Date(assessment.completed_at).toLocaleDateString()}` : ''}
          {' · '}
          <Link className="button-link" to={`/assessment/${assessment.id}/report`}>
            owner report →
          </Link>
          {' · '}
          <Link className="button-link" to={`/engagement/${assessment.engagement_id}`}>
            engagement →
          </Link>
        </span>
      </div>

      {/* Two score groups, shown distinctly; never blended (CLAUDE.md rule 3a). */}
      <section className="score-tiles">
        <div className="tile score-tile">
          <span className="tile-label">Business readiness · DRS</span>
          <span className="tile-value hero-tile-value">{explain.drsScore}</span>
          <span className={`status-chip status-${tierStatus[explain.drsTier] ?? 'neutral'}`}>
            ● {explain.drsTier}
          </span>
        </div>
        <div className="tile score-tile">
          <span className="tile-label">Owner readiness · ORI</span>
          <span className="tile-value hero-tile-value">{explain.oriScore}</span>
          <span className="muted tile-note">personal & goal readiness, scored separately</span>
        </div>
        <div className="tile score-tile">
          <span className="tile-label">Overall readiness</span>
          <span className="composite-pair">
            <span>
              Business <strong>{explain.drsScore}</strong>
            </span>
            <span>
              Owner <strong>{explain.oriScore}</strong>
            </span>
          </span>
          <span className="muted tile-note">
            {Math.abs(explain.drsScore - explain.oriScore) >= 15
              ? 'Divergence flag: business and owner readiness are far apart — that gap is itself the diagnostic.'
              : 'Business and owner readiness are broadly aligned.'}
            {' '}Score groups are never blended into one number (methodology rule).
          </span>
        </div>
      </section>

      <h3 className="section-heading">Business dimensions (roll up to DRS)</h3>
      <div className="dimension-table">
        {explain.dimensions.map((d) => {
          const subs = explain.subScores.filter((s) => s.dimensionCode === d.code);
          return (
            <details key={d.code} className="dim-details">
              <summary>
                <span className="dim-name">{d.name}</span>
                <span className="dim-track">
                  <span className="dim-fill" style={{ width: `${d.score}%` }} />
                </span>
                <span className="dim-value">{d.score}</span>
                <span className="dim-why">why?</span>
              </summary>
              <div className="explain-drawer">
                <p className="muted explain-math">
                  Dimension score {d.score} × DRS weight {d.drsWeight} → contributes{' '}
                  {d.contributionToDrs} of the {explain.drsScore} DRS.
                </p>
                <div className="comparison-scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Sub-score</th>
                        <th>Inputs</th>
                        <th>Computed</th>
                        <th>Points</th>
                        <th>Weight</th>
                        <th>Contribution</th>
                      </tr>
                    </thead>
                    <tbody>
                      {subs.map((s) => (
                        <tr key={s.code}>
                          <td>
                            {s.name}
                            <span className="muted"> ({s.formulaType})</span>
                          </td>
                          <td>
                            {Object.entries(s.inputs).map(([k, v]) => (
                              <div key={k}>
                                {k}: {formatValue(v)}
                              </div>
                            ))}
                          </td>
                          <td>
                            {Object.entries(s.computed).map(([k, v]) => (
                              <div key={k}>
                                {k}: {formatValue(v)}
                              </div>
                            ))}
                          </td>
                          <td>{s.points}</td>
                          <td>{s.weight}</td>
                          <td>{s.contribution}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </details>
          );
        })}
      </div>

      <h3 className="section-heading">Owner readiness (rolls up to ORI)</h3>
      <div className="dimension-table">
        {ownerGroups.map((g) => (
          <div key={g.code} className="owner-group">
            <h4>{g.name}</h4>
            {g.subs.map((s) => (
              <div key={s.code} className="dim-row">
                <span className="dim-name">{s.name}</span>
                <span className="dim-track">
                  <span className="dim-fill dim-fill-owner" style={{ width: `${s.points}%` }} />
                </span>
                <span className="dim-value">{s.points}</span>
              </div>
            ))}
          </div>
        ))}
      </div>

      <h3 className="section-heading">Flagged gaps ({explain.firedGaps.length})</h3>
      {explain.firedGaps.length === 0 && <p className="gap-none">No gaps flagged</p>}
      <ul className="gap-detail-list">
        {explain.firedGaps.map((g) => (
          <li key={g.code}>
            <span className={`gap-chip gap-${severityStatus[g.severity] ?? 'neutral'}`}>
              {g.severity}
            </span>
            <span className="gap-name">{g.name}</span>
            <span className="muted">fired because {triggerText(g.trigger)}</span>
          </li>
        ))}
        {explain.flags.map((f) => (
          <li key={f}>
            <span className="gap-chip gap-neutral">flag</span>
            <span className="gap-name">{f}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
