// The pure answer-save loop shared by the advisor intake (src/pages/IntakePage.tsx)
// and the owner/client portal intake (src/pages/owner/OwnerIntakePage.tsx). It does
// only what both surfaces need — upsert the non-empty drafts into `answers` and
// delete answers the user cleared — through the RLS-governed table (no server
// function in the write path). Provenance/ledger bookkeeping stays in IntakePage
// (owners have no answer_provenance write policy), which is why `changed` is
// returned: the advisor path uses it to decide which ledger/document answers were
// hand-edited and should lose their verified provenance.
import { supabase } from './supabase';
import { toAnswerValue, type Draft } from './answerFields';
import type { QuestionRow } from './rubric';

export interface SaveAnswersInput {
  assessmentId: string;
  questions: QuestionRow[];
  drafts: Map<string, Draft>;
  savedByQuestion: Map<string, unknown>;
  answeredBy: string | null;
}

export interface SaveAnswersResult {
  // Question ids whose value changed vs. what was saved (advisor path uses this for
  // provenance downgrade). Owner path ignores it.
  changed: string[];
  // Previously-saved answers the user emptied, now deleted.
  cleared: string[];
}

export async function saveAnswers({
  assessmentId,
  questions,
  drafts,
  savedByQuestion,
  answeredBy,
}: SaveAnswersInput): Promise<SaveAnswersResult> {
  const rows: { assessment_id: string; question_id: string; value: unknown; answered_by: string | null }[] = [];
  const changed: string[] = [];
  const cleared: string[] = [];
  for (const q of questions) {
    const draft = drafts.get(q.id);
    if (!draft) continue;
    const value = toAnswerValue(q, draft);
    if (value === undefined) {
      // Draft present but empty = a field that was saved before and is now cleared;
      // remove the persisted row so the DB matches the emptied UI. An untouched
      // (never-saved) question falls through harmlessly.
      if (savedByQuestion.has(q.id)) cleared.push(q.id);
      continue;
    }
    rows.push({ assessment_id: assessmentId, question_id: q.id, value, answered_by: answeredBy });
    if (JSON.stringify(value) !== JSON.stringify(savedByQuestion.get(q.id))) changed.push(q.id);
  }
  if (rows.length > 0) {
    const { error } = await supabase.from('answers').upsert(rows, { onConflict: 'assessment_id,question_id' });
    if (error) throw new Error(error.message);
  }
  if (cleared.length > 0) {
    const { error } = await supabase.from('answers').delete().eq('assessment_id', assessmentId).in('question_id', cleared);
    if (error) throw new Error(error.message);
  }
  return { changed, cleared };
}
