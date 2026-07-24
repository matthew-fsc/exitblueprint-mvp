// Shared answer-entry controls used by both the assessment intake and the
// scenario workbench, so the two never drift. A question is edited as a Draft
// (editable strings/arrays); toAnswerValue() converts a Draft to the jsonb the
// engine consumes (docs/02 answers.value) — number | number[] | option string |
// 1-5 | "unknown". Presentation (units, option labels, list rows, scale
// anchors) comes from intakeFields.ts and is keyed by the stable question code.
import type { QuestionRow } from './rubric';
import {
  fieldUnit,
  humanizeOption,
  listConfig,
  scaleAnchors,
  useOptionCards,
  type FieldUnit,
} from './intakeFields';

export type Draft =
  | { kind: 'text'; text: string }
  | { kind: 'unknown' }
  | { kind: 'rank'; order: string[] }
  | { kind: 'list'; items: string[] };

export function draftFromValue(q: QuestionRow, value: unknown): Draft {
  if (q.answer_type === 'rank' && Array.isArray(value)) return { kind: 'rank', order: value as string[] };
  if (q.answer_type === 'numeric_list' && Array.isArray(value)) {
    return { kind: 'list', items: (value as number[]).map(String) };
  }
  if (value === 'unknown' && q.answer_type === 'numeric_or_unknown') return { kind: 'unknown' };
  return { kind: 'text', text: value === null || value === undefined ? '' : String(value) };
}

export function emptyListDraft(q: QuestionRow): Draft {
  return { kind: 'list', items: listConfig(q).labels.map(() => '') };
}

export function toAnswerValue(q: QuestionRow, draft: Draft): unknown | undefined {
  if (draft.kind === 'unknown') return 'unknown';
  if (draft.kind === 'rank') return draft.order;
  if (draft.kind === 'list') {
    const nums: number[] = [];
    for (const raw of draft.items) {
      const t = raw.trim();
      if (t === '') continue; // trailing/blank rows are simply omitted
      const n = Number(t);
      if (Number.isNaN(n)) throw new Error(`${q.prompt}: please enter numbers only`);
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
      if (Number.isNaN(n)) throw new Error(`${q.prompt}: please enter a number`);
      return n;
    }
    case 'scale_1_5':
      return Number(text);
    default:
      return text;
  }
}

/* ---------- field pieces ---------- */

export function formatDollars(raw: string): string | null {
  const t = raw.trim();
  if (t === '') return null;
  const n = Number(t);
  if (Number.isNaN(n)) return null;
  return `$${n.toLocaleString('en-US')}`;
}

export function NumberField({
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
          min={0}
          inputMode="decimal"
          disabled={disabled}
          aria-label={ariaLabel}
          placeholder={unit.placeholder ?? ''}
          value={value}
          // No intake figure is meaningfully negative (revenue, percentages,
          // counts, hours). Strip a leading minus so a negative can't be typed;
          // the engine also rejects negatives on scored answers as a backstop.
          onChange={(e) => onChange(e.target.value.replace(/^-/, ''))}
        />
        {unit.suffix && <span className="numfield-affix numfield-suffix">{unit.suffix}</span>}
      </div>
      {dollarsHint && <span className="numfield-hint muted">{dollarsHint}</span>}
    </div>
  );
}

export function QuestionControl({
  question: q,
  draft,
  answered,
  onChange,
  source,
}: {
  question: QuestionRow;
  draft: Draft | undefined;
  answered: boolean;
  onChange: (questionId: string, draft: Draft) => void;
  source?: string;
}) {
  const text = draft?.kind === 'text' ? draft.text : '';
  const options = (q.options ?? '').split('|').filter(Boolean);
  const unit = fieldUnit(q);
  const fromLedger = source === 'connected_ledger';
  const fromDocument = source === 'document';

  return (
    <div
      className={`question ${answered ? 'question-answered' : ''}`}
      data-qcode={q.code}
      data-qtype={q.answer_type}
    >
      <label className="question-prompt">
        {q.prompt}
        {!q.scored && <span className="context-badge">optional context</span>}
        {fromLedger && <span className="ledger-badge" title="Imported from your connected accounting">✓ from QuickBooks</span>}
        {fromDocument && (
          <span className="ledger-badge" title="Verified from an uploaded financial statement">
            ✓ from financials
          </span>
        )}
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
                {humanizeOption(o, q.code)}
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
                {humanizeOption(o, q.code)}
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
              <span className="rank-label">{humanizeOption(item, q.code)}</span>
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
          placeholder="Optional: add context for the report"
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
        <span>1: {anchors.low}</span>
        <span>5: {anchors.high}</span>
      </div>
    </div>
  );
}
