import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qk,
  qkContentModuleCatalog,
  qkLibraryTaskCatalog,
  useAdvisoryLibrary,
  useContentModuleCatalog,
  useLibraryTaskCatalog,
  type AdvisoryItemRow,
  type AdvisoryItemType,
  type ContentModuleCatalogRow,
  type LibraryTaskCatalogRow,
} from '../lib/queries';
import {
  Card,
  ConfirmDialog,
  EmptyState,
  ErrorState,
  PageHeader,
  SkeletonLines,
  SubTabs,
  subTabId,
  subTabPanelId,
  useToast,
} from '../components/ui';
import { humanizeKey } from '../lib/format';
import { advisorySevClass } from '../lib/severity';

// The Library is the single home for every ATOMIC, reusable methodology item —
// tasks, education modules, and advisory items. Plans (the /plans surface) group
// these into named bundles; playbooks were retired into this model (docs/37).
// System rows (firm_id null) are shared methodology (read-only, but "Adapt" clones
// an editable firm copy); firm rows (source 'advisor') are the firm's own IP.

const TYPE_LABEL: Record<AdvisoryItemType, string> = {
  buyer_question: 'Buyer question',
  initiative: 'Initiative',
  risk_flag: 'Risk flag',
  education: 'Education',
};
const DIMENSIONS = ['REV', 'FIN', 'OPS', 'CUS', 'MGT', 'GRW'];
const DIMENSION_LABEL: Record<string, string> = {
  REV: 'Revenue Quality',
  FIN: 'Financial Integrity',
  OPS: 'Operational Independence',
  CUS: 'Customer Risk',
  MGT: 'Management and Team',
  GRW: 'Growth Drivers',
};
const dimensionLabel = (code: string) => DIMENSION_LABEL[code] ?? code;
const SEVERITIES = ['critical', 'high', 'med', 'low'];
const OWNER_ROLES = ['owner', 'advisor', 'cpa', 'attorney', 'ops'];

const slug = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'ITEM';
const rand4 = () => Math.random().toString(36).slice(2, 6).toUpperCase();

// ── Tasks ─────────────────────────────────────────────────────────────────────
interface TaskDraft {
  title: string;
  description: string;
  default_owner_role: string;
  dimension_code: string;
  target_offset_days: string;
}
function taskDraftFrom(t?: LibraryTaskCatalogRow | null): TaskDraft {
  return {
    title: t?.title ?? '',
    description: t?.description ?? '',
    default_owner_role: t?.default_owner_role ?? 'advisor',
    dimension_code: t?.dimension_code ?? 'REV',
    target_offset_days: t?.target_offset_days != null ? String(t.target_offset_days) : '',
  };
}

function LibraryTasksSection() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const firmId = profile?.firm_id ?? null;
  const canAuthor = !!firmId;
  const { busy, run } = useAsyncAction();

  const tasksQ = useLibraryTaskCatalog();
  const tasks = tasksQ.data ?? [];
  const [qSource, setQSource] = useState<'all' | 'system' | 'firm'>('all');
  const [qText, setQText] = useState('');
  const [form, setForm] = useState<{ mode: 'create' | 'edit' | 'adapt'; task?: LibraryTaskCatalogRow } | null>(null);
  const [d, setD] = useState<TaskDraft>(taskDraftFrom());
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<LibraryTaskCatalogRow | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: qkLibraryTaskCatalog });
  const setField = <K extends keyof TaskDraft>(k: K, v: TaskDraft[K]) => setD((p) => ({ ...p, [k]: v }));

  const open = (mode: 'create' | 'edit' | 'adapt', task?: LibraryTaskCatalogRow) => {
    setError(null);
    setD(taskDraftFrom(mode === 'create' ? null : task));
    setForm({ mode, task });
  };

  const filtered = useMemo(() => {
    const t = qText.trim().toLowerCase();
    return tasks.filter((p) => {
      const isFirm = p.source === 'advisor';
      return (
        (qSource === 'all' || (qSource === 'firm' ? isFirm : !isFirm)) &&
        (t === '' || p.title.toLowerCase().includes(t) || (p.description ?? '').toLowerCase().includes(t))
      );
    });
  }, [tasks, qSource, qText]);
  const counts = useMemo(() => {
    let system = 0;
    let firm = 0;
    for (const p of tasks) p.source === 'advisor' ? firm++ : system++;
    return { total: tasks.length, system, firm };
  }, [tasks]);

  const save = () =>
    run(
      async () => {
        if (!firmId) throw new Error('No firm.');
        if (!d.title.trim()) throw new Error('A title is required.');
        const row = {
          title: d.title.trim(),
          description: d.description.trim() || null,
          default_owner_role: d.default_owner_role,
          dimension_code: d.dimension_code,
          target_offset_days: d.target_offset_days === '' ? null : Number(d.target_offset_days),
        };
        if (form?.mode === 'edit' && form.task) {
          const { error: e } = await supabase.from('library_tasks').update(row).eq('id', form.task.id);
          if (e) throw new Error(e.message);
        } else {
          const code = `FIRM-LT-${slug(d.title)}-${rand4()}`;
          const { error: e } = await supabase
            .from('library_tasks')
            .insert({ ...row, firm_id: firmId, source: 'advisor', created_by: profile?.id ?? null, code });
          if (e) throw new Error(e.message);
        }
        setForm(null);
        invalidate();
      },
      { success: form?.mode === 'edit' ? 'Task updated' : 'Task saved', onError: setError },
    );

  const remove = (task: LibraryTaskCatalogRow) =>
    run(
      async () => {
        setConfirmDelete(null);
        const { error: e } = await supabase.from('library_tasks').delete().eq('id', task.id);
        if (e) throw new Error(e.message);
        invalidate();
      },
      { success: 'Task removed' },
    );

  return (
    <div className="stack-lg">
      <div className="control-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        <p className="muted m-0">
          Reusable remediation tasks. System tasks are shared methodology; your firm authors its own. Add tasks to a Plan
          on the Plans page.
        </p>
        {canAuthor && (
          <button onClick={() => (form?.mode === 'create' ? setForm(null) : open('create'))} style={{ flexShrink: 0 }}>
            {form?.mode === 'create' ? 'Cancel' : 'Add firm task'}
          </button>
        )}
      </div>

      {form && canAuthor && (
        <Card>
          <form
            className="advisory-form"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="advisory-form-head">
              <h3 className="m-0">
                {form.mode === 'edit' ? 'Edit firm task' : form.mode === 'adapt' ? 'Adapt for your firm' : 'New firm task'}
              </h3>
              {form.mode === 'adapt' && (
                <p className="muted m-0">Saved as your firm's own editable copy — the system task stays untouched.</p>
              )}
            </div>
            <div className="advisory-form-grid">
              <label>
                Readiness area
                <select value={d.dimension_code} onChange={(e) => setField('dimension_code', e.target.value)}>
                  {DIMENSIONS.map((c) => (
                    <option key={c} value={c}>
                      {DIMENSION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Owner
                <select value={d.default_owner_role} onChange={(e) => setField('default_owner_role', e.target.value)}>
                  {OWNER_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {humanizeKey(r)}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Due offset (days)
                <input
                  type="number"
                  value={d.target_offset_days}
                  onChange={(e) => setField('target_offset_days', e.target.value)}
                  placeholder="e.g. 30"
                  min={0}
                />
              </label>
            </div>
            <label>
              Title
              <input value={d.title} onChange={(e) => setField('title', e.target.value)} required />
            </label>
            <label>
              Description (optional)
              <textarea value={d.description} onChange={(e) => setField('description', e.target.value)} rows={2} />
            </label>
            {error && <ErrorState variant="inline" error={error} />}
            <div className="advisory-form-actions">
              <button type="submit" disabled={busy}>
                {busy ? 'Saving…' : form.mode === 'edit' ? 'Save changes' : 'Save task'}
              </button>
              <button type="button" className="button-secondary" onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      <div className="advisory-filters">
        <select value={qSource} onChange={(e) => setQSource(e.target.value as 'all' | 'system' | 'firm')}>
          <option value="all">All sources</option>
          <option value="system">System</option>
          <option value="firm">Firm-authored</option>
        </select>
        <input type="search" placeholder="Search title or description…" value={qText} onChange={(e) => setQText(e.target.value)} />
        <span className="muted advisory-filters-count">
          {filtered.length} of {counts.total} · {counts.system} system, {counts.firm} firm
        </span>
      </div>

      {tasksQ.isLoading && <SkeletonLines lines={6} />}
      {tasksQ.isError && <ErrorState variant="inline" error={tasksQ.error} />}
      {!tasksQ.isLoading && filtered.length === 0 && (
        <EmptyState title="No matching tasks">Adjust the filters, or add a firm task.</EmptyState>
      )}

      {filtered.length > 0 && (
        <Card>
          <div className="advisory-list">
            {filtered.map((p) => {
              const isFirm = p.source === 'advisor';
              return (
                <div key={p.id} className="advisory-item">
                  <div className="advisory-item-head">
                    <div className="advisory-item-titles">
                      <p className="advisory-item-title">
                        {p.title}
                        {isFirm && <span className="advisory-tag advisory-tag-firm">Firm</span>}
                      </p>
                      {p.description && <p className="advisory-item-body">{p.description}</p>}
                      <p className="muted text-sm m-0">
                        {p.dimension_code ? DIMENSION_LABEL[p.dimension_code] ?? p.dimension_code : '—'} ·{' '}
                        {humanizeKey(p.default_owner_role)}
                        {p.target_offset_days != null ? ` · due +${p.target_offset_days}d` : ''}
                      </p>
                    </div>
                  </div>
                  {canAuthor && (
                    <div className="advisory-item-actions">
                      {isFirm ? (
                        <>
                          <button className="linkish" onClick={() => open('edit', p)}>
                            Edit
                          </button>
                          <button className="button-danger-link" onClick={() => setConfirmDelete(p)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button className="linkish" onClick={() => open('adapt', p)}>
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
        title="Remove task?"
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmDelete && remove(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        {confirmDelete && <p>"{confirmDelete.title}" will be removed from your firm's library.</p>}
      </ConfirmDialog>
    </div>
  );
}

// ── Education (content modules) ────────────────────────────────────────────────
function EducationSection() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const firmId = profile?.firm_id ?? null;
  const canAuthor = !!firmId;
  const { busy, run } = useAsyncAction();

  const modulesQ = useContentModuleCatalog();
  const modules = modulesQ.data ?? [];
  const [editing, setEditing] = useState<ContentModuleCatalogRow | 'new' | null>(null);
  const [title, setTitle] = useState('');
  const [dimension, setDimension] = useState('REV');
  const [body, setBody] = useState('');
  const [err, setErr] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: qkContentModuleCatalog });
  const open = (m: ContentModuleCatalogRow | 'new') => {
    setErr(null);
    setEditing(m);
    setTitle(m === 'new' ? '' : m.title);
    setDimension((m === 'new' ? 'REV' : m.dimension_code) ?? 'REV');
    setBody((m === 'new' ? '' : m.body_md) ?? '');
  };

  const save = () =>
    run(
      async () => {
        if (!firmId) throw new Error('No firm.');
        if (!title.trim()) throw new Error('A title is required.');
        const payload = { title: title.trim(), dimension_code: dimension, body_md: body.trim() || null };
        if (editing && editing !== 'new') {
          const { error } = await supabase.from('content_modules').update(payload).eq('id', editing.id);
          if (error) throw new Error(error.message);
        } else {
          const code = `FIRM-CM-${slug(title)}-${rand4()}`;
          const { error } = await supabase
            .from('content_modules')
            .insert({ ...payload, firm_id: firmId, source: 'advisor', created_by: profile?.id ?? null, code });
          if (error) throw new Error(error.message);
        }
        setEditing(null);
        invalidate();
      },
      { success: 'Education module saved', onError: setErr },
    );

  return (
    <div className="stack-lg">
      <div className="control-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        <p className="muted m-0">
          Owner-facing education. System modules are shared methodology; firm modules appear next to them and on the
          owner's Learn tab. Education lives here only.
        </p>
        {canAuthor && (
          <button onClick={() => (editing === 'new' ? setEditing(null) : open('new'))} style={{ flexShrink: 0 }}>
            {editing === 'new' ? 'Cancel' : 'Add firm module'}
          </button>
        )}
      </div>

      {editing && (
        <Card>
          <div className="advisory-form">
            <div className="advisory-form-grid">
              <label>
                Readiness area
                <select value={dimension} onChange={(e) => setDimension(e.target.value)}>
                  {DIMENSIONS.map((c) => (
                    <option key={c} value={c}>
                      {DIMENSION_LABEL[c]}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <label>
              Title
              <input value={title} onChange={(e) => setTitle(e.target.value)} required />
            </label>
            <label>
              Content (optional)
              <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Markdown supported." />
            </label>
            {err && <ErrorState variant="inline" error={err} />}
            <div className="advisory-form-actions">
              <button type="button" onClick={save} disabled={busy}>
                {busy ? 'Saving…' : 'Save module'}
              </button>
              <button type="button" className="button-secondary" onClick={() => setEditing(null)} disabled={busy}>
                Cancel
              </button>
            </div>
          </div>
        </Card>
      )}

      {modulesQ.isLoading && <SkeletonLines lines={4} />}
      {!modulesQ.isLoading && modules.length === 0 && (
        <EmptyState title="No education modules">Add a firm module to start your education catalog.</EmptyState>
      )}
      {modules.length > 0 && (
        <Card>
          <div className="advisory-list">
            {modules.map((m) => {
              const isFirm = m.source === 'advisor';
              return (
                <div key={m.id} className="advisory-item">
                  <div className="advisory-item-head">
                    <div className="advisory-item-titles">
                      <p className="advisory-item-title">
                        {m.title}
                        {isFirm && <span className="advisory-tag advisory-tag-firm">Firm</span>}
                      </p>
                      <p className="muted text-sm m-0">
                        {m.dimension_code ? DIMENSION_LABEL[m.dimension_code] ?? m.dimension_code : '—'}
                      </p>
                    </div>
                  </div>
                  {canAuthor && isFirm && (
                    <div className="advisory-item-actions">
                      <button className="linkish" onClick={() => open(m)}>
                        Edit
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Advisory items (buyer questions / initiatives / risk flags) ─────────────────
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

// Education is authored in its own section now, so the advisory type picker omits it.
const ADVISORY_TYPES: AdvisoryItemType[] = ['buyer_question', 'initiative', 'risk_flag'];

function AdvisoryForm({
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
  const set = <K extends keyof AuthoringValues>(k: K, val: AuthoringValues[K]) => setV((p) => ({ ...p, [k]: val }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSubmit(v);
  };
  const submitLabel = mode === 'edit' ? 'Save changes' : mode === 'adapt' ? 'Save to firm library' : 'Add to library';
  const heading = mode === 'edit' ? 'Edit firm item' : mode === 'adapt' ? 'Adapt for your firm' : 'New firm item';

  return (
    <Card>
      <form className="advisory-form" onSubmit={submit}>
        <div className="advisory-form-head">
          <h3 className="m-0">{heading}</h3>
          {mode === 'adapt' && (
            <p className="muted m-0">Saved as your firm's own copy — the system item stays untouched.</p>
          )}
        </div>
        <div className="advisory-form-grid">
          <label>
            Type
            <select value={v.item_type} onChange={(e) => set('item_type', e.target.value as AdvisoryItemType)}>
              {ADVISORY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Readiness area
            <select value={v.dimension_code} onChange={(e) => set('dimension_code', e.target.value)}>
              {DIMENSIONS.map((dd) => (
                <option key={dd} value={dd}>
                  {dimensionLabel(dd)}
                </option>
              ))}
            </select>
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
        </div>
        <label>
          Title
          <input value={v.title} onChange={(e) => set('title', e.target.value)} required />
        </label>
        <label>
          Body{' '}
          {v.item_type === 'buyer_question' ? '(the question)' : v.item_type === 'risk_flag' ? '(the flag)' : '(the action)'}
          <textarea value={v.body} onChange={(e) => set('body', e.target.value)} rows={2} required />
        </label>
        <label>
          Preparation / framework (optional)
          <textarea value={v.response_framework} onChange={(e) => set('response_framework', e.target.value)} rows={2} />
        </label>
        <label>
          Documentation needed (optional)
          <textarea value={v.data_needed} onChange={(e) => set('data_needed', e.target.value)} rows={2} />
        </label>
        <details className="advisory-form-advanced">
          <summary>Advanced targeting (optional)</summary>
          <p className="muted advisory-form-advanced-help">
            This item surfaces on an engagement when the related score falls to or below the trigger.
          </p>
          <div className="advisory-form-grid">
            <label>
              Sub-score code (optional)
              <input value={v.sub_score_code} onChange={(e) => set('sub_score_code', e.target.value)} placeholder="e.g. OPS-HOURS" />
            </label>
            <label>
              Surfaces at score ≤
              <input type="number" value={v.score_trigger} onChange={(e) => set('score_trigger', e.target.value)} min={0} max={100} />
            </label>
          </div>
        </details>
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

function AdvisorySection() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const libraryQ = useAdvisoryLibrary();
  const items = (libraryQ.data ?? []).filter((i) => i.item_type !== 'education');
  const canAuthor = !!profile?.firm_id;

  const [qType, setQType] = useState<AdvisoryItemType | 'all'>('all');
  const [qDim, setQDim] = useState<string>('all');
  const [qSource, setQSource] = useState<'all' | 'system' | 'advisor'>('all');
  const [qText, setQText] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<AdvisoryItemRow | null>(null);
  const [form, setForm] = useState<{ mode: FormMode; item?: AdvisoryItemRow } | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      const { error: err } = await supabase.from('advisory_library_items').update(payload).eq('id', form.item.id);
      if (err) return setError(err.message);
      toast.show('Advisory item updated', 'good');
    } else {
      const { error: err } = await supabase
        .from('advisory_library_items')
        .insert([{ ...payload, firm_id: profile.firm_id, source: 'advisor', created_by: profile.id }]);
      if (err) return setError(err.message);
      toast.show(form.mode === 'adapt' ? 'Adapted into your firm library' : 'Advisory item added', 'good');
    }
    closeForm();
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
  };

  const toggleActive = async (item: AdvisoryItemRow) => {
    const { error: err } = await supabase.from('advisory_library_items').update({ active: !item.active }).eq('id', item.id);
    if (err) return toast.show(err.message, 'error');
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show(item.active ? 'Item deactivated' : 'Item reactivated', 'good');
  };

  const removeItem = async (item: AdvisoryItemRow) => {
    setConfirmDelete(null);
    const { error: err } = await supabase.from('advisory_library_items').delete().eq('id', item.id);
    if (err) return toast.show(err.message, 'error');
    qc.invalidateQueries({ queryKey: qk.advisoryLibrary() });
    toast.show('Item removed', 'good');
  };

  return (
    <div className="stack-lg">
      <div className="control-row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', gap: 'var(--space-3)' }}>
        <p className="muted m-0">
          Buyer questions, value initiatives, and diligence risk flags. Each fires on an engagement when its DRS trigger
          is met.
        </p>
        {canAuthor && (
          <button onClick={() => (form?.mode === 'create' ? closeForm() : setForm({ mode: 'create' }))} style={{ flexShrink: 0 }}>
            {form?.mode === 'create' ? 'Cancel' : 'Add firm item'}
          </button>
        )}
      </div>

      {form && canAuthor && (
        <AdvisoryForm
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
          {ADVISORY_TYPES.map((t) => (
            <option key={t} value={t}>
              {TYPE_LABEL[t]}
            </option>
          ))}
        </select>
        <select value={qDim} onChange={(e) => setQDim(e.target.value)}>
          <option value="all">All readiness areas</option>
          {DIMENSIONS.map((dd) => (
            <option key={dd} value={dd}>
              {dimensionLabel(dd)}
            </option>
          ))}
        </select>
        <select value={qSource} onChange={(e) => setQSource(e.target.value as 'all' | 'system' | 'advisor')}>
          <option value="all">All sources</option>
          <option value="system">System</option>
          <option value="advisor">Firm-authored</option>
        </select>
        <input type="search" placeholder="Search title or body…" value={qText} onChange={(e) => setQText(e.target.value)} />
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
                          <button className="linkish" onClick={() => { setError(null); setForm({ mode: 'edit', item: it }); }}>
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
                        <button className="linkish" onClick={() => { setError(null); setForm({ mode: 'adapt', item: it }); }} title="Save an editable firm copy">
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

// ── Page ────────────────────────────────────────────────────────────────────────
type LibraryView = 'tasks' | 'education' | 'advisory';

export default function LibraryPage() {
  const [view, setView] = useState<LibraryView>('tasks');

  return (
    <div className="stack-lg">
      <PageHeader
        title="Library"
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Library' }]}
        subtitle="Every reusable methodology item in one place — tasks, education, and advisory items. System content is shared methodology; your firm authors its own. Group these into named bundles on the Plans page."
      />

      <div className="plans-toolbar">
        <SubTabs
          tabs={[
            { key: 'tasks', label: 'Tasks' },
            { key: 'education', label: 'Education' },
            { key: 'advisory', label: 'Advisory' },
          ]}
          activeKey={view}
          ariaLabel="Library sections"
          onSelect={(k) => setView(k as LibraryView)}
        />
      </div>

      <div className="subtabs-panel" role="tabpanel" id={subTabPanelId(view)} aria-labelledby={subTabId(view)} tabIndex={0}>
        {view === 'tasks' && <LibraryTasksSection />}
        {view === 'education' && <EducationSection />}
        {view === 'advisory' && <AdvisorySection />}
      </div>
    </div>
  );
}
