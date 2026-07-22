import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  qk,
  useCompany,
  useEngagement,
  useEngagementPlans,
  useMilestones,
  usePlans,
  useRecommendedPlans,
  useTasks,
  type EngagementPlanProgressRow,
  type GenerateRoadmapResult,
  type MilestoneRow,
  type TaskRow,
} from '../lib/queries';
import {
  Card,
  EmptyState,
  EngagementNav,
  ErrorState,
  GanttChart,
  PageHeader,
  SectionCard,
  SkeletonLines,
  useToast,
  type GanttItem,
} from '../components/ui';
import { fmtDate, humanizeKey } from '../lib/format';
import { engagementCrumbs } from '../lib/nav';

// The bucket key for tasks/milestones not tied to a live applied Plan — the
// gap-derived and manual work that isn't grouped under a Plan.
const UNPLANNED = '__unplanned';
const ROLE_ORDER = ['owner', 'advisor', 'cpa', 'attorney', 'ops'];
const ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  advisor: 'Advisor',
  cpa: 'CPA / accountant',
  attorney: 'Attorney',
  ops: 'Operations',
};
const ORDER_UNSET = Number.MAX_SAFE_INTEGER;

// A roadmap group: one applied Plan and the execution rows tagged to it, or the
// gap-driven/unplanned bucket (plan === null).
interface RoadmapGroup {
  key: string;
  plan: EngagementPlanProgressRow | null;
  tasks: TaskRow[];
  milestones: MilestoneRow[];
}

export default function RoadmapPage() {
  const { engagementId } = useParams();
  const { profile } = useAuth();
  const qc = useQueryClient();
  const toast = useToast();

  const engagementQ = useEngagement(engagementId);
  const engagement = engagementQ.data ?? null;
  const companyQ = useCompany(engagement?.company_id);
  const tasksQ = useTasks(engagementId);
  const milestonesQ = useMilestones(engagementId);
  const appliedPlansQ = useEngagementPlans(engagementId);
  const recommendedPlansQ = useRecommendedPlans(engagementId);
  const plansQ = usePlans();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan is laid out forward from this date; defaults to today so the
  // timeline never opens in the past. Shared by "build from gaps" and "add plan".
  const [anchor, setAnchor] = useState<string>(() => new Date().toISOString().slice(0, 10));
  const [planToAdd, setPlanToAdd] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  // milestone form
  const [mTitle, setMTitle] = useState('');
  const [mTrack, setMTrack] = useState<'business' | 'personal'>('personal');
  const [mDate, setMDate] = useState('');

  // manual-task form — for catching the system up to an engagement already in flight
  const [tTitle, setTTitle] = useState('');
  const [tRole, setTRole] = useState<TaskRow['owner_role']>('advisor');
  const [tDate, setTDate] = useState('');

  const tasks = tasksQ.data ?? [];
  const milestones = milestonesQ.data ?? [];
  const appliedPlans = useMemo(() => appliedPlansQ.data ?? [], [appliedPlansQ.data]);
  const startDate = anchor;
  // The owner's real sale-date target, set here (like the start date) and shared
  // with the exit-pace chart on the Overview so both run to the same deadline.
  const targetDate = engagement?.target_close_date ?? '';

  // Applied Plan by its engagement_plans.id — the key tasks/milestones carry.
  const appliedById = useMemo(() => {
    const m = new Map<string, EngagementPlanProgressRow>();
    for (const p of appliedPlans) m.set(p.id, p);
    return m;
  }, [appliedPlans]);

  // A row belongs to a Plan group only when its plan is still live (not removed);
  // rows tagged to a since-removed Plan fall back to the unplanned bucket.
  const groupKeyFor = (planId: string | null) =>
    planId && appliedById.has(planId) ? planId : UNPLANNED;

  // Build the plan-grouped board: applied Plans first (in apply order, so empty
  // ones still show as a home for their milestones/education), unplanned last.
  const groups = useMemo<RoadmapGroup[]>(() => {
    const byKey = new Map<string, RoadmapGroup>();
    const ensure = (key: string): RoadmapGroup => {
      let g = byKey.get(key);
      if (!g) {
        g = { key, plan: key === UNPLANNED ? null : appliedById.get(key) ?? null, tasks: [], milestones: [] };
        byKey.set(key, g);
      }
      return g;
    };
    for (const p of appliedPlans) ensure(p.id);
    for (const t of tasks) ensure(groupKeyFor(t.engagement_plan_id)).tasks.push(t);
    for (const m of milestones) ensure(groupKeyFor(m.engagement_plan_id)).milestones.push(m);
    const ordered: RoadmapGroup[] = [];
    for (const p of appliedPlans) {
      const g = byKey.get(p.id);
      if (g) ordered.push(g);
    }
    const unplanned = byKey.get(UNPLANNED);
    if (unplanned && (unplanned.tasks.length > 0 || unplanned.milestones.length > 0)) ordered.push(unplanned);
    return ordered;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [appliedPlans, tasks, milestones, appliedById]);

  // Plans available to add directly (active, not already on this roadmap).
  const availablePlans = useMemo(() => {
    const applied = new Set(appliedPlans.map((p) => p.plan_template_id));
    return (plansQ.data ?? []).filter((p) => p.status === 'active' && !applied.has(p.id));
  }, [plansQ.data, appliedPlans]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
    qc.invalidateQueries({ queryKey: qk.milestones(engagementId!) });
  };
  const invalidatePlans = () => {
    qc.invalidateQueries({ queryKey: ['engagementPlans', engagementId] });
    qc.invalidateQueries({ queryKey: ['recommendedPlans', engagementId] });
  };

  const saveTargetDate = async (v: string) => {
    if (!engagementId) return;
    await supabase.from('engagements').update({ target_close_date: v || null }).eq('id', engagementId);
    qc.invalidateQueries({ queryKey: qk.engagement(engagementId) });
  };

  // Open tasks in advisor-controlled order within a group. A manually-set
  // display_order wins; tasks without one (a freshly generated plan) fall to the
  // back in due-date order, so the list reads sensibly until an advisor reorders.
  const openOrdered = (list: TaskRow[]) =>
    [...list.filter((t) => t.status !== 'done')].sort(
      (a, b) =>
        (a.display_order ?? ORDER_UNSET) - (b.display_order ?? ORDER_UNSET) ||
        (a.due_date ?? '').localeCompare(b.due_date ?? '') ||
        (a.sequence ?? 0) - (b.sequence ?? 0),
    );

  // Move an open task one slot up/down within its group and persist the new
  // order. Ordering lives in its OWN column (display_order), not `sequence` —
  // sequence is the per-playbook template key server/roadmap.ts dedupes on, so
  // reordering must not touch it. Renumber the passed (group) list densely with
  // the move applied, writing only the rows whose order actually changed.
  const moveTask = async (list: TaskRow[], from: number, to: number) => {
    if (to < 0 || to >= list.length) return;
    const arr = [...list];
    const [moved] = arr.splice(from, 1);
    arr.splice(to, 0, moved);
    const changed = arr
      .map((t, i) => ({ id: t.id, order: i, prev: t.display_order }))
      .filter((r) => r.prev !== r.order);
    await Promise.all(
      changed.map((r) => supabase.from('tasks').update({ display_order: r.order }).eq('id', r.id)),
    );
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
  };

  const generate = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await invokeFunction<GenerateRoadmapResult>('generate-roadmap', {
        engagement_id: engagementId,
        anchor_date: anchor,
      });
      refresh();
      invalidatePlans();
      const planCount = r.plansApplied?.length ?? 0;
      const planTasks = (r.plansApplied ?? []).reduce((n, p) => n + p.tasks_created, 0);
      let msg: string;
      if (r.tasksCreated > 0 || planCount > 0) {
        const parts: string[] = [];
        if (r.tasksCreated > 0) parts.push(`${r.tasksCreated} task${r.tasksCreated === 1 ? '' : 's'} from gaps`);
        if (planCount > 0)
          parts.push(
            `${planCount} plan${planCount === 1 ? '' : 's'} applied${planTasks ? ` (+${planTasks} task${planTasks === 1 ? '' : 's'})` : ''}`,
          );
        msg = `Roadmap built — ${parts.join(', ')}`;
      } else {
        msg = tasks.length ? 'Roadmap rescheduled from the new start date' : 'Roadmap is up to date';
      }
      toast.show(msg, 'good');
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  // Apply a Plan directly onto this roadmap (from the picker or a recommendation).
  const applyPlanToRoadmap = async (planTemplateId: string) => {
    if (!engagementId) return;
    setBusy(true);
    try {
      const res = await invokeFunction<{ tasks_created: number; tasks_claimed: number; milestones_created: number }>(
        'apply-plan',
        { engagement_id: engagementId, plan_template_id: planTemplateId, anchor_date: anchor || null },
      );
      refresh();
      invalidatePlans();
      const { tasks_created, tasks_claimed, milestones_created } = res;
      toast.show(
        `Plan applied — ${tasks_created} task${tasks_created === 1 ? '' : 's'} added` +
          (tasks_claimed ? `, ${tasks_claimed} linked` : '') +
          (milestones_created ? `, ${milestones_created} milestone${milestones_created === 1 ? '' : 's'}` : ''),
        'good',
      );
      setPlanToAdd('');
    } catch (err) {
      toast.show(err instanceof Error ? err.message : 'could not apply the plan', 'error');
    } finally {
      setBusy(false);
    }
  };

  // Soft-remove an applied Plan from this roadmap. Its tasks/milestones are NOT
  // deleted (client task history is preserved, docs/37 §2.3) — they fall back to
  // the gap-driven/unplanned bucket.
  const removePlanFromRoadmap = async (engagementPlanId: string) => {
    await supabase.from('engagement_plans').update({ status: 'removed' }).eq('id', engagementPlanId);
    invalidatePlans();
    refresh();
    toast.show('Plan removed from this roadmap — its tasks were kept', 'good');
  };

  const setTaskStatus = async (t: TaskRow, status: TaskRow['status']) => {
    await supabase.from('tasks').update({ status }).eq('id', t.id);
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
    invalidatePlans();
  };

  // Catch-up controls: set a task's real due date, and add work done/planned
  // outside the generated playbooks.
  const setTaskDue = async (t: TaskRow, due: string) => {
    await supabase.from('tasks').update({ due_date: due || null }).eq('id', t.id);
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
  };

  const addTask = async (e: FormEvent) => {
    e.preventDefault();
    if (!engagement || !tTitle) return;
    setError(null);
    const nextSeq = Math.max(0, ...tasks.map((t) => t.sequence ?? 0)) + 1;
    const { error } = await supabase.from('tasks').insert([
      {
        firm_id: engagement.firm_id,
        engagement_id: engagementId,
        title: tTitle,
        owner_role: tRole,
        due_date: tDate || null,
        status: 'todo',
        sequence: nextSeq,
      },
    ]);
    if (error) {
      setError(error.message);
      return;
    }
    setTTitle('');
    setTDate('');
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
    toast.show('Task added', 'good');
  };

  // `order`, when given, wires the up/down reorder controls (open-task list only).
  const renderTask = (t: TaskRow, order?: { list: TaskRow[]; index: number }) => {
    return (
      <li key={t.id} className={`rm-task ${t.status === 'done' ? 'rm-task-done' : ''}`}>
        {order && (
          <span className="rm-move" aria-hidden={false}>
            <button
              className="rm-move-btn"
              title="Move up"
              aria-label={`Move ${t.title} up`}
              disabled={order.index === 0}
              onClick={() => moveTask(order.list, order.index, order.index - 1)}
            >
              ↑
            </button>
            <button
              className="rm-move-btn"
              title="Move down"
              aria-label={`Move ${t.title} down`}
              disabled={order.index === order.list.length - 1}
              onClick={() => moveTask(order.list, order.index, order.index + 1)}
            >
              ↓
            </button>
          </span>
        )}
        <button
          className={`rm-check ${t.status === 'done' ? 'rm-check-done' : ''}`}
          title={t.status === 'done' ? 'Mark not done' : 'Mark done'}
          onClick={() => setTaskStatus(t, t.status === 'done' ? 'todo' : 'done')}
        >
          {t.status === 'done' ? '✓' : ''}
        </button>
        <span className="rm-task-body">
          <span className="rm-task-title">
            {t.title}
          </span>
          {t.status === 'done' ? (
            <span className="rm-task-meta"> · {t.due_date ? fmtDate(t.due_date) : '—'}</span>
          ) : (
            <input
              className="rm-task-due"
              type="date"
              value={t.due_date ? t.due_date.slice(0, 10) : ''}
              onChange={(e) => setTaskDue(t, e.target.value)}
              title="Set the real due date"
            />
          )}
        </span>
        <span className="rm-role">{ROLE_LABEL[t.owner_role] ?? humanizeKey(t.owner_role)}</span>
        {t.status !== 'done' && (
          <button
            className="linkish"
            onClick={() => setTaskStatus(t, t.status === 'blocked' ? 'todo' : 'blocked')}
          >
            {t.status === 'blocked' ? 'Unblock' : 'Block'}
          </button>
        )}
      </li>
    );
  };

  const addMilestone = async (e: FormEvent) => {
    e.preventDefault();
    if (!engagement || !mTitle) return;
    setError(null);
    const { error } = await supabase.from('roadmap_milestones').insert([
      {
        firm_id: engagement.firm_id,
        engagement_id: engagementId,
        track: mTrack,
        title: mTitle,
        target_date: mDate || null,
        created_by: profile?.id ?? null,
      },
    ]);
    if (error) {
      setError(error.message);
      return;
    }
    setMTitle('');
    setMDate('');
    qc.invalidateQueries({ queryKey: qk.milestones(engagementId!) });
    toast.show('Milestone added', 'good');
  };

  const removeMilestone = async (id: string) => {
    await supabase.from('roadmap_milestones').delete().eq('id', id);
    qc.invalidateQueries({ queryKey: qk.milestones(engagementId!) });
  };

  // Build Gantt items. One bar PER GROUP (applied Plan, or the gap-driven
  // bucket), not per task — the per-task chart ran dozens of rows tall and read
  // as noise. Each bar spans the plan start → the group's last due date (the
  // window in which that cluster of work closes), labelled with progress and the
  // next task. Milestones (personal + business) keep their diamonds, and the
  // owner's target sale date is drawn as its own diamond so the plan runs to it.
  const ganttItems = useMemo<GanttItem[]>(() => {
    const items: GanttItem[] = [];
    for (const g of groups) {
      const dued = g.tasks.filter((t) => t.due_date);
      if (dued.length === 0) continue;
      const lastDue = dued.map((t) => t.due_date!).sort().at(-1)!;
      const open = g.tasks.filter((t) => t.status !== 'done');
      const done = g.tasks.length - open.length;
      const anyBlocked = open.some((t) => t.status === 'blocked');
      const nextTask =
        [...open].filter((t) => t.due_date).sort((a, b) => a.due_date!.localeCompare(b.due_date!))[0] ??
        open[0] ??
        null;
      const status = open.length === 0 ? 'done' : anyBlocked ? 'blocked' : 'todo';
      items.push({
        id: `grp-${g.key}`,
        label: g.plan ? g.plan.name : 'Gap-driven tasks',
        sublabel:
          open.length === 0
            ? `${done}/${g.tasks.length} done`
            : `${done}/${g.tasks.length} done${nextTask ? ` · next: ${nextTask.title}` : ''}`,
        track: 'business',
        kind: 'task',
        start: startDate,
        end: lastDue,
        status,
      });
    }
    for (const m of milestones) {
      if (!m.target_date) continue;
      items.push({
        id: m.id,
        label: m.title,
        track: m.track,
        kind: 'milestone',
        end: m.target_date,
        status: m.completed_at ? 'reached' : undefined,
      });
    }
    if (targetDate) {
      items.push({ id: 'target-close', label: 'Target sale date', track: 'business', kind: 'milestone', end: targetDate });
    }
    return items;
  }, [groups, milestones, startDate, targetDate]);

  if (engagementQ.isLoading || tasksQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={5} />
      </Card>
    );
  }
  if (!engagement)
    return (
      <ErrorState
        variant="section"
        title="Engagement not found"
        message="This engagement doesn’t exist or you don’t have access to it."
      />
    );

  const companyName = companyQ.data?.name ?? '';

  // Deal-team handoff view: what each responsible party owns, and how far along.
  const roleGroups = ROLE_ORDER.map((role) => {
    const rt = tasks.filter((t) => t.owner_role === role);
    const done = rt.filter((t) => t.status === 'done').length;
    const nextTask =
      rt.filter((t) => t.status !== 'done' && t.due_date).sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1))[0] ??
      rt.find((t) => t.status !== 'done') ??
      null;
    return { role, total: rt.length, done, open: rt.length - done, nextTask };
  }).filter((g) => g.total > 0);

  const recommended = recommendedPlansQ.data ?? [];
  const hasWork = tasks.length > 0 || milestones.length > 0 || appliedPlans.length > 0;
  const toggleCollapsed = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const renderGroupMilestones = (list: MilestoneRow[]) =>
    list.length > 0 && (
      <ul className="assessment-list rm-group-milestones">
        {list.map((m) => (
          <li key={m.id} className="assessment-card">
            <span className="rm-role">{humanizeKey(m.track)}</span>
            <span className="assessment-score">
              <strong>{m.title}</strong>
              {m.target_date && <span className="muted"> · {fmtDate(m.target_date)}</span>}
              {m.completed_at && <span className="advisory-tag">reached</span>}
            </span>
            {m.engagement_plan_id ? (
              <span className="muted text-xs">plan</span>
            ) : (
              <button className="linkish" onClick={() => removeMilestone(m.id)}>
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    );

  // One roadmap group card — an applied Plan (with progress + remove), or the
  // gap-driven/unplanned bucket.
  const renderGroup = (g: RoadmapGroup) => {
    const isOpen = !collapsed.has(g.key);
    const open = openOrdered(g.tasks);
    const done = g.tasks.filter((t) => t.status === 'done');
    const plan = g.plan;
    const title = (
      <button className="rm-group-toggle" onClick={() => toggleCollapsed(g.key)} aria-expanded={isOpen}>
        <span className={`rm-caret${isOpen ? ' rm-caret-open' : ''}`} aria-hidden>
          ▸
        </span>
        {plan ? plan.name : 'Gap-driven & unplanned'}
        {plan?.completed_at && <span className="advisory-tag">complete</span>}
        <span className="count-pill">{g.tasks.length}</span>
      </button>
    );
    const subtitle = plan
      ? `${plan.done}/${plan.total} done · ${plan.pct}%`
      : 'Tasks and milestones not tied to a plan — gap-derived work and anything you add by hand.';
    const action = plan && (
      <button
        className="linkish"
        title="Remove this plan from the roadmap (its tasks are kept)"
        onClick={() => removePlanFromRoadmap(plan.id)}
      >
        Remove plan
      </button>
    );
    return (
      <SectionCard key={g.key} title={title} subtitle={subtitle} action={action} className="rm-group">
        {plan && (
          <div className="plan-progress-track rm-group-progress">
            <div
              className={`plan-progress-fill${plan.completed_at ? ' plan-progress-fill-done' : ''}`}
              style={{ width: `${plan.pct}%` }}
            />
          </div>
        )}
        {isOpen && (
          <div className="rm-group-body">
            {open.length === 0 && done.length === 0 && g.milestones.length === 0 ? (
              <p className="muted m-0">No tasks or milestones yet in this group.</p>
            ) : (
              <>
                {open.length > 0 && (
                  <ul className="rm-tasklist">{open.map((t, i) => renderTask(t, { list: open, index: i }))}</ul>
                )}
                {renderGroupMilestones(g.milestones)}
                {done.length > 0 && (
                  <div className="rm-sprint rm-sprint-done">
                    <h4 className="rm-sprint-head">
                      Completed <span className="count-pill">{done.length}</span>
                    </h4>
                    <ul className="rm-tasklist">{done.map((t) => renderTask(t))}</ul>
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </SectionCard>
    );
  };

  return (
    <div className="page-shell stack-lg">
      <header className="page-masthead">
        <PageHeader
          title="Roadmap"
          crumbs={engagementCrumbs(engagementId, companyName, 'Roadmap')}
          subtitle="Every open gap, applied plan, and milestone on one timeline — from the start date to the target sale date."
        />
        <EngagementNav engagementId={engagementId!} />
      </header>
      {error && <ErrorState variant="inline" error={error} />}

      {/* Build controls + adding plans live at the top, always reachable. */}
      <SectionCard
        title="Build & schedule"
        subtitle="Set the start and target dates, generate the gap-driven roadmap, or add a plan directly."
      >
        <div className="roadmap-toolbar">
          <label className="roadmap-startdate">
            <span>Start date</span>
            <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
          </label>
          <label className="roadmap-startdate">
            <span>Target sale date</span>
            <input
              type="date"
              value={targetDate ? targetDate.slice(0, 10) : ''}
              min={anchor}
              onChange={(e) => saveTargetDate(e.target.value)}
            />
          </label>
          <button onClick={generate} disabled={busy}>
            {busy ? 'Working…' : hasWork ? 'Rebuild from gaps' : 'Build roadmap from gaps'}
          </button>
        </div>
        <p className="muted text-sm rm-build-note">
          Building from gaps turns open gaps — most critical first — into sequenced tasks, and applies any plan that
          substantively targets those gaps.
        </p>
        <div className="rm-add-plan">
          <label className="roadmap-startdate">
            <span>Add a plan</span>
            <select value={planToAdd} onChange={(e) => setPlanToAdd(e.target.value)} disabled={availablePlans.length === 0}>
              <option value="">
                {availablePlans.length === 0 ? 'All plans applied' : 'Select a plan…'}
              </option>
              {availablePlans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.is_system ? ' (System)' : ' (Firm)'}
                </option>
              ))}
            </select>
          </label>
          <button className="button-secondary" disabled={busy || !planToAdd} onClick={() => applyPlanToRoadmap(planToAdd)}>
            Add to roadmap
          </button>
        </div>
      </SectionCard>

      {recommended.length > 0 && (
        <SectionCard
          title="Recommended plans"
          subtitle="Plans that target this engagement’s open gaps and fired initiatives — apply the ones that fit."
        >
          <div className="plan-progress-list">
            {recommended.map((r) => {
              const bits: string[] = [];
              if (r.matched_gap_count > 0)
                bits.push(`${r.matched_gap_count} gap${r.matched_gap_count === 1 ? '' : 's'}`);
              if (r.matched_initiative_count > 0)
                bits.push(`${r.matched_initiative_count} initiative${r.matched_initiative_count === 1 ? '' : 's'}`);
              return (
                <div key={r.plan_template_id} className="plan-rec-row">
                  <span className="plan-progress-name">
                    {r.name}
                    <span className="advisory-tag">{r.is_system ? 'System' : 'Firm'}</span>
                    {bits.length > 0 && <span className="muted"> covers {bits.join(' · ')}</span>}
                  </span>
                  <button className="button-secondary" disabled={busy} onClick={() => applyPlanToRoadmap(r.plan_template_id)}>
                    Apply
                  </button>
                </div>
              );
            })}
          </div>
        </SectionCard>
      )}

      {ganttItems.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No roadmap yet"
          action={
            <button onClick={generate} disabled={busy}>
              {busy ? 'Working…' : 'Build roadmap from gaps'}
            </button>
          }
        >
          Building the roadmap turns this engagement’s open gaps — most critical first — into a sequenced set of
          remediation tasks, and lays down any plan that substantively targets them. Add personal milestones for the
          owner’s wealth plan alongside them.
        </EmptyState>
      ) : (
        <div className="roadmap-timeline">
          <Card pad="lg">
            <GanttChart items={ganttItems} />
          </Card>
        </div>
      )}

      {/* Next up by party — the deal-team handoff, surfaced so each responsible
          party's next move is visible at a glance. */}
      {roleGroups.length > 0 && (
        <section>
          <h3 className="section-heading" style={{ marginBottom: 'var(--space-2)' }}>
            Next up by party
          </h3>
          <div className="nextup-grid">
            {roleGroups.map((g) => (
              <div className="nextup-card" key={g.role}>
                <div className="nextup-head">
                  <span className="handoff-role">{ROLE_LABEL[g.role] ?? g.role}</span>
                  <span className="nextup-count">
                    {g.open > 0 ? (
                      <>
                        <strong>{g.open}</strong> open
                      </>
                    ) : (
                      <span className="handoff-clear">clear</span>
                    )}
                    <span className="muted">
                      {' '}
                      · {g.done}/{g.total}
                    </span>
                  </span>
                </div>
                {g.nextTask ? (
                  <p className="nextup-task">
                    {g.nextTask.title}
                    {g.nextTask.due_date && <span className="muted"> · {fmtDate(g.nextTask.due_date)}</span>}
                  </p>
                ) : (
                  <p className="nextup-task muted">Nothing open — this party is clear.</p>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* The plan-grouped board: each applied plan is its own group, with the
          gap-driven/unplanned work last. */}
      {groups.length > 0 ? (
        <section className="stack-md">
          <h3 className="section-heading">Plans & work</h3>
          {groups.map((g) => renderGroup(g))}
        </section>
      ) : (
        hasWork && <p className="muted">No tasks or milestones yet — build from gaps or add a plan above.</p>
      )}

      {/* Add work — manual tasks and milestones land in the gap-driven bucket. */}
      <div className="roadmap-cols">
        <form className="inline-form" onSubmit={addMilestone}>
          <h3>Add a milestone</h3>
          <p className="muted m-0">Track the owner’s personal and business targets alongside the remediation work.</p>
          <input placeholder="e.g. Estate plan reviewed" value={mTitle} onChange={(e) => setMTitle(e.target.value)} required />
          <select value={mTrack} onChange={(e) => setMTrack(e.target.value as 'business' | 'personal')}>
            <option value="personal">Personal &amp; wealth</option>
            <option value="business">Business readiness</option>
          </select>
          <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
          <button type="submit">Add</button>
        </form>

        <form className="inline-form rm-add-task" onSubmit={addTask}>
          <h3>Add a task</h3>
          <p className="muted m-0">
            Capture work underway or planned outside the generated playbooks; mark items done to reflect actual progress.
          </p>
          <input placeholder="e.g. QoE engagement letter signed" value={tTitle} onChange={(e) => setTTitle(e.target.value)} required />
          <select value={tRole} onChange={(e) => setTRole(e.target.value)}>
            {ROLE_ORDER.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r] ?? r}
              </option>
            ))}
          </select>
          <input type="date" value={tDate} onChange={(e) => setTDate(e.target.value)} />
          <button type="submit">Add</button>
        </form>
      </div>
    </div>
  );
}
