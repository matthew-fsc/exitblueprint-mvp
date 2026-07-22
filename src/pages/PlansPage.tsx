import { useMemo, useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction } from '../lib/supabase';
import {
  qk,
  useAdvisoryLibrary,
  useCompanies,
  useContentModules,
  useEngagements,
  usePlans,
  useLibraryTasks,
  type PlanItemKind,
  type PlanItemView,
  type PlanView,
} from '../lib/queries';
import {
  Card,
  EmptyState,
  ErrorState,
  GapSeverityChip,
  PageHeader,
  SectionCard,
  SkeletonLines,
  useToast,
} from '../components/ui';
import { humanizeKey } from '../lib/format';

// Plans (docs/37): reusable initiative bundles an advisor curates and applies to
// an engagement. This surface lists system + firm Plans, lets an advisor author a
// firm Plan from the existing catalogs, and applies a Plan to an engagement (PL2/PL3).

const KIND_LABEL: Record<PlanItemKind, string> = {
  task: 'Library task',
  education: 'Education module',
  advisory: 'Advisory item',
  milestone: 'Milestone',
  manual_task: 'Manual task',
};
// What each item kind contributes to an engagement when the Plan is applied.
// Shown inline so the 5-kind selector is never unexplained (docs/37).
const KIND_HINT: Record<PlanItemKind, string> = {
  task: 'Adds a reusable library task to the roadmap when applied.',
  education: 'Assigns a learning module from the education catalog.',
  advisory: 'Surfaces a coaching / advisory item for the owner.',
  milestone: 'Adds a target-dated milestone on the chosen track.',
  manual_task: 'Adds a one-off task owned by the chosen role.',
};
const TRACKS = ['business', 'personal'] as const;
const OWNER_ROLES = ['owner', 'advisor', 'cpa', 'attorney', 'ops'] as const;

// An annotated catalog option for the ref picker: the label plus the methodology
// metadata that already lives on each table (dimension / severity / description).
interface RefOption {
  id: string;
  label: string;
  dimension: string | null;
  severity: string | null;
  description: string | null;
}

// Group ref options by dimension for <optgroup>; undimensioned items last.
function groupByDimension(opts: RefOption[]): { key: string; label: string; options: RefOption[] }[] {
  const groups = new Map<string, RefOption[]>();
  for (const o of opts) {
    const key = o.dimension ?? '__none';
    const bucket = groups.get(key);
    if (bucket) bucket.push(o);
    else groups.set(key, [o]);
  }
  return Array.from(groups.entries())
    .sort(([a], [b]) => (a === '__none' ? 1 : b === '__none' ? -1 : a.localeCompare(b)))
    .map(([key, options]) => ({ key, label: key === '__none' ? 'General' : humanizeKey(key), options }));
}

const truncate = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n).trimEnd()}…` : s);

// One row of the authoring item builder — a superset of every kind's fields.
interface DraftItem {
  kind: PlanItemKind;
  ref_id: string; // playbook / content_module / advisory id, per kind
  title: string; // milestone / manual_task
  track: (typeof TRACKS)[number];
  owner_role: (typeof OWNER_ROLES)[number];
}
const emptyItem = (): DraftItem => ({ kind: 'task', ref_id: '', title: '', track: 'business', owner_role: 'owner' });

// Inverse of toPayloadItem: seed an editable draft row from a stored plan item so
// an existing Plan can be re-opened in the authoring form (edit mode).
function toDraftItem(it: PlanItemView): DraftItem {
  return {
    kind: it.item_kind,
    ref_id: it.library_task_id ?? it.content_module_id ?? it.advisory_library_item_id ?? '',
    title: it.title ?? '',
    track: (TRACKS as readonly string[]).includes(it.track ?? '') ? (it.track as DraftItem['track']) : 'business',
    owner_role: (OWNER_ROLES as readonly string[]).includes(it.owner_role ?? '')
      ? (it.owner_role as DraftItem['owner_role'])
      : 'owner',
  };
}

// Map a draft row to the create-plan item payload for its kind.
function toPayloadItem(d: DraftItem): Record<string, unknown> | null {
  switch (d.kind) {
    case 'task':
      return d.ref_id ? { kind: 'task', library_task_id: d.ref_id } : null;
    case 'education':
      return d.ref_id ? { kind: 'education', content_module_id: d.ref_id } : null;
    case 'advisory':
      return d.ref_id ? { kind: 'advisory', advisory_library_item_id: d.ref_id } : null;
    case 'milestone':
      return d.title.trim() ? { kind: 'milestone', title: d.title.trim(), track: d.track } : null;
    case 'manual_task':
      return d.title.trim() ? { kind: 'manual_task', title: d.title.trim(), owner_role: d.owner_role } : null;
    default:
      return null;
  }
}

function PlanItemSummary({ plan }: { plan: PlanView }) {
  const counts = useMemo(() => {
    const c: Partial<Record<PlanItemKind, number>> = {};
    for (const it of plan.items) c[it.item_kind] = (c[it.item_kind] ?? 0) + 1;
    return c;
  }, [plan.items]);
  const parts = (Object.keys(KIND_LABEL) as PlanItemKind[])
    .filter((k) => counts[k])
    .map((k) => `${counts[k]} ${counts[k] === 1 ? KIND_LABEL[k].toLowerCase() : KIND_LABEL[k].toLowerCase() + 's'}`);
  return <span className="muted">{parts.length ? parts.join(' · ') : 'no items'}</span>;
}

export default function PlansPage() {
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();
  const plansQ = usePlans();
  const engagementsQ = useEngagements();
  const companiesQ = useCompanies();
  const libraryTasksQ = useLibraryTasks();
  const contentQ = useContentModules();
  const advisoryQ = useAdvisoryLibrary();
  const canAuthor = !!profile?.firm_id;

  const plans = plansQ.data ?? [];
  const libraryTasks = useMemo(
    () =>
      Array.from(libraryTasksQ.data?.entries() ?? []).map(([id, t]) => ({
        id,
        name: t.title,
        dimension: t.dimension_code,
        description: null as string | null,
      })),
    [libraryTasksQ.data],
  );
  const content = contentQ.data ?? [];
  const advisory = advisoryQ.data ?? [];
  const companyName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companiesQ.data ?? []) m.set(c.id, c.name);
    return m;
  }, [companiesQ.data]);

  // Authoring form state. `form` is null when closed, else create- or edit-mode
  // (edit carries the source Plan). The field state below is shared by both modes.
  const [form, setForm] = useState<{ mode: 'create' | 'edit'; plan?: PlanView } | null>(null);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [status, setStatus] = useState<'active' | 'draft'>('active');
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Which plan's item list is expanded (view what's inside a Plan).
  const [expandedFor, setExpandedFor] = useState<string | null>(null);

  // Apply state, keyed by the plan being applied.
  const [applyFor, setApplyFor] = useState<string | null>(null);
  const [applyEngagement, setApplyEngagement] = useState('');
  const [applyAnchor, setApplyAnchor] = useState('');

  const closeForm = () => {
    setName('');
    setSummary('');
    setItems([emptyItem()]);
    setStatus('active');
    setFormError(null);
    setForm(null);
  };

  const openCreate = () => {
    setName('');
    setSummary('');
    setItems([emptyItem()]);
    setStatus('active');
    setFormError(null);
    setApplyFor(null);
    setForm({ mode: 'create' });
  };

  // Seed the shared form state from an existing Plan and open it in edit mode.
  const openEdit = (plan: PlanView) => {
    setName(plan.name);
    setSummary(plan.summary ?? '');
    setItems(plan.items.length ? plan.items.map(toDraftItem) : [emptyItem()]);
    setStatus(plan.status === 'active' ? 'active' : 'draft');
    setFormError(null);
    setApplyFor(null);
    setForm({ mode: 'edit', plan });
  };

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const submitForm = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    if (!name.trim()) {
      setFormError('a plan name is required');
      return;
    }
    // Never silently drop a row the advisor built: block on incomplete rows and
    // name exactly which ones need finishing or removing.
    const incomplete = items.map((d, i) => (toPayloadItem(d) ? null : i + 1)).filter((n): n is number => n != null);
    if (incomplete.length > 0) {
      setFormError(
        `Finish or remove ${incomplete.length === 1 ? 'the incomplete item' : 'these incomplete items'}: ` +
          `row ${incomplete.join(', ')}. Pick a catalog item or give the milestone/task a title.`,
      );
      return;
    }
    const payloadItems = items.map(toPayloadItem).filter(Boolean);
    setBusy(true);
    setFormError(null);
    try {
      if (form.mode === 'edit' && form.plan) {
        // update-plan edits a draft in place; an active Plan is immutable, so the
        // server mints a new version and retires the current one (server/plans.ts).
        await invokeFunction('update-plan', {
          id: form.plan.id,
          name: name.trim(),
          summary: summary.trim() || null,
          status,
          items: payloadItems,
        });
        toast.show(
          form.plan.status === 'active'
            ? `Saved as version ${form.plan.plan_version + 1}`
            : status === 'active'
              ? 'Plan updated and activated'
              : 'Draft plan updated',
          'good',
        );
      } else {
        await invokeFunction('create-plan', {
          name: name.trim(),
          summary: summary.trim() || null,
          status,
          items: payloadItems,
        });
        toast.show(status === 'draft' ? 'Draft plan saved' : 'Plan created', 'good');
      }
      closeForm();
      qc.invalidateQueries({ queryKey: qk.plans() });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'could not save the plan');
    } finally {
      setBusy(false);
    }
  };

  const submitApply = async (plan: PlanView) => {
    if (!applyEngagement) {
      toast.show('Pick an engagement first', 'error');
      return;
    }
    setBusy(true);
    try {
      const res = await invokeFunction<{ tasks_created: number; tasks_claimed: number; milestones_created: number }>(
        'apply-plan',
        {
          engagement_id: applyEngagement,
          plan_template_id: plan.id,
          anchor_date: applyAnchor || null,
        },
      );
      const { tasks_created, tasks_claimed, milestones_created } = res;
      toast.show(
        `Applied "${plan.name}" — ${tasks_created} task${tasks_created === 1 ? '' : 's'} added` +
          (tasks_claimed ? `, ${tasks_claimed} linked` : '') +
          (milestones_created ? `, ${milestones_created} milestone${milestones_created === 1 ? '' : 's'}` : ''),
        'good',
      );
      setApplyFor(null);
      setApplyEngagement('');
      setApplyAnchor('');
      qc.invalidateQueries({ queryKey: qk.tasks(applyEngagement) });
      qc.invalidateQueries({ queryKey: qk.milestones(applyEngagement) });
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'could not apply the plan', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Annotated catalog options per kind, carrying the metadata each table already
  // exposes (playbook/content: dimension + summary; advisory: dimension + severity + body).
  const refOptions = (kind: PlanItemKind): RefOption[] => {
    if (kind === 'task')
      return libraryTasks.map((p) => ({ id: p.id, label: p.name, dimension: p.dimension, severity: null, description: p.description }));
    if (kind === 'education')
      return content.map((c) => ({ id: c.id, label: c.title, dimension: c.dimension_code, severity: null, description: null }));
    if (kind === 'advisory')
      return advisory.map((a) => ({ id: a.id, label: a.title, dimension: a.dimension_code, severity: a.severity, description: a.body }));
    return [];
  };
  const findOption = (kind: PlanItemKind, id: string): RefOption | undefined =>
    id ? refOptions(kind).find((o) => o.id === id) : undefined;

  // Resolve a stored plan item to a readable line for the "what's inside" view.
  // Ref kinds resolve their label/metadata through the loaded catalogs; milestone
  // and manual_task carry their content inline.
  const describeItem = (
    it: PlanItemView,
  ): { label: string; dimension: string | null; severity: string | null; meta: string | null } => {
    if (it.item_kind === 'milestone')
      return { label: it.title ?? '(untitled milestone)', dimension: null, severity: null, meta: it.track };
    if (it.item_kind === 'manual_task')
      return { label: it.title ?? '(untitled task)', dimension: null, severity: null, meta: it.owner_role };
    const refId = it.library_task_id ?? it.content_module_id ?? it.advisory_library_item_id ?? '';
    const opt = findOption(it.item_kind, refId);
    return { label: opt?.label ?? 'Unknown item', dimension: opt?.dimension ?? null, severity: opt?.severity ?? null, meta: null };
  };

  // Resolve a draft row to a readable preview line (null when still incomplete).
  const resolvePreview = (
    d: DraftItem,
  ): { kind: PlanItemKind; label: string; dimension: string | null; severity: string | null; meta: string | null } | null => {
    if (!toPayloadItem(d)) return null;
    if (d.kind === 'milestone') return { kind: d.kind, label: d.title.trim(), dimension: null, severity: null, meta: d.track };
    if (d.kind === 'manual_task') return { kind: d.kind, label: d.title.trim(), dimension: null, severity: null, meta: d.owner_role };
    const opt = findOption(d.kind, d.ref_id);
    if (!opt) return null;
    return { kind: d.kind, label: opt.label, dimension: opt.dimension, severity: opt.severity, meta: null };
  };
  const previewItems = items.map(resolvePreview).filter((p): p is NonNullable<typeof p> => p != null);
  const incompleteCount = items.filter((d) => !toPayloadItem(d)).length;

  return (
    <div className="stack-lg">
      <PageHeader
        title="Plans"
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Plans' }]}
        subtitle="Reusable bundles of library tasks, education, advisory items, and milestones. System content is shared methodology; your firm authors its own. Apply a Plan to an engagement to lay its work onto the roadmap. Author the individual items in the Library."
        actions={
          canAuthor && (
            <button onClick={() => (form ? closeForm() : openCreate())}>
              {form ? 'Cancel' : 'New plan'}
            </button>
          )
        }
      />

      {(
          <div className="stack-lg">
            {form && canAuthor && (
        <Card>
          <form className="advisory-form" onSubmit={submitForm}>
            <h3 className="m-0">
              {form.mode === 'edit' ? `Edit plan — ${form.plan?.name}` : 'New firm plan'}
            </h3>
            {form.mode === 'edit' && form.plan?.status === 'active' && (
              <p className="muted text-xs m-0">
                This plan is active. Saving creates version {form.plan.plan_version + 1} and retires the current
                version — engagements you’ve already applied it to keep their pinned version.
              </p>
            )}
            <label>
              Name
              <input value={name} onChange={(e) => setName(e.target.value)} required />
            </label>
            <label>
              Summary (optional)
              <textarea value={summary} onChange={(e) => setSummary(e.target.value)} rows={2} />
            </label>

            <div className="plans-items">
              <span className="advisory-detail-label">Items</span>
              {items.map((it, i) => {
                const isRef = it.kind === 'task' || it.kind === 'education' || it.kind === 'advisory';
                const selected = isRef ? findOption(it.kind, it.ref_id) : undefined;
                const complete = !!toPayloadItem(it);
                return (
                  <div key={i} className="plans-items">
                    <div className="plan-item-row">
                      <select value={it.kind} onChange={(e) => setItem(i, { kind: e.target.value as PlanItemKind, ref_id: '' })}>
                        {(Object.keys(KIND_LABEL) as PlanItemKind[]).map((k) => (
                          <option key={k} value={k}>
                            {KIND_LABEL[k]}
                          </option>
                        ))}
                      </select>
                      {isRef && (
                        <select value={it.ref_id} onChange={(e) => setItem(i, { ref_id: e.target.value })}>
                          <option value="">Select {KIND_LABEL[it.kind].toLowerCase()}…</option>
                          {groupByDimension(refOptions(it.kind)).map((g) => (
                            <optgroup key={g.key} label={g.label}>
                              {g.options.map((o) => (
                                <option key={o.id} value={o.id}>
                                  {o.severity ? `${o.label} — ${humanizeKey(o.severity)}` : o.label}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      )}
                      {(it.kind === 'milestone' || it.kind === 'manual_task') && (
                        <input
                          placeholder={it.kind === 'milestone' ? 'Milestone title' : 'Task title'}
                          value={it.title}
                          onChange={(e) => setItem(i, { title: e.target.value })}
                        />
                      )}
                      {it.kind === 'milestone' && (
                        <select value={it.track} onChange={(e) => setItem(i, { track: e.target.value as (typeof TRACKS)[number] })}>
                          {TRACKS.map((t) => (
                            <option key={t} value={t}>
                              {humanizeKey(t)}
                            </option>
                          ))}
                        </select>
                      )}
                      {it.kind === 'manual_task' && (
                        <select value={it.owner_role} onChange={(e) => setItem(i, { owner_role: e.target.value as (typeof OWNER_ROLES)[number] })}>
                          {OWNER_ROLES.map((r) => (
                            <option key={r} value={r}>
                              {humanizeKey(r)}
                            </option>
                          ))}
                        </select>
                      )}
                      {!complete && <span className="advisory-tag advisory-tag-inactive">Incomplete</span>}
                      <button
                        type="button"
                        className="button-danger-link"
                        onClick={() => setItems((prev) => prev.filter((_, j) => j !== i))}
                        aria-label="Remove item"
                      >
                        Remove
                      </button>
                    </div>
                    <span className="muted text-xs">
                      {KIND_HINT[it.kind]}
                      {selected?.dimension && <span className="advisory-tag">{humanizeKey(selected.dimension)}</span>}
                      {selected?.severity && <GapSeverityChip severity={selected.severity} />}
                      {selected?.description && ` ${truncate(selected.description)}`}
                    </span>
                  </div>
                );
              })}
              <button type="button" className="button-secondary" onClick={() => setItems((prev) => [...prev, emptyItem()])}>
                Add item
              </button>
            </div>

            {items.length > 0 && (
              <SectionCard
                title="Plan preview"
                subtitle={
                  incompleteCount > 0
                    ? `${previewItems.length} item${previewItems.length === 1 ? '' : 's'} ready · ${incompleteCount} incomplete row${incompleteCount === 1 ? '' : 's'} to finish or remove`
                    : `${previewItems.length} item${previewItems.length === 1 ? '' : 's'} — what this plan lays onto the roadmap`
                }
              >
                {previewItems.length === 0 ? (
                  <p className="muted m-0">Pick catalog items or add a milestone/task to see the plan take shape.</p>
                ) : (
                  <div className="plans-items">
                    {previewItems.map((p, i) => (
                      <div key={i} className="plan-item-row">
                        <span className="advisory-tag">{KIND_LABEL[p.kind]}</span>
                        <strong>{p.label}</strong>
                        {p.dimension && <span className="advisory-tag">{humanizeKey(p.dimension)}</span>}
                        {p.severity && <GapSeverityChip severity={p.severity} />}
                        {p.meta && <span className="muted text-xs">{humanizeKey(p.meta)}</span>}
                      </div>
                    ))}
                  </div>
                )}
              </SectionCard>
            )}

            {formError && <ErrorState variant="inline" error={formError} />}
            <div className="advisory-form-actions">
              {/* Editing an active plan always mints a new active version — no status
                  choice there. Creating or editing a draft can pick draft vs active. */}
              {!(form.mode === 'edit' && form.plan?.status === 'active') && (
                <label>
                  Save as
                  <select value={status} onChange={(e) => setStatus(e.target.value as 'active' | 'draft')}>
                    <option value="active">Active — visible to apply now</option>
                    <option value="draft">Draft — keep authoring, not yet applicable</option>
                  </select>
                </label>
              )}
              <button type="submit" disabled={busy}>
                {busy
                  ? 'Saving…'
                  : form.mode === 'edit'
                    ? form.plan?.status === 'active'
                      ? 'Save new version'
                      : status === 'active'
                        ? 'Activate plan'
                        : 'Save changes'
                    : status === 'draft'
                      ? 'Save draft'
                      : 'Create plan'}
              </button>
              <button type="button" className="button-secondary" onClick={closeForm}>
                Cancel
              </button>
            </div>
          </form>
        </Card>
      )}

      {plansQ.isLoading && <SkeletonLines lines={6} />}
      {plansQ.isError && <ErrorState variant="inline" error={plansQ.error} />}
      {!plansQ.isLoading && plans.length === 0 && (
        <EmptyState title="No plans yet">
          {canAuthor ? 'Create your first firm plan, or apply a system plan to an engagement.' : 'No plans available.'}
        </EmptyState>
      )}

      {plans.length > 0 && (
        <div className="plans-list">
          {plans.map((plan) => (
            <Card key={plan.id}>
              <div className="plans-card-head">
                <div>
                  <p className="advisory-item-title">
                    {plan.name}
                    <span className="advisory-tag">v{plan.plan_version}</span>
                    {plan.is_system ? (
                      <span className="advisory-tag">System</span>
                    ) : (
                      <span className="advisory-tag advisory-tag-firm">Firm</span>
                    )}
                    {plan.status !== 'active' && <span className="advisory-tag advisory-tag-inactive">{plan.status}</span>}
                  </p>
                  {plan.summary && <p className="advisory-item-body">{plan.summary}</p>}
                  <div className="plan-item-row">
                    <PlanItemSummary plan={plan} />
                    {plan.items.length > 0 && (
                      <button
                        type="button"
                        className="linkish"
                        onClick={() => setExpandedFor(expandedFor === plan.id ? null : plan.id)}
                        aria-expanded={expandedFor === plan.id}
                      >
                        {expandedFor === plan.id ? 'Hide items' : 'View items'}
                      </button>
                    )}
                  </div>
                </div>
                <div className="plans-card-actions">
                  {canAuthor && !plan.is_system && (
                    <button className="button-secondary" onClick={() => openEdit(plan)}>
                      Edit
                    </button>
                  )}
                  <button
                    className="button-secondary"
                    onClick={() => {
                      setApplyFor(applyFor === plan.id ? null : plan.id);
                      setApplyEngagement('');
                      setApplyAnchor('');
                    }}
                  >
                    {applyFor === plan.id ? 'Cancel' : 'Apply to engagement'}
                  </button>
                </div>
              </div>

              {expandedFor === plan.id && (
                <div className="plan-items-detail plans-items">
                  <span className="advisory-detail-label">In this plan</span>
                  {plan.items.map((it) => {
                    const d = describeItem(it);
                    return (
                      <div key={it.id} className="plan-item-row">
                        <span className="advisory-tag">{KIND_LABEL[it.item_kind]}</span>
                        <strong>{d.label}</strong>
                        {d.dimension && <span className="advisory-tag">{humanizeKey(d.dimension)}</span>}
                        {d.severity && <GapSeverityChip severity={d.severity} />}
                        {d.meta && <span className="muted text-xs">{humanizeKey(d.meta)}</span>}
                      </div>
                    );
                  })}
                </div>
              )}

              {applyFor === plan.id && (
                <div className="plan-apply-row">
                  <label>
                    Engagement
                    <select value={applyEngagement} onChange={(e) => setApplyEngagement(e.target.value)}>
                      <option value="">Select…</option>
                      {(engagementsQ.data ?? []).map((e) => (
                        <option key={e.id} value={e.id}>
                          {companyName.get(e.company_id) ?? e.id.slice(0, 8)}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Anchor date (optional)
                    <input type="date" value={applyAnchor} onChange={(e) => setApplyAnchor(e.target.value)} />
                  </label>
                  <button disabled={busy || !applyEngagement} onClick={() => submitApply(plan)}>
                    {busy ? 'Applying…' : 'Apply'}
                  </button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
          </div>
      )}
    </div>
  );
}
