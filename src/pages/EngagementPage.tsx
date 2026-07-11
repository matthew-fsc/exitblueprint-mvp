import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { loadActiveRubricVersion } from '../lib/rubric';
import { supabase } from '../lib/supabase';
import {
  qk,
  useAssessmentsByEngagement,
  useCompany,
  useEngagement,
  type AssessmentRow,
} from '../lib/queries';
import {
  Card,
  DeltaChip,
  EmptyState,
  PageHeader,
  SkeletonLines,
  TierBadge,
  TrajectoryChart,
  type TrajectoryPoint,
} from '../components/ui';
import { fmtDate, fmtScore } from '../lib/format';

export default function EngagementPage() {
  const { engagementId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const assessmentsQ = useAssessmentsByEngagement(engagementId);
  const assessments = assessmentsQ.data ?? [];
  const [error, setError] = useState<string | null>(null);

  const startAssessment = async () => {
    setError(null);
    try {
      const rubricVersion = await loadActiveRubricVersion();
      const { data: last } = await supabase
        .from('assessments')
        .select('*')
        .eq('engagement_id', engagementId!)
        .order('sequence_number', { ascending: false })
        .limit(1);
      const nextSequence = (last?.[0]?.sequence_number ?? 0) + 1;
      const { data, error } = await supabase
        .from('assessments')
        .insert([
          {
            firm_id: engagement!.firm_id,
            engagement_id: engagementId,
            rubric_version_id: rubricVersion.id,
            sequence_number: nextSequence,
          },
        ])
        .select()
        .single();
      if (error) throw new Error(error.message);
      qc.invalidateQueries({ queryKey: qk.assessmentsByEngagement(engagementId!) });
      navigate(`/assessment/${data.id}/intake`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (engagementQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={4} />
      </Card>
    );
  }
  if (!engagement) return <p className="form-error">{engagementQ.error?.message ?? 'Engagement not found'}</p>;

  const companyName = companyQ.data?.name ?? '';
  const inProgress = assessments.find((a) => a.status === 'in_progress');
  const scored = assessments.filter((a) => a.status === 'completed' && a.drs_score != null);
  const points: TrajectoryPoint[] = scored.map((a) => ({
    label: `#${a.sequence_number}`,
    score: Number(a.drs_score),
    tier: a.drs_tier ?? undefined,
  }));
  const delta =
    scored.length > 1
      ? Number(scored[scored.length - 1].drs_score) - Number(scored[0].drs_score)
      : null;

  return (
    <div>
      <PageHeader
        title={companyName}
        crumbs={[{ label: 'Clients', to: '/' }, { label: companyName }]}
        subtitle={
          <>
            Engagement {engagement.status}
            {engagement.target_exit_window ? ` · target window ${engagement.target_exit_window}` : ''}
          </>
        }
        actions={
          !inProgress && profile ? (
            <button onClick={startAssessment}>
              {assessments.length === 0 ? 'Start baseline assessment' : 'Start re-assessment'}
            </button>
          ) : undefined
        }
      />
      {error && <p className="form-error">{error}</p>}

      {scored.length > 0 && (
        <Card>
          <div className="trajectory-head">
            <h3 className="section-heading" style={{ margin: 0 }}>
              Business readiness over time
            </h3>
            {delta !== null && <DeltaChip value={delta} />}
          </div>
          <div style={{ marginTop: '0.75rem' }}>
            <TrajectoryChart points={points} />
          </div>
        </Card>
      )}

      <h3 className="section-heading">Assessments</h3>
      {assessments.length === 0 && (
        <EmptyState title="No assessments yet" action={profile && <button onClick={startAssessment}>Start baseline assessment</button>}>
          The baseline assessment sets the starting DRS for this engagement.
        </EmptyState>
      )}
      <ul className="assessment-list">
        {assessments.map((a) => (
          <AssessmentCard key={a.id} a={a} />
        ))}
      </ul>
    </div>
  );
}

function AssessmentCard({ a }: { a: AssessmentRow }) {
  return (
    <li className="assessment-card">
      <span className="assessment-seq">#{a.sequence_number}</span>
      {a.status === 'completed' ? (
        <>
          <span className="assessment-score">
            DRS <strong className="tnum">{fmtScore(Number(a.drs_score))}</strong>{' '}
            {a.drs_tier && <TierBadge tier={a.drs_tier} size="sm" />} · ORI{' '}
            <span className="tnum">{fmtScore(Number(a.ori_score))}</span>
          </span>
          <span className="muted">{a.completed_at ? fmtDate(a.completed_at) : ''}</span>
          <Link className="button-link" to={`/assessment/${a.id}/results`}>
            Results →
          </Link>
          <Link className="button-link" to={`/assessment/${a.id}/workbench`}>
            What-if →
          </Link>
        </>
      ) : (
        <>
          <span className="muted">in progress</span>
          <Link className="button-link" to={`/assessment/${a.id}/intake`}>
            Resume intake →
          </Link>
        </>
      )}
    </li>
  );
}
