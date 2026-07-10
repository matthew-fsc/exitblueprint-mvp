import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  gapReason,
  interpretSubScore,
  type SubScoreExplainLike,
} from '../../shared/scoring/interpret';

interface Explain {
  subScores: SubScoreExplainLike[];
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

const TIERS = [
  { label: 'Institutional Grade', floor: 85 },
  { label: 'Sale Ready', floor: 70 },
  { label: 'Needs Work', floor: 55 },
  { label: 'High Risk', floor: 40 },
  { label: 'Not Saleable (Yet)', floor: 0 },
];

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
        const ex = await invokeFunction<Explain>('explain-assessment', { assessment_id: assessmentId });
        setExplain(ex);
      } catch (err) {
        setError((err as Error).message);
      }
    })();
  }, [assessmentId]);

  const subScoreNames = useMemo(
    () => new Map((explain?.subScores ?? []).map((s) => [s.code, s.name])),
    [explain],
  );

  if (error) return <p className="form-error">{error}</p>;
  if (!assessment || !explain) return <p className="muted">Loading results…</p>;

  const divergent = Math.abs(explain.drsScore - explain.oriScore) >= 15;
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
          <Link className="button-link" to={`/assessment/${assessment.id}/workbench`}>
            what-if workbench →
          </Link>
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

      {/* Score summary */}
      <section className="score-tiles">
        <div className="tile score-tile">
          <span className="tile-label">Business readiness</span>
          <span className="tile-value hero-tile-value">{explain.drsScore}</span>
          <span className={`status-chip status-${tierStatus[explain.drsTier] ?? 'neutral'}`}>
            {explain.drsTier}
          </span>
          <span className="muted tile-note">Diligence Readiness Score, out of 100</span>
        </div>
        <div className="tile score-tile">
          <span className="tile-label">Owner readiness</span>
          <span className="tile-value hero-tile-value">{explain.oriScore}</span>
          <span className="muted tile-note">
            The owner’s personal and financial readiness, scored on its own — never blended into the
            business score.
          </span>
        </div>
        <div className={`tile score-tile ${divergent ? 'tile-flag' : ''}`}>
          <span className="tile-label">Reading the two together</span>
          <span className="tile-narrative">
            {divergent
              ? 'The business and the owner are at different stages of readiness. That gap is a finding in itself: the plan should move both forward, not just one.'
              : 'The business and the owner are broadly aligned in readiness.'}
          </span>
        </div>
      </section>

      {/* How the score works — plain overview */}
      <details className="how-it-works">
        <summary>How this score is built</summary>
        <div className="how-body">
          <p>
            Six areas of the business are each scored out of 100 from your assessment answers. Those
            six roll up — weighted by how much buyers care about each — into the single{' '}
            <strong>Business readiness</strong> score above. The owner’s personal readiness is scored
            separately and never mixed in.
          </p>
          <p className="muted">
            Every number below traces straight back to an answer you gave. Nothing is estimated, and
            no AI is involved in the scoring — the same answers always produce the same score.
          </p>
          <div className="tier-ladder">
            {TIERS.map((t) => (
              <div
                key={t.label}
                className={`tier-rung ${t.label === explain.drsTier ? 'tier-rung-current' : ''}`}
              >
                <span className="tier-floor">{t.floor}+</span>
                <span className="tier-name">{t.label}</span>
                {t.label === explain.drsTier && <span className="tier-you">you are here</span>}
              </div>
            ))}
          </div>
        </div>
      </details>

      <h3 className="section-heading">The six business areas</h3>
      <p className="section-sub muted">
        Open any area to see, in plain terms, what it measures and what your answers showed.
      </p>
      <div className="dimension-list">
        {explain.dimensions.map((d) => {
          const readings = explain.subScores
            .filter((s) => s.dimensionCode === d.code)
            .map(interpretSubScore)
            .sort((a, b) => a.points - b.points); // weakest first — that's where the work is
          const dimStatus =
            d.score >= 75 ? 'good' : d.score >= 55 ? 'ok' : d.score >= 40 ? 'warning' : 'critical';
          return (
            <details key={d.code} className="dim-card">
              <summary>
                <span className="dim-head">
                  <span className="dim-name">{d.name}</span>
                  <span className="dim-track">
                    <span className={`dim-fill dim-fill-${dimStatus}`} style={{ width: `${d.score}%` }} />
                  </span>
                  <span className="dim-value">{d.score}</span>
                </span>
                <span className="dim-expand">details</span>
              </summary>
              <div className="dim-body">
                <p className="dim-contrib muted">
                  This area is worth {Math.round(d.drsWeight * 100)}% of the business score, so it adds{' '}
                  {d.contributionToDrs} of the {explain.drsScore} points overall.
                </p>
                <ul className="factor-list">
                  {readings.map((r) => (
                    <li key={r.code} className="factor">
                      <span className={`factor-badge status-${r.band.status}`}>{r.band.label}</span>
                      <span className="factor-text">
                        <strong>{r.name}</strong> — {r.measures}.
                        <span className="factor-reading"> {r.reading}</span>
                        <span className="factor-benchmark muted"> Target: {r.benchmark}.</span>
                      </span>
                      <span className="factor-score">{r.points}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          );
        })}
      </div>

      <h3 className="section-heading">The owner’s side</h3>
      <p className="section-sub muted">
        Scored separately from the business. A ready business and an unready owner is a common — and
        important — mismatch.
      </p>
      <div className="dimension-list">
        {ownerGroups.map((g) => (
          <div key={g.code} className="owner-card">
            <h4>{g.name}</h4>
            <ul className="factor-list">
              {g.subs.map(interpretSubScore).map((r) => (
                <li key={r.code} className="factor">
                  <span className={`factor-badge status-${r.band.status}`}>{r.band.label}</span>
                  <span className="factor-text">
                    <strong>{r.name}</strong>
                    <span className="factor-reading"> {r.reading}</span>
                  </span>
                  <span className="factor-score">{r.points}</span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>

      <h3 className="section-heading">
        What buyers would flag{' '}
        <span className="count-pill">{explain.firedGaps.length}</span>
      </h3>
      {explain.firedGaps.length === 0 && <p className="gap-none">No gaps flagged — a clean assessment.</p>}
      <ul className="gap-detail-list">
        {explain.firedGaps.map((g) => (
          <li key={g.code}>
            <span className={`gap-chip gap-${severityStatus[g.severity] ?? 'neutral'}`}>{g.severity}</span>
            <span className="gap-text">
              <strong>{g.name}</strong>
              <span className="muted"> {gapReason(g.trigger, subScoreNames)}</span>
            </span>
          </li>
        ))}
        {explain.flags.map((f) => (
          <li key={f}>
            <span className="gap-chip gap-neutral">note</span>
            <span className="gap-text">
              <strong>{f}</strong>
              <span className="muted"> Scored conservatively until it is measured.</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
