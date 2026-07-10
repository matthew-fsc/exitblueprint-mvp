import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { loadRubric, type QuestionRow, type RubricData } from '../lib/rubric';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  QuestionControl,
  draftFromValue,
  emptyListDraft,
  toAnswerValue,
  type Draft,
} from '../lib/answerFields';

export default function IntakePage() {
  const { assessmentId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const [rubric, setRubric] = useState<RubricData | null>(null);
  const [engagementId, setEngagementId] = useState<string>('');
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const { data: assessment, error: aErr } = await supabase
          .from('assessments')
          .select('*')
          .eq('id', assessmentId!)
          .single();
        if (aErr) throw new Error(aErr.message);
        if (assessment.status === 'completed') {
          navigate(`/assessment/${assessmentId}/results`, { replace: true });
          return;
        }
        setEngagementId(assessment.engagement_id);
        const rubricData = await loadRubric(assessment.rubric_version_id);
        setRubric(rubricData);
        const { data: answers } = await supabase
          .from('answers')
          .select('*')
          .eq('assessment_id', assessmentId!);
        const byQuestion = new Map<string, unknown>(
          (answers ?? []).map((a: { question_id: string; value: unknown }) => [a.question_id, a.value]),
        );
        const initial = new Map<string, Draft>();
        for (const qs of rubricData.questionsByDimension.values()) {
          for (const q of qs) {
            if (q.answer_type === 'rank') {
              const saved = byQuestion.get(q.id);
              initial.set(
                q.id,
                Array.isArray(saved)
                  ? { kind: 'rank', order: saved as string[] }
                  : { kind: 'rank', order: (q.options ?? '').split('|').filter(Boolean) },
              );
            } else if (q.answer_type === 'numeric_list') {
              const saved = byQuestion.get(q.id);
              initial.set(q.id, Array.isArray(saved) ? draftFromValue(q, saved) : emptyListDraft(q));
            } else if (byQuestion.has(q.id)) {
              initial.set(q.id, draftFromValue(q, byQuestion.get(q.id)));
            }
          }
        }
        setDrafts(initial);
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    })();
  }, [assessmentId, navigate]);

  const dimension = rubric?.dimensions[step];
  const questions = useMemo(
    () => (dimension ? (rubric?.questionsByDimension.get(dimension.id) ?? []) : []),
    [rubric, dimension],
  );

  const setDraft = (questionId: string, draft: Draft) => {
    setDrafts((prev) => new Map(prev).set(questionId, draft));
  };

  const isAnswered = (q: QuestionRow): boolean => {
    const draft = drafts.get(q.id);
    if (!draft) return false;
    try {
      return toAnswerValue(q, draft) !== undefined;
    } catch {
      return false;
    }
  };

  // Progress across all scored questions (the ones that must be answered).
  const scoredQuestions = useMemo(
    () => (rubric ? [...rubric.questionsByDimension.values()].flat().filter((q) => q.scored) : []),
    [rubric],
  );
  const answeredCount = scoredQuestions.filter(isAnswered).length;
  const progressPct = scoredQuestions.length
    ? Math.round((answeredCount / scoredQuestions.length) * 100)
    : 0;

  const saveStep = async (): Promise<void> => {
    const rows = [];
    for (const q of questions) {
      const draft = drafts.get(q.id);
      if (!draft) continue;
      const value = toAnswerValue(q, draft); // throws on parse errors
      if (value === undefined) continue;
      rows.push({ assessment_id: assessmentId, question_id: q.id, value, answered_by: profile?.id ?? null });
    }
    if (rows.length === 0) return;
    const { error } = await supabase
      .from('answers')
      .upsert(rows, { onConflict: 'assessment_id,question_id' });
    if (error) throw new Error(error.message);
  };

  const missingScored = (): QuestionRow[] =>
    scoredQuestions.filter((q) => !isAnswered(q));

  const goStep = async (target: number) => {
    setError(null);
    setBusy(true);
    try {
      await saveStep();
      setStep(target);
      window.scrollTo(0, 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await saveStep();
      const missing = missingScored();
      if (missing.length > 0) {
        // Jump to the first dimension that still has an unanswered question.
        const firstDim = rubric!.dimensions.findIndex((d) =>
          (rubric!.questionsByDimension.get(d.id) ?? []).some((q) => missing.includes(q)),
        );
        if (firstDim >= 0) setStep(firstDim);
        throw new Error(
          `${missing.length} question${missing.length > 1 ? 's' : ''} still need an answer before scoring.`,
        );
      }
      await invokeFunction('score-assessment', { assessment_id: assessmentId });
      navigate(`/assessment/${assessmentId}/results`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (loading) return <p className="muted">Loading intake…</p>;
  if (!rubric || !dimension) return <p className="form-error">{error ?? 'Rubric unavailable'}</p>;

  const isLast = step === rubric.dimensions.length - 1;
  const stepAnswered = questions.filter((q) => q.scored && isAnswered(q)).length;
  const stepScored = questions.filter((q) => q.scored).length;

  return (
    <div className="intake">
      <div className="page-title-row">
        <h2>Assessment intake</h2>
        <button className="linkish" onClick={() => navigate(`/engagement/${engagementId}`)}>
          Save &amp; exit
        </button>
      </div>

      {/* overall progress */}
      <div className="intake-progress">
        <div className="intake-progress-track">
          <div className="intake-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="intake-progress-label muted">
          {answeredCount} of {scoredQuestions.length} answered
        </span>
      </div>

      {/* step chips (click to jump; answers save first) */}
      <ol className="stepper">
        {rubric.dimensions.map((d, i) => {
          const qs = rubric.questionsByDimension.get(d.id) ?? [];
          const done = qs.filter((q) => q.scored).every((q) => isAnswered(q)) && qs.some((q) => q.scored);
          const cls = i === step ? 'step step-current' : done ? 'step step-done' : 'step';
          return (
            <li key={d.id}>
              <button className={cls} title={d.name} onClick={() => goStep(i)} disabled={busy}>
                {done && i !== step ? '✓ ' : ''}
                {d.code}
              </button>
            </li>
          );
        })}
      </ol>

      <section className="intake-dimension">
        <div className="intake-dim-head">
          <div>
            <h3>{dimension.name}</h3>
            <p className="muted dimension-group">
              {dimension.score_group === 'business_readiness'
                ? 'Business readiness'
                : 'Owner readiness'}{' '}
              · step {step + 1} of {rubric.dimensions.length}
            </p>
          </div>
          {stepScored > 0 && (
            <span className={`step-count ${stepAnswered === stepScored ? 'step-count-done' : ''}`}>
              {stepAnswered}/{stepScored}
            </span>
          )}
        </div>

        {questions.map((q) => (
          <QuestionControl
            key={q.id}
            question={q}
            draft={drafts.get(q.id)}
            answered={isAnswered(q)}
            onChange={setDraft}
          />
        ))}
      </section>

      {error && <p className="form-error intake-error">{error}</p>}

      <div className="intake-nav">
        <button className="btn-ghost" disabled={step === 0 || busy} onClick={() => goStep(step - 1)}>
          ← Back
        </button>
        {isLast ? (
          <button disabled={busy} onClick={submit}>
            {busy ? 'Scoring…' : 'Submit & score'}
          </button>
        ) : (
          <button disabled={busy} onClick={() => goStep(step + 1)}>
            {busy ? 'Saving…' : 'Save & continue →'}
          </button>
        )}
      </div>
    </div>
  );
}
