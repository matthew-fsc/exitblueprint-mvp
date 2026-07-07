import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { loadActiveRubricVersion } from '../lib/rubric';
import { supabase } from '../lib/supabase';

interface Engagement {
  id: string;
  firm_id: string;
  company_id: string;
  status: string;
  target_exit_window: string | null;
  started_at: string;
}

interface AssessmentRow {
  id: string;
  sequence_number: number;
  status: 'in_progress' | 'completed';
  completed_at: string | null;
  drs_score: number | null;
  drs_tier: string | null;
  ori_score: number | null;
  created_at: string;
}

export default function EngagementPage() {
  const { engagementId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [engagement, setEngagement] = useState<Engagement | null>(null);
  const [companyName, setCompanyName] = useState('');
  const [assessments, setAssessments] = useState<AssessmentRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const { data: eng, error: eErr } = await supabase
      .from('engagements')
      .select('*')
      .eq('id', engagementId!)
      .single();
    if (eErr) {
      setError(eErr.message);
      setLoading(false);
      return;
    }
    setEngagement(eng as Engagement);
    const { data: company } = await supabase
      .from('companies')
      .select('*')
      .eq('id', eng.company_id)
      .single();
    setCompanyName(company?.name ?? '');
    // Longitudinal read path: active assessments only (docs/02).
    const { data: rows } = await supabase
      .from('active_assessments')
      .select('*')
      .eq('engagement_id', engagementId!)
      .order('sequence_number');
    setAssessments((rows as AssessmentRow[]) ?? []);
    setLoading(false);
  }, [engagementId]);

  useEffect(() => {
    load();
  }, [load]);

  const startAssessment = async () => {
    setError(null);
    try {
      // Lock the new assessment to the currently active rubric version.
      const rubricVersion = await loadActiveRubricVersion();
      // Next sequence over ALL assessments (incl. superseded) for uniqueness.
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
      navigate(`/assessment/${data.id}/intake`);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  if (loading) return <p className="muted">Loading engagement…</p>;
  if (!engagement) return <p className="form-error">{error ?? 'Engagement not found'}</p>;

  const inProgress = assessments.find((a) => a.status === 'in_progress');

  return (
    <div>
      <div className="page-title-row">
        <h2>{companyName}</h2>
        <span className="muted">
          engagement {engagement.status}
          {engagement.target_exit_window ? ` · target window ${engagement.target_exit_window}` : ''}
        </span>
      </div>
      {error && <p className="form-error">{error}</p>}

      <h3 className="section-heading">Assessments</h3>
      {assessments.length === 0 && <p className="muted">No assessments yet.</p>}
      <ul className="assessment-list">
        {assessments.map((a) => (
          <li key={a.id} className="assessment-card">
            <span className="assessment-seq">#{a.sequence_number}</span>
            {a.status === 'completed' ? (
              <>
                <span className="assessment-score">
                  DRS <strong>{Number(a.drs_score)}</strong> · {a.drs_tier} · ORI{' '}
                  {Number(a.ori_score)}
                </span>
                <span className="muted">
                  {a.completed_at ? new Date(a.completed_at).toLocaleDateString() : ''}
                </span>
                <Link className="button-link" to={`/assessment/${a.id}/results`}>
                  Results →
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
        ))}
      </ul>
      {!inProgress && profile && (
        <button onClick={startAssessment}>
          {assessments.length === 0 ? 'Start baseline assessment' : 'Start re-assessment'}
        </button>
      )}
    </div>
  );
}
