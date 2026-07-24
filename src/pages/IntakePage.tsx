import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { track } from '../lib/analytics';
import { type QuestionRow } from '../lib/rubric';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  useActiveAssessment,
  useAnswers,
  useAnswerProvenance,
  useCompany,
  useEngagement,
  useLedgerConnections,
  useRubric,
} from '../lib/queries';
import { EngagementNav, ErrorState, PageHeader, SkeletonLines } from '../components/ui';
import { PLImportPanel, type FinancialEntry } from '../components/PLImportPanel';
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
  const qc = useQueryClient();

  const assessmentQ = useActiveAssessment(assessmentId);
  const assessment = assessmentQ.data ?? null;
  const rubricQ = useRubric(assessment?.rubric_version_id);
  const rubric = rubricQ.data ?? null;
  const answersQ = useAnswers(assessmentId);
  const engagementQ = useEngagement(assessment?.engagement_id);
  const companyId = engagementQ.data?.company_id;
  const companyQ = useCompany(companyId);
  const companyName = companyQ.data?.name ?? '';
  const connQ = useLedgerConnections(companyId);
  const provenanceQ = useAnswerProvenance(assessmentId);
  const provenance = provenanceQ.data ?? {};
  const connectedProvider = (connQ.data ?? []).find((c) => c.status === 'connected')?.provider ?? null;

  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [step, setStep] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const seeded = useRef(false);

  const engagementId = assessment?.engagement_id ?? '';

  // Redirect completed assessments to results (immutable — no intake).
  useEffect(() => {
    if (assessment?.status === 'completed') {
      navigate(`/assessment/${assessmentId}/results`, { replace: true });
    }
  }, [assessment, assessmentId, navigate]);

  // R6: record that intake was entered, so a session that stalls in intake
  // (started, never submitted) is reconstructable. Fires once per assessment.
  const startedTracked = useRef(false);
  useEffect(() => {
    if (!startedTracked.current && engagementId && engagementQ.data && assessment?.status !== 'completed') {
      startedTracked.current = true;
      track({
        type: 'assessment',
        name: 'assessment_started',
        firmId: engagementQ.data.firm_id,
        profileId: profile?.id,
        engagementId,
        properties: { assessment_id: assessmentId },
      });
    }
  }, [engagementId, engagementQ.data, assessment?.status, assessmentId, profile?.id]);

  // Seed drafts once from the saved answers, applying the same defaults as
  // before (rank order, empty numeric-list rows).
  useEffect(() => {
    if (seeded.current || !rubric || !answersQ.data) return;
    const byQuestion = new Map<string, unknown>(
      answersQ.data.map((a) => [a.question_id, a.value]),
    );
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

  // Stable index from a question's rubric code to its row, so figures extracted
  // from a P&L (keyed by code) can be dropped onto the matching intake fields.
  const questionsByCode = useMemo(() => {
    const m = new Map<string, QuestionRow>();
    if (rubric) {
      for (const qs of rubric.questionsByDimension.values()) for (const q of qs) m.set(q.code, q);
    }
    return m;
  }, [rubric]);

  // A P&L import wrote verified financial answers server-side (enter-manual-
  // financials). Reflect them in the open drafts and refresh provenance so the
  // fields show their new values and the verified source immediately.
  const onFinancialsApplied = (entries: FinancialEntry[]) => {
    setDrafts((prev) => {
      const next = new Map(prev);
      for (const { code, value } of entries) {
        const q = questionsByCode.get(code);
        if (q) next.set(q.id, draftFromValue(q, value));
      }
      return next;
    });
    qc.invalidateQueries({ queryKey: ['answers', assessmentId ?? ''] });
    qc.invalidateQueries({ queryKey: ['answerProvenance', assessmentId ?? ''] });
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
  const progressPct = scoredQuestions.length
    ? Math.round((answeredCount / scoredQuestions.length) * 100)
    : 0;

  const saveStep = async (): Promise<void> => {
    const savedByQuestion = new Map((answersQ.data ?? []).map((a) => [a.question_id, a.value]));
    const rows = [];
    const overridden: string[] = []; // ledger/doc answers the advisor edited by hand
    const cleared: string[] = []; // previously-saved answers the advisor emptied
    for (const q of questions) {
      const draft = drafts.get(q.id);
      if (!draft) continue;
      const value = toAnswerValue(q, draft);
      if (value === undefined) {
        // Draft present but empty = the advisor cleared a field that was saved
        // before. Remove the persisted row (and its provenance) so the DB matches
        // the emptied UI instead of keeping a stale value the advisor no longer
        // sees. An untouched (never-saved) question falls through harmlessly.
        if (savedByQuestion.has(q.id)) cleared.push(q.id);
        continue;
      }
      rows.push({ assessment_id: assessmentId, question_id: q.id, value, answered_by: profile?.id ?? null });
      const src = provenance[q.id];
      if (
        (src === 'connected_ledger' || src === 'document') &&
        JSON.stringify(value) !== JSON.stringify(savedByQuestion.get(q.id))
      ) {
        overridden.push(q.id);
      }
    }
    if (rows.length > 0) {
      const { error } = await supabase
        .from('answers')
        .upsert(rows, { onConflict: 'assessment_id,question_id' });
      if (error) throw new Error(error.message);
    }
    if (cleared.length > 0) {
      const { error } = await supabase.from('answers').delete().eq('assessment_id', assessmentId).in('question_id', cleared);
      if (error) throw new Error(error.message);
    }
    // A hand-edited or cleared figure is no longer ledger-verified — drop its provenance.
    const staleProvenance = [...overridden, ...cleared];
    if (staleProvenance.length > 0) {
      await supabase.from('answer_provenance').delete().eq('assessment_id', assessmentId).in('question_id', staleProvenance);
      qc.invalidateQueries({ queryKey: ['answerProvenance', assessmentId ?? ''] });
    }
  };

  const missingScored = (): QuestionRow[] => scoredQuestions.filter((q) => !isAnswered(q));

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
        const firstDim = rubric!.dimensions.findIndex((d) =>
          (rubric!.questionsByDimension.get(d.id) ?? []).some((q) => missing.includes(q)),
        );
        if (firstDim >= 0) setStep(firstDim);
        throw new Error(
          `${missing.length} question${missing.length > 1 ? 's' : ''} still need an answer before scoring.`,
        );
      }
      await invokeFunction('score-assessment', { assessment_id: assessmentId });
      track({
        type: 'assessment',
        name: 'assessment_submitted',
        firmId: engagementQ.data?.firm_id,
        profileId: profile?.id,
        engagementId,
        properties: { assessment_id: assessmentId },
      });
      navigate(`/assessment/${assessmentId}/results`);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (assessmentQ.isLoading || rubricQ.isLoading || answersQ.isLoading) {
    return <SkeletonLines lines={6} />;
  }
  if (!rubric || !dimension) {
    return <ErrorState variant="section" error={rubricQ.error ?? assessmentQ.error ?? 'Rubric unavailable'} />;
  }

  const isLast = step === rubric.dimensions.length - 1;
  const stepAnswered = questions.filter((q) => q.scored && isAnswered(q)).length;
  const stepScored = questions.filter((q) => q.scored).length;

  return (
    <div className="intake">
      <header className="page-masthead">
        <PageHeader
          title="Assessment intake"
          crumbs={[
            { label: 'Engagements', to: '/' },
            ...(engagementId
              ? [{ label: companyName || 'Engagement', to: `/engagement/${engagementId}` }]
              : []),
            { label: 'Assessment intake' },
          ]}
          actions={
            <button className="linkish" onClick={() => navigate(`/engagement/${engagementId}`)}>
              Save &amp; exit
            </button>
          }
        />
        {engagementId && <EngagementNav engagementId={engagementId} />}
      </header>

      <div className="intake-progress">
        <div className="intake-progress-track">
          <div className="intake-progress-fill" style={{ width: `${progressPct}%` }} />
        </div>
        <span className="intake-progress-label muted">
          {answeredCount} of {scoredQuestions.length} answered
        </span>
      </div>

      {/* Carried forward from the prior assessment (docs/archive/34 C1): re-assessments
          seed last quarter's answers so the advisor edits deltas, not the whole
          rubric. Make that explicit rather than silently pre-filling. */}
      {assessment && assessment.sequence_number > 1 && answeredCount > 0 && (
        <div className="ledger-import">
          <div>
            <strong>Starting from your last assessment.</strong>{' '}
            <span className="muted">
              These answers carried forward from assessment #{assessment.sequence_number - 1}.
              Review each one and update what’s changed this quarter. Financial figures revert to
              self-reported until re-verified.
            </span>
          </div>
        </div>
      )}

      {connectedProvider && (
        <div className="ledger-import">
          <div>
            <strong>{connectedProvider === 'quickbooks' ? 'QuickBooks' : 'Xero'} is connected.</strong>{' '}
            <span className="muted">
              Automatic import of verified figures lands with the live{' '}
              {connectedProvider === 'quickbooks' ? 'QuickBooks' : 'Xero'} integration. For now, enter
              the financials below. They count as verified when they come from the client's financial
              statements.
            </span>
          </div>
        </div>
      )}

      {assessmentId && (
        <PLImportPanel
          assessmentId={assessmentId}
          firmId={engagementQ.data?.firm_id}
          engagementId={engagementId}
          profileId={profile?.id}
          onApplied={onFinancialsApplied}
        />
      )}

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
              {dimension.score_group === 'business_readiness' ? 'Business readiness' : 'Owner readiness'}{' '}
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
            source={provenance[q.id]}
          />
        ))}
      </section>

      {error && <ErrorState variant="inline" error={error} className="intake-error" />}

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
