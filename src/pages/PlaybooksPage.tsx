import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { supabase } from '../lib/supabase';
import { useAsyncAction } from '../lib/useAsyncAction';
import {
  qkContentModuleCatalog,
  qkPlaybookCatalog,
  useContentModuleCatalog,
  usePlaybookCatalog,
  type ContentModuleCatalogRow,
  type PlaybookCatalogRow,
  type PlaybookTaskTemplateRow,
} from '../lib/queries';
import { Card, ConfirmDialog, EmptyState, ErrorState, PageHeader, SkeletonLines } from '../components/ui';

// Firm-authorable playbooks + content modules. System rows are shared
// methodology (read-only, but one-click "Adapt" clones an editable firm copy);
// firm rows are the firm's own IP. This mirrors the Advisory Library authoring
// surface (LibraryPage) and feeds the same catalog the Plan builder reads.

const DIMENSION_LABEL: Record<string, string> = {
  REV: 'Revenue Quality',
  FIN: 'Financial Integrity',
  OPS: 'Operational Independence',
  CUS: 'Customer Risk',
  MGT: 'Management and Team',
  GRW: 'Growth Drivers',
};
const DIMENSIONS = Object.keys(DIMENSION_LABEL);
const OWNER_ROLES = ['owner', 'advisor', 'cpa', 'attorney', 'ops'];

const slug = (s: string) =>
  s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'PLAYBOOK';
// Short suffix so two firm playbooks with similar names don't collide on code.
const rand4 = () => Math.random().toString(36).slice(2, 6).toUpperCase();

interface TaskDraft {
  title: string;
  description: string;
  default_owner_role: string;
  target_offset_days: string;
}
interface PlaybookDraft {
  name: string;
  phase: string;
  dimension_code: string;
  ev_impact: string;
  summary: string;
  body_md: string;
  tasks: TaskDraft[];
}

function taskFrom(t?: PlaybookTaskTemplateRow): TaskDraft {
  return {
    title: t?.title ?? '',
    description: t?.description ?? '',
    default_owner_role: t?.default_owner_role ?? 'advisor',
    target_offset_days: t?.target_offset_days != null ? String(t.target_offset_days) : '',
  };
}
function draftFrom(pb?: PlaybookCatalogRow | null): PlaybookDraft {
  return {
    name: pb?.name ?? '',
    phase: pb?.phase ?? '',
    dimension_code: pb?.dimension_code ?? 'REV',
    ev_impact: pb?.ev_impact ?? '',
    summary: pb?.summary ?? '',
    body_md: pb?.body_md ?? '',
    tasks: pb?.tasks?.length ? pb.tasks.map(taskFrom) : [taskFrom()],
  };
}

type Mode = 'create' | 'edit' | 'adapt';

function PlaybookForm({
  mode,
  initial,
  error,
  busy,
  onSubmit,
  onCancel,
}: {
  mode: Mode;
  initial: PlaybookDraft;
  error: string | null;
  busy: boolean;
  onSubmit: (d: PlaybookDraft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState<PlaybookDraft>(() => initial);
  const set = <K extends keyof PlaybookDraft>(k: K, v: PlaybookDraft[K]) => setD((p) => ({ ...p, [k]: v }));
  const setTask = (i: number, k: keyof TaskDraft, v: string) =>
    setD((p) => ({ ...p, tasks: p.tasks.map((t, idx) => (idx === i ? { ...t, [k]: v } : t)) }));
  const addTask = () => setD((p) => ({ ...p, tasks: [...p.tasks, taskFrom()] }));
  const removeTask = (i: number) => setD((p) => ({ ...p, tasks: p.tasks.filter((_, idx) => idx !== i) }));

  const heading = mode === 'edit' ? 'Edit firm playbook' : mode === 'adapt' ? 'Adapt for your firm' : 'New firm playbook';
  const submitLabel = mode === 'edit' ? 'Save changes' : mode === 'adapt' ? 'Save to firm playbooks' : 'Add playbook';

  return (
    <Card>
      <form
        className="advisory-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(d);
        }}
      >
        <div className="advisory-form-head">
          <h3 className="m-0">{heading}</h3>
          {mode === 'adapt' && (
            <p className="muted m-0">Saved as your firm's own editable copy — the system playbook stays untouched.</p>
          )}
        </div>
        <div className="advisory-form-grid">
          <label>
            Readiness area
            <select value={d.dimension_code} onChange={(e) => set('dimension_code', e.target.value)}>
              {DIMENSIONS.map((c) => (
                <option key={c} value={c}>
                  {DIMENSION_LABEL[c]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Phase (optional)
            <input value={d.phase} onChange={(e) => set('phase', e.target.value)} placeholder="e.g. Stabilize" />
          </label>
          <label>
            EV impact (optional)
            <input value={d.ev_impact} onChange={(e) => set('ev_impact', e.target.value)} placeholder="e.g. High" />
          </label>
        </div>
        <label>
          Name
          <input value={d.name} onChange={(e) => set('name', e.target.value)} required />
        </label>
        <label>
          Summary (optional)
          <textarea value={d.summary} onChange={(e) => set('summary', e.target.value)} rows={2} />
        </label>
        <label>
          Playbook detail (optional)
          <textarea
            value={d.body_md}
            onChange={(e) => set('body_md', e.target.value)}
            rows={4}
            placeholder="The how-to an advisor and owner follow. Markdown supported."
          />
        </label>

        <div className="playbook-tasks">
          <div className="control-row" style={{ justifyContent: 'space-between' }}>
            <span className="stat-block-label">Task steps</span>
            <button type="button" className="linkish" onClick={addTask}>
              Add step
            </button>
          </div>
          {d.tasks.map((t, i) => (
            <div key={i} className="playbook-task-row">
              <span className="playbook-task-seq muted">{i + 1}</span>
              <div className="playbook-task-fields">
                <input
                  value={t.title}
                  onChange={(e) => setTask(i, 'title', e.target.value)}
                  placeholder="Step title"
                  aria-label={`Step ${i + 1} title`}
                />
                <textarea
                  value={t.description}
                  onChange={(e) => setTask(i, 'description', e.target.value)}
                  rows={1}
                  placeholder="What to do (optional)"
                  aria-label={`Step ${i + 1} description`}
                />
                <div className="playbook-task-meta">
                  <label>
                    Owner
                    <select value={t.default_owner_role} onChange={(e) => setTask(i, 'default_owner_role', e.target.value)}>
                      {OWNER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Due offset (days)
                    <input
                      type="number"
                      value={t.target_offset_days}
                      onChange={(e) => setTask(i, 'target_offset_days', e.target.value)}
                      placeholder="e.g. 30"
                      min={0}
                    />
                  </label>
                  {d.tasks.length > 1 && (
                    <button type="button" className="button-danger-link" onClick={() => removeTask(i)}>
                      Remove
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        {error && <ErrorState variant="inline" error={error} />}
        <div className="advisory-form-actions">
          <button type="submit" disabled={busy}>
            {busy ? 'Saving…' : submitLabel}
          </button>
          <button type="button" className="button-secondary" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
        </div>
      </form>
    </Card>
  );
}

export default function PlaybooksPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const firmId = profile?.firm_id ?? null;
  const canAuthor = !!firmId;
  const { busy, run } = useAsyncAction();

  const pbQ = usePlaybookCatalog();
  const cmQ = useContentModuleCatalog();
  const playbooks = pbQ.data ?? [];

  const [qSource, setQSource] = useState<'all' | 'system' | 'firm'>('all');
  const [qText, setQText] = useState('');
  const [form, setForm] = useState<{ mode: Mode; pb?: PlaybookCatalogRow } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<PlaybookCatalogRow | null>(null);

  const invalidatePb = () => qc.invalidateQueries({ queryKey: qkPlaybookCatalog });

  const filtered = useMemo(() => {
    const t = qText.trim().toLowerCase();
    return playbooks.filter((p) => {
      const isFirm = p.source === 'advisor';
      return (
        (qSource === 'all' || (qSource === 'firm' ? isFirm : !isFirm)) &&
        (t === '' || p.name.toLowerCase().includes(t) || (p.summary ?? '').toLowerCase().includes(t))
      );
    });
  }, [playbooks, qSource, qText]);

  const counts = useMemo(() => {
    let system = 0;
    let firm = 0;
    for (const p of playbooks) p.source === 'advisor' ? firm++ : system++;
    return { total: playbooks.length, system, firm };
  }, [playbooks]);

  const openCreate = () => {
    setError(null);
    setForm((f) => (f?.mode === 'create' ? null : { mode: 'create' }));
  };

  // Write a playbook draft: upsert the header, then replace its task templates.
  const savePlaybook = (mode: Mode, draft: PlaybookDraft, existing?: PlaybookCatalogRow) =>
    run(
      async () => {
        if (!firmId) throw new Error('No firm.');
        if (!draft.name.trim()) throw new Error('A name is required.');
        const header = {
          name: draft.name.trim(),
          summary: draft.summary.trim() || null,
          dimension_code: draft.dimension_code,
          phase: draft.phase.trim() || null,
          ev_impact: draft.ev_impact.trim() || null,
          body_md: draft.body_md.trim() || null,
        };
        let playbookId: string;
        if (mode === 'edit' && existing) {
          const { error: e } = await supabase.from('playbooks').update(header).eq('id', existing.id);
          if (e) throw new Error(e.message);
          playbookId = existing.id;
          const { error: de } = await supabase.from('playbook_task_templates').delete().eq('playbook_id', playbookId);
          if (de) throw new Error(de.message);
        } else {
          // create or adapt — a fresh firm-owned row. Reuse the system code on
          // adapt (firm code namespace is separate); generate one on create.
          const code = mode === 'adapt' && existing ? existing.code : `FIRM-${slug(draft.name)}-${rand4()}`;
          const { data, error: e } = await supabase
            .from('playbooks')
            .insert({
              ...header,
              firm_id: firmId,
              source: 'advisor',
              created_by: profile?.id ?? null,
              code,
              version: 1,
            })
            .select('id')
            .single();
          if (e) throw new Error(e.message);
          playbookId = (data as { id: string }).id;
        }
        const rows = draft.tasks
          .map((t, i) => ({
            playbook_id: playbookId,
            firm_id: firmId,
            title: t.title.trim(),
            description: t.description.trim() || null,
            default_owner_role: t.default_owner_role,
            sequence: i + 1,
            target_offset_days: t.target_offset_days === '' ? null : Number(t.target_offset_days),
          }))
          .filter((r) => r.title);
        if (rows.length) {
          const { error: te } = await supabase.from('playbook_task_templates').insert(rows);
          if (te) throw new Error(te.message);
        }
        setForm(null);
        invalidatePb();
      },
      {
        success:
          mode === 'edit' ? 'Playbook updated' : mode === 'adapt' ? 'Adapted into your firm playbooks' : 'Playbook added',
        onError: setError,
      },
    );

  const deletePlaybook = (pb: PlaybookCatalogRow) =>
    run(
      async () => {
        setConfirmDelete(null);
        const { error: de } = await supabase.from('playbook_task_templates').delete().eq('playbook_id', pb.id);
        if (de) throw new Error(de.message);
        const { error: e } = await supabase.from('playbooks').delete().eq('id', pb.id);
        if (e) throw new Error(e.message);
        invalidatePb();
      },
      { success: 'Playbook removed' },
    );

  return (
    <div className="stack-lg">
      <PageHeader
        title="Playbooks"
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Playbooks' }]}
        subtitle="Remediation playbooks and their task steps. System playbooks are shared methodology; your firm authors and maintains its own, and firm playbooks appear in the Plan builder alongside them."
        actions={
          canAuthor && (
            <button onClick={openCreate}>{form?.mode === 'create' ? 'Cancel' : 'Add firm playbook'}</button>
          )
        }
      />

      {form && canAuthor && (
        <PlaybookForm
          key={`${form.mode}-${form.pb?.id ?? 'new'}`}
          mode={form.mode}
          initial={draftFrom(form.mode === 'create' ? null : form.pb)}
          error={error}
          busy={busy}
          onSubmit={(d) => savePlaybook(form.mode, d, form.pb)}
          onCancel={() => {
            setForm(null);
            setError(null);
          }}
        />
      )}

      <div className="advisory-filters">
        <select value={qSource} onChange={(e) => setQSource(e.target.value as 'all' | 'system' | 'firm')}>
          <option value="all">All sources</option>
          <option value="system">System</option>
          <option value="firm">Firm-authored</option>
        </select>
        <input type="search" placeholder="Search name or summary…" value={qText} onChange={(e) => setQText(e.target.value)} />
        <span className="muted advisory-filters-count">
          {filtered.length} of {counts.total} · {counts.system} system, {counts.firm} firm
        </span>
      </div>

      {pbQ.isLoading && <SkeletonLines lines={6} />}
      {pbQ.isError && <ErrorState variant="inline" error={pbQ.error} />}
      {!pbQ.isLoading && filtered.length === 0 && (
        <EmptyState title="No matching playbooks">Adjust the filters, or add a firm playbook.</EmptyState>
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
                        {p.name}
                        {p.phase && <span className="advisory-tag">{p.phase}</span>}
                        {isFirm && <span className="advisory-tag advisory-tag-firm">Firm</span>}
                      </p>
                      {p.summary && <p className="advisory-item-body">{p.summary}</p>}
                      <p className="muted text-sm m-0">
                        {p.dimension_code ? DIMENSION_LABEL[p.dimension_code] ?? p.dimension_code : '—'} ·{' '}
                        {p.tasks.length} {p.tasks.length === 1 ? 'step' : 'steps'}
                      </p>
                    </div>
                  </div>
                  {p.tasks.length > 0 && (
                    <ol className="playbook-step-list">
                      {p.tasks.map((t) => (
                        <li key={t.id}>
                          <span>{t.title}</span>
                          <span className="muted text-sm"> · {t.default_owner_role}</span>
                        </li>
                      ))}
                    </ol>
                  )}
                  {canAuthor && (
                    <div className="advisory-item-actions">
                      {isFirm ? (
                        <>
                          <button className="linkish" onClick={() => { setError(null); setForm({ mode: 'edit', pb: p }); }}>
                            Edit
                          </button>
                          <button className="button-danger-link" onClick={() => setConfirmDelete(p)}>
                            Remove
                          </button>
                        </>
                      ) : (
                        <button className="linkish" onClick={() => { setError(null); setForm({ mode: 'adapt', pb: p }); }}>
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

      <ContentModulesSection query={cmQ} firmId={firmId} profileId={profile?.id ?? null} run={run} busy={busy} qc={qc} />

      <ConfirmDialog
        open={confirmDelete !== null}
        title="Remove playbook?"
        confirmLabel="Remove"
        danger
        onConfirm={() => confirmDelete && deletePlaybook(confirmDelete)}
        onCancel={() => setConfirmDelete(null)}
      >
        {confirmDelete && <p>"{confirmDelete.name}" and its steps will be removed from your firm's playbooks.</p>}
      </ConfirmDialog>
    </div>
  );
}

// ── Content modules (education) ───────────────────────────────────────────────
function ContentModulesSection({
  query,
  firmId,
  profileId,
  run,
  busy,
  qc,
}: {
  query: ReturnType<typeof useContentModuleCatalog>;
  firmId: string | null;
  profileId: string | null;
  run: ReturnType<typeof useAsyncAction>['run'];
  busy: boolean;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const modules = query.data ?? [];
  const canAuthor = !!firmId;
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
            .insert({ ...payload, firm_id: firmId, source: 'advisor', created_by: profileId, code });
          if (error) throw new Error(error.message);
        }
        setEditing(null);
        invalidate();
      },
      { success: 'Education module saved', onError: setErr },
    );

  return (
    <Card>
      <div className="control-row" style={{ justifyContent: 'space-between', marginBottom: 'var(--space-3)' }}>
        <div>
          <h3 className="m-0">Education modules</h3>
          <p className="muted text-sm m-0">Owner-facing education. Firm modules appear in the Plan builder next to system ones.</p>
        </div>
        {canAuthor && (
          <button onClick={() => open('new')} disabled={busy}>
            Add firm module
          </button>
        )}
      </div>

      {editing && (
        <div className="advisory-form" style={{ marginBottom: 'var(--space-3)' }}>
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
      )}

      {query.isLoading && <SkeletonLines lines={3} />}
      {!query.isLoading && modules.length === 0 && (
        <EmptyState title="No education modules">Add a firm module to start your education catalog.</EmptyState>
      )}
      {modules.length > 0 && (
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
      )}
    </Card>
  );
}
