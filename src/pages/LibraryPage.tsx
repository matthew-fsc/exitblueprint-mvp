import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import {
  qk,
  useAdvisoryLibrary,
  type AdvisoryItemRow,
  type AdvisoryItemType,
} from '../lib/queries';
import { Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, SkeletonLines, useToast } from '../components/ui';
import { advisorySevClass } from '../lib/severity';

const TYPE_LABEL: Record<AdvisoryItemType, string> = {
  buyer_question: 'Buyer question',
  initiative: 'Initiative',
  risk_flag: 'Risk flag',
  education: 'Education',
};
const DIMENSIONS = ['REV', 'FIN', 'OPS', 'CUS', 'MGT', 'GRW'];
const SEVERITIES = ['critical', 'high', 'med', 'low'];

// The authoring form's field state. Kept as strings for the controlled inputs;
// the page maps it to a DB row on submit. One shape serves create, edit, and
// "adapt a system item into a firm copy".
interface AuthoringValues {
  item_type: AdvisoryItemType;
  title: string;
  body: string;
  response_framework: string;
  data_needed: string;
  dimension_code: string;
  sub_score_code: string;
  severity: string;
  score_trigger: string;
}

function valuesFrom(item?: AdvisoryItemRow | null): AuthoringValues {
  return {
    item_type: item?.item_type ?? 'buyer_question',
    title: item?.title ?? '',
    body: item?.body ?? '',
    response_framework: item?.response_framework ?? '',
    data_needed: item?.data_needed ?? '',
    dimension_code: item?.dimension_code ?? 'REV',
    sub_score_code: item?.sub_score_code ?? '',
    severity: item?.severity ?? 'high',
    score_trigger: item?.score_trigger != null ? String(item.score_trigger) : '70',
  };
}

type FormMode = 'create' | 'edit' | 'adapt';

// The authoring form. Seeds its own state once from `initial` (the page remounts
// it with a fresh key when the target changes), so create / edit / adapt all
// reuse one form without effect-syncing.
function AuthoringForm({
  mode,
  initial,
  error,
  onSubmit,
  onCancel,
}: {
  mode: FormMode;
  initial: AuthoringValues;
  error: string | null;
  onSubmit: (v: AuthoringValues) => void;
  onCancel: () => void;
}) {
  const [v, setV] = useState<AuthoringValues>(() => initial);
  const set = <K extends keyof AuthoringValues>(k: K, val: AuthoringValues[K]) =>
    setV((p) => ({ ...p, [k]: val }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v);
  };
  const submitLabel = mode === 'edit' ? 'Save changes' : mode === 'adapt' ? 'Save to firm library' : 'Add to library';
  const heading =
    mode === 'edit' ? 'Edit firm item' : mode === 'adapt' ? 'Adapt for your firm' : 'New firm item';

  return (
    <Card>
      <form className="advisory-form" onSubmit={submit}>
        <div className="advisory-form-head">
          <h3 className="m-0">{heading}</h3>
          {mode === 'adapt' && (
            <p className="muted m-0">
              Saved as your firm's own copy — the system item stays untouched. Edit anything below to
              make it yours.
            </p>
          )}
        </div>
        <div className="advisory-form-grid">
          <label>
            Type
            <select value={v.item_type} onChange={(e) => set('item_type', e.target.value as AdvisoryItemType)}>
              {(Object.keys(TYPE_LABEL) as AdvisoryItemType[]).map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Dimension
            <select value={v.dimension_code} onChange={(e) => set('dimension_code', e.target.value)}>
              {DIMENSIONS.map((d) => (
                <option key={d} value={d}>
                  {d}
                </option>
              ))}
            </select>
          </label>
          <label>
            Sub-score code (optional)
            <input
              value={v.sub_score_code}
              onChange={(e) => set('sub_score_code', e.target.value)}
              placeholder="e.g. OPS-HOURS"
            />
          </label>
          <label>
            Severity
            <select value={v.severity} onChange={(e) => set('severity', e.target.value)}>
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </label>
          <label>
            Fires at score ≤
            <input
              type="number"
              value={v.score_trigger}
              onChange={(e) => set('score_trigger', e.target.value)}
              min={0}
              max={100}
            />
          </label>
        </div>
        <label>
          Title
          <input value={v.title} onChange={(e) => set('title', e.target.value)} required />
        </label>
        <label>
          Body{' '}
          {v.item_type === 'buyer_question'
            ? '(the question)'
            : v.item_type === 'risk_flag'
              ? '(the flag)'
              : '(the action)'}
          <textarea value={v.body} onChange={(e) => set('body', e.target.value)} rows={2} required />
        </label>
        <label>
          Preparation / framework (optional)
          <textarea
            value={v.response_framework}
            onChange={(e) => set('response_framework', e.target.value)}
            rows={2}
          />
        </label>
        <label>
          Documentation needed (optional)
          <textarea value={v.data_needed} onChange={(e) => set('data_needed', e.target.value)} rows={2} />
        </label>
        {error && <ErrorState variant="inline" error={error} />}
        <div className="advisory-form-actions">
          <button type="submit">{submitLabel}</button>
          <button type="button" className="button-secondary" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

export default function LibraryPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const libraryQ = useAdvisoryLibrary();
  const items = libraryQ.data ?? [];
  const canAuthor = !!profile?.firm_id;

  const [qType, setQType] = useState<AdvisoryItemType | 'all'>('all');
  const [qDim, setQDim] = useState<string>('all');
  const [qSource, setQSource] = useState<'all' | 'system' | 'advisor'>('all');
  const [qText, setQText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AdvisoryItemRow | null>(null);

  // A single open authoring form drives create / edit / adapt. `item` is the row
  // being edited (edit) or copied (adapt); absent for a fresh create.
  const [form, setForm] = useState<{ mode: FormMode; item?: AdvisoryItemRow } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const openCreate = () => {
    setError(null);
    setForm((f) => (f?.mode === 'create' ? null : { mode: 'create' }));
  };
  const openEdit = (item: AdvisoryItemRow) => {
    setError(null);
    setForm({ mode: 'edit', item });
  };
  const openAdapt = (item: AdvisoryItemRow) => {
    setError(null);
    setForm({ mode: 'adapt', item });
  };
  const closeForm = () => {
    setForm(null);
    setError(null);
  };

  const filtered = useMemo(() => {
    const t = qText.trim().toLowerCase();
    return items.filter(
      (i) =>
        (qType === 'all' || i.item_type === qType) &&
        (qDim === 'all' || i.dimension_code === qDim) &&
        (qSource === 'all' || i.source === qSource) &&
        (t === '' ||
          i.title.toLowerCase().includes(t) ||
          i.body.toLowerCase().includes(t) ||
          (i.code ?? '').toLowerCase().includes(t)),
    );
  }, [items, qType, qDim, qSource, qText]);

  const counts = useMemo(() => {
    const c = { total: items.length, system: 0, firm: 0 };
    for (const i of items) i.source === 'system' ? c.system++ : c.firm++;
    return c;
  }, [items]);

  const submitForm = async (values: AuthoringValues) => {
    if (!form || !profile?.firm_id || !values.title || !values.body) return;
    setError(null);
    const payload = {
      item_type: values.item_type,
      title: values.title,
      body: values.body,
      response_framework: values.response_framework || null,
      data_needed: values.data_needed || null,
      dimension_code: values.dimension_code,
      sub_score_code: values.sub_score_code || null,
      severity: values.severity,
      score_trigger: values.score_trigger === '' ? null : Number(values.score_trigger),
    };
    if (form.mode === 'edit' && form.item) {
      const { error: err } = await supabase
        .from('advisory_library_items')
        .update(payload)
        .eq('id', form.item.id);
      if (err) {
        setError(err.message);
        return;
      }
      toast.show('Advisory item updated', 'good');
    } else {
      const { error: err } = await supabase.from('advisory_library_items').insert([
        { ...payload, firm_id: profile.firm_id, source: 'advisor', created_by: profile.id },
      ]);
      if (err) {
        setError(err.message);
        return;
      }
      toast.show(form.mode === 'adapt' ? 'Adapted into your firm library' : 'Advisory item added', 'good');
    }
    closeForm();
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
  };

  const toggleActive = async (item: AdvisoryItemRow) => {
    const { error: err } = await supabase
      .from('advisory_library_items')
      .update({ active: !item.active })
      .eq('id', item.id);
    if (err) {
      toast.show(err.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show(item.active ? 'Item deactivated' : 'Item reactivated', 'good');
  };

  const removeItem = async (item: AdvisoryItemRow) => {
    setConfirmDelete(null);
    const { error: err } = await supabase.from('advisory_library_items').delete().eq('id', item.id);
    if (err) {
      toast.show(err.message, 'error');
      return;
    }
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show('Item removed', 'good');
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Advisory library"
        crumbs={[{ label: 'Portfolio', to: '/' }, { label: 'Advisory library' }]}
        subtitle="The catalog of buyer questions, value initiatives, and diligence risk flags. System items are shared methodology; your firm authors and maintains its own. Each item fires on an engagement when its DRS trigger is met."
        actions={
          canAuthor && (
            <button onClick={openCreate}>{form?.mode === 'create' ? 'Cancel' : 'Add firm item'}</button>
          )
        }
      />

      {form && canAuthor && (
        <AuthoringForm
          key={`${form.mode}-${form.item?.id ?? 'new'}`}
          mode={form.mode}
          initial={valuesFrom(form.mode === 'create' ? null : form.item)}
          error={error}
          onSubmit={submitForm}
          onCancel={closeForm}
        />
      )}

      <div className="advisory-filters">
        <select value={qType} onChange={(e) => setQType(e.target.value as AdvisoryItemType | 'all')}>
          <option value="all">All types</option>
          {(Object.keys(TYPE_LABEL) as AdvisoryItemType[]).map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={qDim} onChange={(e) => setQDim(e.target.value)}>
          <option value="all">All dimensions</option>
          {DIMENSIONS.map((d) => (
            <option key={d} value={d}>
              {d}
            </option>
          ))}
        </select>
        <select value={qSource} onChange={(e) => setQSource(e.target.value as 'all' | 'system' | 'advisor')}>
          <option value="all">All sources</option>
          <option value="system">System</option>
          <option value="advisor">Firm-authored</option>
        </select>
        <input
          type="search"
          placeholder="Search title or body…"
          value={qText}
          onChange={(e) => setQText(e.target.value)}
        />
        <span className="muted advisory-filters-count">
          {filtered.length} of {counts.total} · {counts.system} system, {counts.firm} firm
        </span>
      </div>

      {libraryQ.isLoading && <SkeletonLines lines={6} />}
      {libraryQ.isError && <ErrorState variant="inline" error={libraryQ.error} />}

      {!libraryQ.isLoading && filtered.length === 0 && (
        <EmptyState title="No matching items">Adjust the filters, or add a firm-specific item.</EmptyState>
      )}

      {filtered.length > 0 && (
        <Card>
          <div className="advisory-list">
            {filtered.map((it) => {
              const isFirm = it.source === 'advisor';
              return (
                <div
                  key={it.id}
                  className={`advisory-item ${advisorySevClass(it.severity)}${it.active ? '' : ' advisory-item-inactive'}`}
                >
                  <div className="advisory-item-head">
                    <span className={`sev-chip ${advisorySevClass(it.severity)}`}>{it.severity ?? 'note'}</span>
                    <div className="advisory-item-titles">
                      <p className="advisory-item-title">
                        {it.title}
                        <span className="advisory-tag">{TYPE_LABEL[it.item_type]}</span>
                        {isFirm && <span className="advisory-tag advisory-tag-firm">Firm</span>}
                        {!it.active && <span className="advisory-tag advisory-tag-inactive">Inactive</span>}
                      </p>
                      <p className="advisory-item-body">{it.body}</p>
                    </div>
                    <span className="advisory-item-score muted">
                      {it.sub_score_code ?? it.dimension_code ?? '—'}
                      {it.score_trigger != null ? ` ≤ ${it.score_trigger}` : ''}
                    </span>
                  </div>
                  {(it.response_framework || it.data_needed) && (
                    <div className="advisory-item-detail">
                      {it.response_framework && (
                        <div>
                          <span className="advisory-detail-label">Preparation</span>
                          <p>{it.response_framework}</p>
                        </div>
                      )}
                      {it.data_needed && (
                        <div>
                          <span className="advisory-detail-label">Documentation needed</span>
                          <p>{it.data_needed}</p>
                        </div>
                      )}
                    </div>
                  )}
                  {canAuthor && (
                    <div className="advisory-item-actions">
                      {isFirm ? (
                        <>
                          <button className="linkish" onClick={() => openEdit(it)}>
                            Edit
                          </button>
                          <button className="linkish" onClick={() => toggleActive(it)}>
                            {it.active ? 'Deactivate' : 'Reactivate'}
                          </button>
                          <button className="button-danger-link" onClick={() => setConfirmDelete(it)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button className="linkish" onClick={() => openAdapt(it)} title="Save an editable firm copy">
                          Adapt for our firm
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove advisory item?"
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmDelete && removeItem(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        {confirmDelete && <p>"{confirmDelete.title}" will be removed from your firm's library.</p>}
      </ConfirmDialog>
    </div>
  );
}
