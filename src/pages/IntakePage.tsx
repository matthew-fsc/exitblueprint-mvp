import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { loadRubric, type QuestionRow, type RubricData } from '../lib/rubric';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  fieldUnit,
  humanizeOption,
  listConfig,
  scaleAnchors,
  useOptionCards,
  type FieldUnit,
} from '../lib/intakeFields';

// Draft values live as editable strings/arrays; toAnswerValue() converts to the
// jsonb the engine consumes (docs/02 answers.value) — that stored format is
// unchanged: number | number[] | option string | 1-5 | "unknown".
type Draft =
  | { kind: 'text'; text: string }
  | { kind: 'unknown' }
  | { kind: 'rank'; order: string[] }
  | { kind: 'list'; items: string[] };

function draftFromValue(q: QuestionRow, value: unknown): Draft {
  if (q.answer_type === 'rank' && Array.isArray(value)) return { kind: 'rank', order: value as string[] };
  if (q.answer_type === 'numeric_list' && Array.isArray(value)) {
    return { kind: 'list', items: (value as number[]).map(String) };
  }
  if (value === 'unknown' && q.answer_type === 'numeric_or_unknown') return { kind: 'unknown' };
  return { kind: 'text', text: value === null || value === undefined ? '' : String(value) };
}

function emptyListDraft(q: QuestionRow): Draft {
  return { kind: 'list', items: listConfig(q).labels.map(() => '') };
}

function toAnswerValue(q: QuestionRow, draft: Draft): unknown | undefined {
  if (draft.kind === 'unknown') return 'unknown';
  if (draft.kind === 'rank') return draft.order;
  if (draft.kind === 'list') {
    const nums: number[] = [];
    for (const raw of draft.items) {
      const t = raw.trim();
      if (t === '') continue; // trailing/blank rows are simply omitted
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error(`${q.prompt} — please enter numbers only`);
      nums.push(n);
    }
    return nums.length > 0 ? nums : undefined;
  }
  const text = draft.text.trim();
  if (text === '') return undefined;
  switch (q.answer_type) {
    case 'numeric':
    case 'numeric_or_unknown': {
      const n = Number(text);
      if (Number.isNaN(n)) throw new Error(`${q.prompt} — please enter a number`);
      return n;
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

/* ---------- field pieces ---------- */

function formatDollars(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  return `$${n.toLocaleString('en-US')}`;
}

function NumberField({
  value,
  onChange,
  unit,
  disabled,
  ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  unit: FieldUnit;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const dollarsHint = unit.dollars ? formatDollars(value) : null;
  return (
    <div className="numfield-wrap">
      <div className={`numfield ${disabled ? 'numfield-disabled' : ''}`}>
        {unit.prefix && <span className="numfield-affix">{unit.prefix}</span>}
        <input
          type="number"
          step="any"
          inputMode="decimal"
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={unit.placeholder ?? ''}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        {unit.suffix && <span className="numfield-affix numfield-suffix">{unit.suffix}</span>}
      </div>
      {dollarsHint && <span className="numfield-hint muted">{dollarsHint}</span>}
    </div>
  );
}

function QuestionControl({
  question: q,
  draft,
  answered,
  onChange,
}: {
  question: QuestionRow;
  draft: Draft | undefined;
  answered: boolean;
  onChange: (questionId: string, draft: Draft) => void;
}) {
  const text = draft?.kind === 'text' ? draft.text : '';
  const options = (q.options ?? '').split('|').filter(Boolean);
  const unit = fieldUnit(q);

  return (
    <div
      className={`question ${answered ? 'question-answered' : ''}`}
      data-qcode={q.code}
      data-qtype={q.answer_type}
    >
      <label className="question-prompt">
        {q.prompt}
        {!q.scored && <span className="context-badge">optional context</span>}
      </label>
      {q.help_text && <p className="question-help">{q.help_text}</p>}

      {q.answer_type === 'numeric' && (
        <NumberField value={text} unit={unit} onChange={(v) => onChange(q.id, { kind: 'text', text: v })} />
      )}

      {q.answer_type === 'numeric_or_unknown' && (
        <div className="control-row">
          <NumberField
            value={draft?.kind === 'unknown' ? '' : text}
            unit={unit}
            disabled={draft?.kind === 'unknown'}
            onChange={(v) => onChange(q.id, { kind: 'text', text: v })}
          />
          <button
            type="button"
            className={`toggle-pill ${draft?.kind === 'unknown' ? 'toggle-pill-on' : ''}`}
            onClick={() =>
              onChange(q.id, draft?.kind === 'unknown' ? { kind: 'text', text: '' } : { kind: 'unknown' })
            }
          >
            {draft?.kind === 'unknown' ? '✓ Not tracked' : 'Not tracked'}
          </button>
        </div>
      )}

      {q.answer_type === 'numeric_list' && (
        <ListField question={q} draft={draft} onChange={onChange} />
      )}

      {q.answer_type === 'select' &&
        (useOptionCards(options) ? (
          <div className="option-cards" role="radiogroup">
            {options.map((o) => (
              <button
                type="button"
                key={o}
                role="radio"
                data-value={o}
                aria-checked={text === o}
                className={`option-card ${text === o ? 'option-card-on' : ''}`}
                onClick={() => onChange(q.id, { kind: 'text', text: o })}
              >
                {humanizeOption(o)}
              </button>
            ))}
          </div>
        ) : (
          <select
            className="pretty-select"
            value={text}
            onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
          >
            <option value="">Choose one…</option>
            {options.map((o) => (
              <option key={o} value={o}>
                {humanizeOption(o)}
              </option>
            ))}
          </select>
        ))}

      {q.answer_type === 'scale_1_5' && <ScaleField question={q} value={text} onChange={onChange} />}

      {q.answer_type === 'rank' && draft?.kind === 'rank' && (
        <ol className="rank-list">
          {draft.order.map((item, i) => (
            <li key={item}>
              <span className="rank-num">{i + 1}</span>
              <span className="rank-label">{humanizeOption(item)}</span>
              <span className="rank-buttons">
                <button
                  type="button"
                  className="rank-move"
                  aria-label="Move up"
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
                  className="rank-move"
                  aria-label="Move down"
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
          placeholder="Optional — add context for the report"
          value={text}
          onChange={(e) => onChange(q.id, { kind: 'text', text: e.target.value })}
        />
      )}
    </div>
  );
}

function ListField({
  question: q,
  draft,
  onChange,
}: {
  question: QuestionRow;
  draft: Draft | undefined;
  onChange: (questionId: string, draft: Draft) => void;
}) {
  const cfg = listConfig(q);
  const items = draft?.kind === 'list' ? draft.items : cfg.labels.map(() => '');
  const setItem = (i: number, v: string) => {
    const next = [...items];
    next[i] = v;
    onChange(q.id, { kind: 'list', items: next });
  };
  return (
    <div className="list-field">
      {items.map((val, i) => (
        <div className="list-row" key={i}>
          <span className="list-row-label">{cfg.labels[i] ?? `Item ${i + 1}`}</span>
          <NumberField
            value={val}
            unit={cfg.unit}
            ariaLabel={cfg.labels[i] ?? `Item ${i + 1}`}
            onChange={(v) => setItem(i, v)}
          />
        </div>
      ))}
    </div>
  );
}

function ScaleField({
  question: q,
  value,
  onChange,
}: {
  question: QuestionRow;
  value: string;
  onChange: (questionId: string, draft: Draft) => void;
}) {
  const anchors = scaleAnchors(q);
  return (
    <div className="scale-field">
      <div className="scale-segments" role="radiogroup">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            type="button"
            key={n}
            role="radio"
            aria-checked={value === String(n)}
            className={`scale-seg ${value === String(n) ? 'scale-seg-on' : ''}`}
            onClick={() => onChange(q.id, { kind: 'text', text: String(n) })}
          >
            {n}
          </button>
        ))}
      </div>
      <div className="scale-anchors muted">
        <span>1 — {anchors.low}</span>
        <span>5 — {anchors.high}</span>
      </div>
    </div>
  );
}
