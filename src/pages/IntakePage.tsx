import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { loadRubric, type QuestionRow, type RubricData } from '../lib/rubric';
import { invokeFunction, supabase } from '../lib/supabase';

// Draft values live as strings/arrays for editing; toAnswerValue() converts to
// the jsonb answer representation the engine consumes (docs/02 answers.value).
type Draft = { kind: 'text'; text: string } | { kind: 'unknown' } | { kind: 'rank'; order: string[] };

function draftFromValue(q: QuestionRow, value: unknown): Draft {
  if (q.answer_type === 'rank' && Array.isArray(value)) return { kind: 'rank', order: value as string[] };
  if (value === 'unknown' && q.answer_type === 'numeric_or_unknown') return { kind: 'unknown' };
  if (Array.isArray(value)) return { kind: 'text', text: value.join(', ') };
  return { kind: 'text', text: value === null || value === undefined ? '' : String(value) };
}

function toAnswerValue(q: QuestionRow, draft: Draft): unknown | undefined {
  if (draft.kind === 'unknown') return 'unknown';
  if (draft.kind === 'rank') return draft.order;
  const text = draft.text.trim();
  if (text === '') return undefined;
  switch (q.answer_type) {
    case 'numeric': {
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error(`${q.code}: '${text}' is not a number`);
      return n;
    }
    case 'numeric_or_unknown': {
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error(`${q.code}: '${text}' is not a number (or mark unknown)`);
      return n;
    }
    case 'numeric_list': {
      const parts = text.split(',').map((s) => Number(s.trim()));
      if (parts.some((n) => Number.isNaN(n))) {
        throw new Error(`${q.code}: enter comma-separated numbers`);
      }
      return parts;
    }
    case 'scale_1_5':
      return Number(text);
    default:
      return text;
  }
}

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
        // The assessment is locked to its rubric_version from creation.
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

  // Upserts this step's non-empty answers (save-and-resume).
  const saveStep = async (): Promise<void> => {
    const rows = [];
    for (const q of questions) {
      const draft = drafts.get(q.id);
      if (!draft) continue;
      const value = toAnswerValue(q, draft); // throws on parse errors
      if (value === undefined) continue;
      rows.push({
        assessment_id: assessmentId,
        question_id: q.id,
        value,
        answered_by: profile?.id ?? null,
      });
    }
    if (rows.length === 0) return;
    const { error } = await supabase
      .from('answers')
      .upsert(rows, { onConflict: 'assessment_id,question_id' });
    if (error) throw new Error(error.message);
  };

  const missingScored = (): string[] => {
    const missing: string[] = [];
    for (const [dimId, qs] of rubric!.questionsByDimension.entries()) {
      void dimId;
      for (const q of qs) {
        if (!q.scored) continue;
        const draft = drafts.get(q.id);
        if (!draft || toAnswerValue(q, draft) === undefined) missing.push(q.code);
      }
    }
    return missing;
  };

  const next = async () => {
    setError(null);
    setBusy(true);
    try {
      await saveStep();
      setStep((s) => s + 1);
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
        throw new Error(`Unanswered scored questions: ${missing.join(', ')}`);
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

  return (
    <div className="intake">
      <div className="page-title-row">
        <h2>
          Assessment intake <span className="muted">· {rubric.versionLabel}</span>
        </h2>
        <button className="linkish" onClick={() => navigate(`/engagement/${engagementId}`)}>
          Save &amp; exit
        </button>
      </div>
      <ol className="stepper">
        {rubric.dimensions.map((d, i) => (
          <li
            key={d.id}
            className={i === step ? 'step step-current' : i < step ? 'step step-done' : 'step'}
          >
            {d.code}
          </li>
        ))}
      </ol>
      <section className="intake-dimension">
        <h3>{dimension.name}</h3>
        <p className="muted dimension-group">
          {dimension.score_group === 'business_readiness' ? 'Business readiness (DRS)' : 'Owner readiness (ORI)'}
        </p>
        {questions.map((q) => (
          <QuestionControl key={q.id} question={q} draft={drafts.get(q.id)} onChange={setDraft} />
        ))}
      </section>
      {error && <p className="form-error">{error}</p>}
      <div className="intake-nav">
        <button className="linkish" disabled={step === 0 || busy} onClick={() => setStep((s) => s - 1)}>
          ← Back
        </button>
        {isLast ? (
          <button disabled={busy} onClick={submit}>
            {busy ? 'Scoring…' : 'Submit & score'}
          </button>
        ) : (
          <button disabled={busy} onClick={next}>
            {busy ? 'Saving…' : 'Save & continue →'}
          </button>
        )}
      </div>
    </div>
  );
}

function QuestionControl({
  question: q,
  draft,
  onChange,
}: {
  question: QuestionRow;
  draft: Draft | undefined;
  onChange: (questionId: string, draft: Draft) => void;
}) {
  const text = draft?.kind === 'text' ? draft.text : '';
  const options = (q.options ?? '').split('|').filter(Boolean);

  return (
    <div className="question" data-qcode={q.code} data-qtype={q.answer_type}>
      <label className="question-prompt">
        {q.prompt}
        {!q.scored && <span className="context-badge">context</span>}
      </label>
      {q.help_text && <p className="question-help">{q.help_text}</p>}

      {q.answer_type === 'numeric' && (
        <input
          type="number"
          step="any"
          value={text}
          onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
        />
      )}

      {q.answer_type === 'numeric_or_unknown' && (
        <div className="control-row">
          <input
            type="number"
            step="any"
            disabled={draft?.kind === 'unknown'}
            value={text}
            onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
          />
          <label className="checkbox-label">
            <input
              type="checkbox"
              checked={draft?.kind === 'unknown'}
              onChange={(e) =>
                onChange(q.id, e.target.checked ? { kind: 'unknown' } : { kind: 'text', text: '' })
              }
            />
            not tracked / unknown
          </label>
        </div>
      )}

      {q.answer_type === 'numeric_list' && (
        <input
          type="text"
          placeholder="comma-separated numbers, e.g. 18, 12, 8, 6, 4"
          value={text}
          onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
        />
      )}

      {q.answer_type === 'select' && (
        <select value={text} onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}>
          <option value="">— select —</option>
          {options.map((o) => (
            <option key={o} value={o}>
              {o.replaceAll('_', ' ')}
            </option>
          ))}
        </select>
      )}

      {q.answer_type === 'scale_1_5' && (
        <div className="control-row scale-row">
          {[1, 2, 3, 4, 5].map((n) => (
            <label key={n} className="checkbox-label">
              <input
                type="radio"
                name={q.id}
                checked={text === String(n)}
                onChange={() => onChange(q.id, { kind: 'text', text: String(n) })}
              />
              {n}
            </label>
          ))}
        </div>
      )}

      {q.answer_type === 'rank' && draft?.kind === 'rank' && (
        <ol className="rank-list">
          {draft.order.map((item, i) => (
            <li key={item}>
              <span>{item.replaceAll('_', ' ')}</span>
              <span className="rank-buttons">
                <button
                  type="button"
                  className="linkish"
                  disabled={i === 0}
                  onClick={() => {
                    const order = [...draft.order];
                    [order[i - 1], order[i]] = [order[i], order[i - 1]];
                    onChange(q.id, { kind: 'rank', order });
                  }}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="linkish"
                  disabled={i === draft.order.length - 1}
                  onClick={() => {
                    const order = [...draft.order];
                    [order[i], order[i + 1]] = [order[i + 1], order[i]];
                    onChange(q.id, { kind: 'rank', order });
                  }}
                >
                  ↓
                </button>
              </span>
            </li>
          ))}
        </ol>
      )}

      {q.answer_type === 'text' && (
        <textarea
          rows={2}
          value={text}
          onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
        />
      )}
    </div>
  );
}
