import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import {
  answersByCode,
  explainFromAnswers,
  loadEngineRubric,
  type Answers,
  type ExplainResult,
  type Rubric,
} from '../lib/scoringClient';

const tierStatus: Record<string, string> = {
  'Institutional Grade': 'good',
  'Sale Ready': 'good',
  'Needs Work': 'warning',
  'High Risk': 'serious',
  'Not Saleable (Yet)': 'critical',
};

const round1 = (x: number) => Math.round(x * 10) / 10;

// A signed delta chip. `goodWhenUp` flips the color meaning for gap counts,
// where fewer is better.
function Delta({ value, goodWhenUp = true }: { value: number; goodWhenUp?: boolean }) {
  const v = round1(value);
  if (v === 0) return <span className="delta delta-flat">no change</span>;
  const up = v > 0;
  const good = up === goodWhenUp;
  return (
    <span className={`delta ${good ? 'delta-up' : 'delta-down'}`}>
      {up ? '▲' : '▼'} {up ? '+' : ''}
      {v}
    </span>
  );
}

export default function WorkbenchPage() {
  const { assessmentId } = useParams();
  const { profile } = useAuth();
  const navigate = useNavigate();

  const [displayRubric, setDisplayRubric] = useState<RubricData | null>(null);
  const [engineRubric, setEngineRubric] = useState<Rubric | null>(null);
  const [drafts, setDrafts] = useState<Map<string, Draft>>(new Map());
  const [baseline, setBaseline] = useState<{ answers: Answers; explain: ExplainResult } | null>(null);
  const [meta, setMeta] = useState<{
    engagementId: string;
    firmId: string;
    company: string;
    sequence: number;
    version: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // question id <-> code, and per-question maps, derived from the display rubric
  const questions = useMemo<QuestionRow[]>(
    () => (displayRubric ? [...displayRubric.questionsByDimension.values()].flat() : []),
    [displayRubric],
  );
  const idToCode = useMemo(() => new Map(questions.map((q) => [q.id, q.code])), [questions]);
  const questionById = useMemo(() => new Map(questions.map((q) => [q.id, q])), [questions]);

  useEffect(() => {
    (async () => {
      try {
        const { data: a, error: aErr } = await supabase
          .from('active_assessments')
          .select('*')
          .eq('id', assessmentId!)
          .single();
        if (aErr) throw new Error(aErr.message);

        const [display, engine, { data: eng }, { data: version }, { data: answerRows }] =
          await Promise.all([
            loadRubric(a.rubric_version_id),
            loadEngineRubric(a.rubric_version_id),
            supabase.from('engagements').select('*').eq('id', a.engagement_id).single(),
            supabase.from('rubric_versions').select('*').eq('id', a.rubric_version_id).single(),
            supabase.from('answers').select('*').eq('assessment_id', assessmentId!),
          ]);
        const { data: company } = await supabase
          .from('companies')
          .select('*')
          .eq('id', eng!.company_id)
          .single();

        // seed drafts from the saved answers (same rules as intake load)
        const byId = new Map<string, unknown>(
          (answerRows ?? []).map((r: { question_id: string; value: unknown }) => [
            r.question_id,
            r.value,
          ]),
        );
        const initial = new Map<string, Draft>();
        for (const qs of display.questionsByDimension.values()) {
          for (const q of qs) {
            if (q.answer_type === 'rank') {
              const saved = byId.get(q.id);
              initial.set(
                q.id,
                Array.isArray(saved)
                  ? { kind: 'rank', order: saved as string[] }
                  : { kind: 'rank', order: (q.options ?? '').split('|').filter(Boolean) },
              );
            } else if (q.answer_type === 'numeric_list') {
              const saved = byId.get(q.id);
              initial.set(q.id, Array.isArray(saved) ? draftFromValue(q, saved) : emptyListDraft(q));
            } else if (byId.has(q.id)) {
              initial.set(q.id, draftFromValue(q, byId.get(q.id)));
            }
          }
        }

        // baseline answers (by code) + baseline explain, computed once
        const idCode = new Map(
          [...display.questionsByDimension.values()].flat().map((q) => [q.id, q.code]),
        );
        const allQuestions = [...display.questionsByDimension.values()].flat();
        const baseById = new Map<string, unknown>();
        for (const [id, draft] of initial) {
          const question = allQuestions.find((x) => x.id === id);
          if (!question) continue;
          try {
            const val = toAnswerValue(question, draft);
            if (val !== undefined) baseById.set(id, val);
          } catch {
            /* ignore parse issues in the saved baseline */
          }
        }
        const baseAnswers = answersByCode(idCode, baseById);

        setDisplayRubric(display);
        setEngineRubric(engine);
        setDrafts(initial);
        setBaseline({ answers: baseAnswers, explain: explainFromAnswers(engine, baseAnswers) });
        setMeta({
          engagementId: a.engagement_id,
          firmId: eng!.firm_id,
          company: company?.name ?? '',
          sequence: a.sequence_number,
          version: version?.version_label ?? '',
        });
        setLoading(false);
      } catch (err) {
        setError((err as Error).message);
        setLoading(false);
      }
    })();
  }, [assessmentId]);

  const setDraft = useCallback((questionId: string, draft: Draft) => {
    setDrafts((prev) => new Map(prev).set(questionId, draft));
  }, []);

  // live answers (by code) recomputed on every edit
  const liveAnswers = useMemo<Answers>(() => {
    const byId = new Map<string, unknown>();
    for (const [id, draft] of drafts) {
      const q = questionById.get(id);
      if (!q) continue;
      try {
        const val = toAnswerValue(q, draft);
        if (val !== undefined) byId.set(id, val);
      } catch {
        /* invalid text — treated as unanswered until fixed */
      }
    }
    return answersByCode(idToCode, byId);
  }, [drafts, questionById, idToCode]);

  // live score; if a scored answer is blank the engine throws — keep the last
  // valid board visible and surface a gentle inline notice instead of crashing.
  const live = useMemo(() => {
    if (!engineRubric) return { explain: null as ExplainResult | null, incomplete: false };
    try {
      return { explain: explainFromAnswers(engineRubric, liveAnswers), incomplete: false };
    } catch {
      return { explain: null, incomplete: true };
    }
  }, [engineRubric, liveAnswers]);
  const lastGood = useRef<ExplainResult | null>(null);
  if (live.explain) lastGood.current = live.explain;
  const board = live.explain ?? lastGood.current;

  const dirty = useMemo(() => {
    if (!baseline) return false;
    return JSON.stringify(liveAnswers) !== JSON.stringify(baseline.answers);
  }, [liveAnswers, baseline]);

  const isAnswered = (q: QuestionRow): boolean => {
    const d = drafts.get(q.id);
    if (!d) return false;
    try {
      return toAnswerValue(q, d) !== undefined;
    } catch {
      return false;
    }
  };

  const resetToSaved = () => {
    if (!displayRubric || !baseline) return;
    // rebuild drafts from baseline answers-by-code
    const codeToVal = baseline.answers;
    const next = new Map<string, Draft>();
    for (const q of questions) {
      const v = codeToVal[q.code];
      if (q.answer_type === 'numeric_list') {
        next.set(q.id, v !== undefined ? draftFromValue(q, v) : emptyListDraft(q));
      } else if (q.answer_type === 'rank') {
        next.set(
          q.id,
          Array.isArray(v)
            ? { kind: 'rank', order: v as unknown as string[] }
            : { kind: 'rank', order: (q.options ?? '').split('|').filter(Boolean) },
        );
      } else if (v !== undefined) {
        next.set(q.id, draftFromValue(q, v));
      }
    }
    setDrafts(next);
  };

  const saveAsNew = async () => {
    if (!meta || !engineRubric) return;
    setError(null);
    setSaving(true);
    try {
      // next sequence over ALL assessments (incl. superseded) for uniqueness
      const { data: last } = await supabase
        .from('assessments')
        .select('sequence_number')
        .eq('engagement_id', meta.engagementId)
        .order('sequence_number', { ascending: false })
        .limit(1);
      const nextSequence = (last?.[0]?.sequence_number ?? 0) + 1;
      const { data: created, error: cErr } = await supabase
        .from('assessments')
        .insert([
          {
            firm_id: meta.firmId,
            engagement_id: meta.engagementId,
            rubric_version_id: (displayRubric as RubricData).rubricVersionId,
            sequence_number: nextSequence,
          },
        ])
        .select()
        .single();
      if (cErr) throw new Error(cErr.message);

      const rows = [];
      for (const q of questions) {
        const draft = drafts.get(q.id);
        if (!draft) continue;
        let value: unknown;
        try {
          value = toAnswerValue(q, draft);
        } catch {
          continue;
        }
        if (value === undefined) continue;
        rows.push({
          assessment_id: created.id,
          question_id: q.id,
          value,
          answered_by: profile?.id ?? null,
        });
      }
      const { error: upErr } = await supabase.from('answers').insert(rows);
      if (upErr) throw new Error(upErr.message);

      await invokeFunction('score-assessment', { assessment_id: created.id });
      navigate(`/assessment/${created.id}/results`);
    } catch (err) {
      setError((err as Error).message);
      setSaving(false);
    }
  };

  if (loading) return <p className="muted">Loading workbench…</p>;
  if (error && !board) return <p className="form-error">{error}</p>;
  if (!displayRubric || !board || !baseline || !meta) return <p className="form-error">Unavailable</p>;

  const base = baseline.explain;
  const gapCodesNow = new Set(board.firedGaps.map((g) => g.code));
  const gapCodesBase = new Set(base.firedGaps.map((g) => g.code));
  const gapsResolved = [...gapCodesBase].filter((c) => !gapCodesNow.has(c)).length;
  const gapsOpened = [...gapCodesNow].filter((c) => !gapCodesBase.has(c)).length;
  const baseDimByCode = new Map(base.dimensions.map((d) => [d.code, d.score]));

  return (
    <div className="workbench">
      <div className="page-title-row">
        <h2>
          {meta.company} <span className="muted">· scenario workbench</span>
        </h2>
        <span className="muted wb-links">
          from assessment #{meta.sequence} · {meta.version}
          {' · '}
          <Link className="button-link" to={`/assessment/${assessmentId}/results`}>
            results →
          </Link>
          {' · '}
          <Link className="button-link" to={`/engagement/${meta.engagementId}`}>
            engagement →
          </Link>
        </span>
      </div>

      <p className="wb-explainer">
        Change any answer and every score updates instantly. Nothing here is saved until you choose{' '}
        <strong>Save as new assessment</strong> — the original assessment #{meta.sequence} stays
        untouched. Use it live with an owner to see what moving each lever would do.
      </p>

      <div className="wb-grid">
        {/* ---------- editable answers ---------- */}
        <div className="wb-answers">
          {displayRubric.dimensions.map((d) => {
            const qs = displayRubric.questionsByDimension.get(d.id) ?? [];
            const liveScore =
              board.dimensions.find((x) => x.code === d.code)?.score ??
              (d.score_group === 'owner_readiness' ? null : 0);
            return (
              <section key={d.id} className="wb-dim" id={`wb-${d.code}`}>
                <div className="wb-dim-head">
                  <h3>
                    <span className="wb-dim-code">{d.code}</span> {d.name}
                  </h3>
                  {liveScore !== null && (
                    <span className="wb-dim-score">
                      {liveScore}
                      {d.score_group !== 'owner_readiness' && (
                        <Delta value={liveScore - (baseDimByCode.get(d.code) ?? liveScore)} />
                      )}
                    </span>
                  )}
                </div>
                {qs.map((q) => (
                  <QuestionControl
                    key={q.id}
                    question={q}
                    draft={drafts.get(q.id)}
                    answered={isAnswered(q)}
                    onChange={setDraft}
                  />
                ))}
              </section>
            );
          })}
        </div>

        {/* ---------- sticky live scoreboard ---------- */}
        <aside className="wb-board">
          <div className="wb-board-inner">
            {live.incomplete && (
              <p className="wb-incomplete">A required answer is blank — showing the last valid score.</p>
            )}

            <div className="wb-score wb-score-hero">
              <span className="wb-score-label">Business readiness</span>
              <span className="wb-score-value">
                {board.drsScore}
                <Delta value={board.drsScore - base.drsScore} />
              </span>
              <span className={`status-chip status-${tierStatus[board.drsTier] ?? 'neutral'}`}>
                {board.drsTier}
              </span>
              {board.drsTier !== base.drsTier && (
                <span className="wb-tier-change muted">was {base.drsTier}</span>
              )}
            </div>

            <div className="wb-score">
              <span className="wb-score-label">Owner readiness</span>
              <span className="wb-score-value wb-score-value-sm">
                {board.oriScore}
                <Delta value={board.oriScore - base.oriScore} />
              </span>
            </div>

            <div className="wb-dims">
              <span className="wb-board-heading">The six business areas</span>
              {board.dimensions.map((d) => {
                const bScore = baseDimByCode.get(d.code) ?? d.score;
                const status =
                  d.score >= 75 ? 'good' : d.score >= 55 ? 'ok' : d.score >= 40 ? 'warning' : 'critical';
                return (
                  <div key={d.code} className="wb-dimrow">
                    <button
                      className="wb-dimrow-name linkish"
                      onClick={() =>
                        document.getElementById(`wb-${d.code}`)?.scrollIntoView({ behavior: 'smooth' })
                      }
                    >
                      {d.name}
                    </button>
                    <span className="wb-dimrow-track">
                      <span
                        className={`wb-dimrow-fill dim-fill-${status}`}
                        style={{ width: `${d.score}%` }}
                      />
                    </span>
                    <span className="wb-dimrow-val">
                      {d.score}
                      <Delta value={d.score - bScore} />
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="wb-gaps">
              <span className="wb-board-heading">
                What buyers would flag <span className="count-pill">{board.firedGaps.length}</span>
              </span>
              {(gapsResolved > 0 || gapsOpened > 0) && (
                <div className="wb-gap-deltas">
                  {gapsResolved > 0 && <span className="delta delta-up">▼ {gapsResolved} resolved</span>}
                  {gapsOpened > 0 && <span className="delta delta-down">▲ {gapsOpened} new</span>}
                </div>
              )}
              {board.firedGaps.length === 0 ? (
                <p className="gap-none">No gaps flagged.</p>
              ) : (
                <ul className="wb-gap-list">
                  {board.firedGaps.map((g) => (
                    <li key={g.code} className={gapCodesBase.has(g.code) ? '' : 'wb-gap-new'}>
                      <span className={`gap-chip gap-${g.severity === 'critical' ? 'critical' : g.severity === 'high' ? 'serious' : g.severity === 'med' ? 'warning' : 'neutral'}`}>
                        {g.severity}
                      </span>
                      <span className="wb-gap-name">{g.name}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            {error && <p className="form-error">{error}</p>}
            <div className="wb-actions">
              <button className="btn-ghost" disabled={!dirty || saving} onClick={resetToSaved}>
                Reset to saved
              </button>
              <button disabled={!dirty || saving || live.incomplete} onClick={saveAsNew}>
                {saving ? 'Saving…' : 'Save as new assessment'}
              </button>
            </div>
            <p className="wb-save-note muted">
              Saving scores a new immutable assessment in this engagement and opens its results.
            </p>
          </div>
        </aside>
      </div>
    </div>
  );
}
