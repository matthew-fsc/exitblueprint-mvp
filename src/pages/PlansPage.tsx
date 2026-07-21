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
  usePlaybooks,
  type PlanItemKind,
  type PlanView,
} from '../lib/queries';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines, useToast } from '../components/ui';

// Plans (docs/37): reusable initiative bundles an advisor curates and applies to
// an engagement. This surface lists system + firm Plans, lets an advisor author a
// firm Plan from the existing catalogs, and applies a Plan to an engagement (PL2/PL3).

const KIND_LABEL: Record<PlanItemKind, string> = {
  playbook: 'Playbook',
  education: 'Education module',
  advisory: 'Advisory item',
  milestone: 'Milestone',
  manual_task: 'Manual task',
};
const TRACKS = ['business', 'personal'] as const;
const OWNER_ROLES = ['owner', 'advisor', 'cpa', 'attorney', 'ops'] as const;

// One row of the authoring item builder — a superset of every kind's fields.
interface DraftItem {
  kind: PlanItemKind;
  ref_id: string; // playbook / content_module / advisory id, per kind
  title: string; // milestone / manual_task
  track: (typeof TRACKS)[number];
  owner_role: (typeof OWNER_ROLES)[number];
}
const emptyItem = (): DraftItem => ({ kind: 'playbook', ref_id: '', title: '', track: 'business', owner_role: 'owner' });

// Map a draft row to the create-plan item payload for its kind.
function toPayloadItem(d: DraftItem): Record<string, unknown> | null {
  switch (d.kind) {
    case 'playbook':
      return d.ref_id ? { kind: 'playbook', playbook_id: d.ref_id } : null;
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
  const playbooksQ = usePlaybooks();
  const contentQ = useContentModules();
  const advisoryQ = useAdvisoryLibrary();
  const canAuthor = !!profile?.firm_id;

  const plans = plansQ.data ?? [];
  const playbooks = useMemo(
    () => Array.from(playbooksQ.data?.entries() ?? []).map(([id, p]) => ({ id, name: p.name })),
    [playbooksQ.data],
  );
  const content = contentQ.data ?? [];
  const advisory = advisoryQ.data ?? [];
  const companyName = useMemo(() => {
    const m = new Map<string, string>();
    for (const c of companiesQ.data ?? []) m.set(c.id, c.name);
    return m;
  }, [companiesQ.data]);

  // Authoring form state.
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [summary, setSummary] = useState('');
  const [items, setItems] = useState<DraftItem[]>([emptyItem()]);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Apply state, keyed by the plan being applied.
  const [applyFor, setApplyFor] = useState<string | null>(null);
  const [applyEngagement, setApplyEngagement] = useState('');
  const [applyAnchor, setApplyAnchor] = useState('');

  const resetForm = () => {
    setName('');
    setSummary('');
    setItems([emptyItem()]);
    setFormError(null);
    setShowForm(false);
  };

  const setItem = (idx: number, patch: Partial<DraftItem>) =>
    setItems((prev) => prev.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const submitCreate = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setFormError('a plan name is required');
      return;
    }
    const payloadItems = items.map(toPayloadItem).filter(Boolean);
    setBusy(true);
    setFormError(null);
    try {
      await invokeFunction('create-plan', {
        name: name.trim(),
        summary: summary.trim() || null,
        status: 'active',
        items: payloadItems,
      });
      toast.show('Plan created', 'good');
      resetForm();
      qc.invalidateQueries({ queryKey: qk.plans() });
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'could not create the plan');
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

  const refOptions = (kind: PlanItemKind) => {
    if (kind === 'playbook') return playbooks.map((p) => ({ id: p.id, label: p.name }));
    if (kind === 'education') return content.map((c) => ({ id: c.id, label: c.title }));
    if (kind === 'advisory') return advisory.map((a) => ({ id: a.id, label: a.title }));
    return [];
  };

  return (
    <div className="stack-lg">
      <PageHeader
        title="Plans"
        crumbs={[{ label: 'Engagements', to: '/' }, { label: 'Plans' }]}
        subtitle="Reusable bundles of playbooks, education, advisory items, milestones, and tasks. System Plans are shared methodology; your firm authors its own. Apply a Plan to an engagement to lay its work onto the roadmap."
        actions={
          canAuthor && (
            <button onClick={() => (showForm ? resetForm() : setShowForm(true))}>
              {showForm ? 'Cancel' : 'New plan'}
            </button>
          )
        }
      />

      {showForm && canAuthor && (
        <Card>
          <form className="advisory-form" onSubmit={submitCreate}>
            <h3 className="m-0">New firm plan</h3>
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
              {items.map((it, i) => (
                <div key={i} className="plan-item-row">
                  <select value={it.kind} onChange={(e) => setItem(i, { kind: e.target.value as PlanItemKind, ref_id: '' })}>
                    {(Object.keys(KIND_LABEL) as PlanItemKind[]).map((k) => (
                      <option key={k} value={k}>
                        {KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                  {(it.kind === 'playbook' || it.kind === 'education' || it.kind === 'advisory') && (
                    <select value={it.ref_id} onChange={(e) => setItem(i, { ref_id: e.target.value })}>
                      <option value="">Select…</option>
                      {refOptions(it.kind).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.label}
                        </option>
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
                          {t}
                        </option>
                      ))}
                    </select>
                  )}
                  {it.kind === 'manual_task' && (
                    <select value={it.owner_role} onChange={(e) => setItem(i, { owner_role: e.target.value as (typeof OWNER_ROLES)[number] })}>
                      {OWNER_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {r}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    type="button"
                    className="button-danger-link"
                    onClick={() => setItems((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))}
                    aria-label="Remove item"
                  >
                    Remove
                  </button>
                </div>
              ))}
              <button type="button" className="button-secondary" onClick={() => setItems((prev) => [...prev, emptyItem()])}>
                Add item
              </button>
            </div>

            {formError && <ErrorState variant="inline" error={formError} />}
            <div className="advisory-form-actions">
              <button type="submit" disabled={busy}>
                {busy ? 'Creating…' : 'Create plan'}
              </button>
              <button type="button" className="button-secondary" onClick={resetForm}>
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
                  <PlanItemSummary plan={plan} />
                </div>
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
  );
}
