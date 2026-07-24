import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../../lib/auth';
import { type QuestionRow } from '../../lib/rubric';
import { invokeFunction } from '../../lib/supabase';
import { useActiveAssessment, useAnswers, useRubric } from '../../lib/queries';
import { saveAnswers } from '../../lib/intakeSave';
import { Card, ErrorState, PageHeader, SkeletonLines, useToast } from '../../components/ui';
import {
  QuestionControl,
  draftFromValue,
  emptyListDraft,
  toAnswerValue,
  type Draft,
} from '../../lib/answerFields';

// The client (business owner) side of the assessment. Their advisor shared an
// in-progress assessment to the portal (assessments.shared_with_client_at), and RLS
// (owner_shared_intake_read / owner_shared_intake_answers) lets the owner read the
// draft and write its answers — the exact same rubric the advisor sees, saved
// through the shared saveAnswers core. Deliberately WITHOUT the advisor-only pieces:
// no P&L import, no provenance writes, and no "Submit & score" (scoring is
// advisor-only — the client instead marks the assessment "ready for review" via
// submit-client-intake, and can keep editing afterward).
export default function OwnerIntakePage() {
  const { assessmentId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();

  const assessmentQ = useActiveAssessment(assessmentId);
  const assessment = assessmentQ.data ?? null;
  const rubricQ = useRubric(assessment?.rubric_version_id);
  const rubric = rubricQ.data ?? null;
  const answersQ = useAnswers(assessmentId);

  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const seeded = useRef(false);

  // A completed (scored) or unshared assessment must not be editable here. RLS
  // already hides an unshared draft (assessmentQ resolves null); a completed one
  // belongs on the results view, so bounce back to the portal home.
  useEffect(() => {
    if (assessment && assessment.status === 'completed') navigate('/portal', { replace: true });
  }, [assessment, navigate]);

  // Not loading, and RLS returned nothing → not shared to this client. Home.
  useEffect(() => {
    if (!assessmentQ.isLoading && !assessmentQ.isError && assessment === null) {
      navigate('/portal', { replace: true });
    }
  }, [assessmentQ.isLoading, assessmentQ.isError, assessment, navigate]);

  // Seed drafts once from saved answers (same defaults as the advisor intake).
  useEffect(() => {
    if (seeded.current || !rubric || !answersQ.data) return;
    const byQuestion = new Map<string, unknown>(answersQ.data.map((a) => [a.question_id, a.value]));
    const initial = new Map<string, Draft>();
    for (const qs of rubric.questionsByDimension.values()) {
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
    seeded.current = true;
  }, [rubric, answersQ.data]);

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

  const scoredQuestions = useMemo(
    () => (rubric ? [...rubric.questionsByDimension.values()].flat().filter((q) => q.scored) : []),
    [rubric],
  );
  const answeredCount = scoredQuestions.filter(isAnswered).length;
  const remainingCount = scoredQuestions.length - answeredCount;
  const progressPct = scoredQuestions.length ? Math.round((answeredCount / scoredQuestions.length) * 100) : 0;
  const submitted = !!assessment?.client_submitted_at;

  const progressNudge =
    scoredQuestions.length === 0
      ? null
      : remainingCount === 0
        ? 'Everything is answered — send it to your advisor for review when you’re ready.'
        : answeredCount === 0
          ? 'Answer each question as best you can. You can save and come back anytime.'
          : `${remainingCount} question${remainingCount === 1 ? '' : 's'} left — keep going.`;

  const persist = async (): Promise<void> => {
    const savedByQuestion = new Map((answersQ.data ?? []).map((a) => [a.question_id, a.value]));
    await saveAnswers({
      assessmentId: assessmentId!,
      questions,
      drafts,
      savedByQuestion,
      answeredBy: profile?.id ?? null,
    });
    qc.invalidateQueries({ queryKey: ['answers', assessmentId ?? ''] });
  };

  const goStep = async (target: number) => {
    setError(null);
    setBusy(true);
    try {
      await persist();
      setStep(target);
      window.scrollTo(0, 0);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const sendForReview = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await persist();
      await invokeFunction('submit-client-intake', { assessment_id: assessmentId });
      qc.invalidateQueries({ queryKey: ['assessment', 'active', assessmentId ?? ''] });
      toast.show('Sent to your advisor for review', 'good');
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  };

  if (assessmentQ.isError) {
    return (
      <>
        <PageHeader title="Your assessment" subtitle="Answer the questions your advisor sent you." />
        <ErrorState variant="section" error={assessmentQ.error} onRetry={assessmentQ.refetch} />
      </>
    );
  }

  if (!assessment || !rubric || !dimension) {
    return (
      <Card>
        <SkeletonLines lines={6} />
      </Card>
    );
  }

  const isLast = step === rubric.dimensions.length - 1;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Your assessment"
        subtitle="Answer these as best you can. Your advisor is working on this with you and can help with anything you’re unsure about."
      />

      {submitted && (
        <div className="ledger-import">
          <div>
            <strong>Sent for review.</strong>{' '}
            <span className="muted">
              Your advisor has been notified. You can still make changes — just let them know if you
              update anything.
            </span>
          </div>
        </div>
      )}

      <div
        className={`intake-progress ${progressPct === 100 ? 'intake-progress-complete' : ''}`}
        role="progressbar"
        aria-valuenow={progressPct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Assessment completion"
      >
        <div className="intake-progress-bar">
          <div className="intake-progress-track">
            <div className="intake-progress-fill" style={{ width: `${progressPct}%` }} />
          </div>
          <span className="intake-progress-label muted">
            {answeredCount} of {scoredQuestions.length} answered · {progressPct}%
          </span>
        </div>
        {progressNudge && <p className="intake-progress-nudge">{progressNudge}</p>}
      </div>

      <ol className="stepper">
        {rubric.dimensions.map((d, i) => {
          const qs = rubric.questionsByDimension.get(d.id) ?? [];
          const done = qs.filter((q) => q.scored).every((q) => isAnswered(q)) && qs.some((q) => q.scored);
          const cls = i === step ? 'step step-current' : done ? 'step step-done' : 'step';
          return (
            <li key={d.id}>
              <button className={cls} title={d.name} onClick={() => goStep(i)} disabled={busy || submitting}>
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
              {dimension.score_group === 'business_readiness' ? 'Your business' : 'You, the owner'} · step{' '}
              {step + 1} of {rubric.dimensions.length}
            </p>
          </div>
        </div>

        {questions.map((q) => (
          <QuestionControl key={q.id} question={q} draft={drafts.get(q.id)} answered={isAnswered(q)} onChange={setDraft} />
        ))}
      </section>

      {error && <ErrorState variant="inline" error={error} className="intake-error" />}

      <div className="intake-nav">
        <button className="btn-ghost" disabled={step === 0 || busy || submitting} onClick={() => goStep(step - 1)}>
          ← Back
        </button>
        {isLast ? (
          <button disabled={busy || submitting} onClick={sendForReview}>
            {submitting ? 'Sending…' : submitted ? 'Re-send for review' : 'Send to my advisor'}
          </button>
        ) : (
          <button disabled={busy || submitting} onClick={() => goStep(step + 1)}>
            {busy ? 'Saving…' : 'Save & continue →'}
          </button>
        )}
      </div>
    </div>
  );
}
