import { useMemo, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useAuth } from '../lib/auth';
import { invokeFunction, supabase } from '../lib/supabase';
import {
  qk,
  useCompany,
  useEngagement,
  useMilestones,
  usePlaybooks,
  useTasks,
  type TaskRow,
} from '../lib/queries';
import {
  Card,
  EmptyState,
  EngagementNav,
  ErrorState,
  GanttChart,
  PageHeader,
  SkeletonLines,
  useToast,
  type GanttItem,
} from '../components/ui';
import { fmtDate, humanizeKey } from '../lib/format';
import { engagementCrumbs } from '../lib/nav';

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
  const playbooksQ = usePlaybooks();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The plan is laid out forward from this date; defaults to today so the
  // timeline never opens in the past.
  const [anchor, setAnchor] = useState<string>(() => new Date().toISOString().slice(0, 10));

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
  const playbooks = playbooksQ.data ?? new Map();
  const startDate = anchor;
  // The owner's real sale-date target, set here (like the start date) and shared
  // with the exit-pace chart on the Overview so both run to the same deadline.
  const targetDate = engagement?.target_close_date ?? '';

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
    qc.invalidateQueries({ queryKey: qk.milestones(engagementId!) });
  };

  const saveTargetDate = async (v: string) => {
    if (!engagementId) return;
    await supabase.from('engagements').update({ target_close_date: v || null }).eq('id', engagementId);
    qc.invalidateQueries({ queryKey: qk.engagement(engagementId) });
  };

  // Move an open task one slot up/down and persist the new order. Ordering lives
  // in its OWN column (display_order), not `sequence` — sequence is the
  // per-playbook template key server/roadmap.ts dedupes on, so reordering must not
  // touch it. Renumber the whole open list densely (0..n) with the move applied,
  // writing only the rows whose order actually changed.
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
      const r = await invokeFunction<{ tasksCreated: number }>('generate-roadmap', {
        engagement_id: engagementId,
        anchor_date: anchor,
      });
      refresh();
      toast.show(
        r.tasksCreated > 0
          ? `Roadmap built — ${r.tasksCreated} tasks added`
          : tasks.length
            ? 'Roadmap rescheduled from the new start date'
            : 'Roadmap is up to date',
        'good',
      );
    } catch (err) {
      setError((err as Error).message);
    }
    setBusy(false);
  };

  const setTaskStatus = async (t: TaskRow, status: TaskRow['status']) => {
    await supabase.from('tasks').update({ status }).eq('id', t.id);
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
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
  const renderTask = (
    t: TaskRow,
    order?: { list: TaskRow[]; index: number },
  ) => (
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
        <span className="rm-task-title">{t.title}</span>
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

  // Build Gantt items. One bar PER WORKSTREAM (playbook), not per task — the
  // per-task chart ran dozens of rows tall and read as noise. Each workstream bar
  // spans the plan start → the workstream's last due date (the window in which
  // that cluster of gaps is closed), labelled with progress and the next task.
  // Milestones (personal + business) keep their diamonds, and the owner's target
  // sale date is drawn as its own diamond so the whole plan visibly runs to it.
  const ganttItems = useMemo<GanttItem[]>(() => {
    const items: GanttItem[] = [];
    const byPlaybook = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const key = t.playbook_id ?? 'none';
      const list = byPlaybook.get(key) ?? [];
      list.push(t);
      byPlaybook.set(key, list);
    }
    // Order lanes by their earliest open due date so the nearest work sits on top.
    const lanes = [...byPlaybook.entries()]
      .map(([pid, list]) => {
        const ordered = [...list].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
        const dued = ordered.filter((t) => t.due_date);
        const lastDue = dued.length ? dued[dued.length - 1].due_date! : null;
        const open = ordered.filter((t) => t.status !== 'done');
        const nextTask = open.find((t) => t.due_date) ?? open[0] ?? null;
        const anyBlocked = open.some((t) => t.status === 'blocked');
        const done = ordered.length - open.length;
        return { pid, list: ordered, lastDue, open: open.length, done, nextTask, anyBlocked };
      })
      .filter((l) => l.lastDue)
      .sort((a, b) => (a.nextTask?.due_date ?? a.lastDue!).localeCompare(b.nextTask?.due_date ?? b.lastDue!));

    for (const lane of lanes) {
      const name = playbooks.get(lane.pid)?.name ?? 'Other tasks';
      const status = lane.open === 0 ? 'done' : lane.anyBlocked ? 'blocked' : 'todo';
      items.push({
        id: `ws-${lane.pid}`,
        label: name,
        sublabel:
          lane.open === 0
            ? `${lane.done}/${lane.list.length} done`
            : `${lane.done}/${lane.list.length} done${lane.nextTask ? ` · next: ${lane.nextTask.title}` : ''}`,
        track: 'business',
        kind: 'task',
        start: startDate,
        end: lane.lastDue!,
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
      items.push({
        id: 'target-close',
        label: 'Target sale date',
        track: 'business',
        kind: 'milestone',
        end: targetDate,
      });
    }
    return items;
  }, [tasks, milestones, startDate, playbooks, targetDate]);

  if (engagementQ.isLoading || tasksQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={5} />
      </Card>
    );
  }
  if (!engagement) return <ErrorState variant="section" title="Engagement not found" message="This engagement doesn’t exist or you don’t have access to it." />;

  const companyName = companyQ.data?.name ?? '';
  const openTasks = tasks.filter((t) => t.status !== 'done');
  const doneTasks = tasks.filter((t) => t.status === 'done');

  // Deal-team handoff view: what each responsible party owns, and how far along.
  const ROLE_ORDER = ['owner', 'advisor', 'cpa', 'attorney', 'ops'];
  const ROLE_LABEL: Record<string, string> = {
    owner: 'Owner', advisor: 'Advisor', cpa: 'CPA / accountant', attorney: 'Attorney', ops: 'Operations',
  };
  const roleGroups = ROLE_ORDER.map((role) => {
    const rt = tasks.filter((t) => t.owner_role === role);
    const done = rt.filter((t) => t.status === 'done').length;
    const nextTask =
      rt
        .filter((t) => t.status !== 'done' && t.due_date)
        .sort((a, b) => (a.due_date! < b.due_date! ? -1 : 1))[0] ??
      rt.find((t) => t.status !== 'done') ??
      null;
    return { role, total: rt.length, done, open: rt.length - done, nextTask };
  }).filter((g) => g.total > 0);

  // Open tasks in advisor-controlled order. A manually-set display_order wins;
  // tasks without one (a freshly generated plan) fall to the back in due-date
  // order, so the list reads sensibly until an advisor reorders it.
  const ORDER_UNSET = Number.MAX_SAFE_INTEGER;
  const openOrdered = [...openTasks].sort(
    (a, b) =>
      (a.display_order ?? ORDER_UNSET) - (b.display_order ?? ORDER_UNSET) ||
      (a.due_date ?? '').localeCompare(b.due_date ?? '') ||
      (a.sequence ?? 0) - (b.sequence ?? 0),
  );

  return (
    <div className="page-shell stack-lg">
      <header className="page-masthead">
        <PageHeader
          title="Roadmap"
          crumbs={engagementCrumbs(engagementId, companyName, 'Roadmap')}
          subtitle="Every open gap and milestone on one timeline, mapped from the start date to the target sale date."
        />
        <EngagementNav engagementId={engagementId!} />
      </header>
      {error && <ErrorState variant="inline" error={error} />}

      {ganttItems.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No roadmap yet"
          action={<button onClick={generate} disabled={busy}>{busy ? 'Working…' : 'Build roadmap from gaps'}</button>}
        >
          Building the roadmap turns this engagement’s open gaps — most critical first — into a
          sequenced set of remediation tasks. Add personal milestones for the owner’s wealth plan
          alongside them.
        </EmptyState>
      ) : (
        <div className="roadmap-timeline">
          {/* The start-date + reschedule control lives with the timeline it drives,
              not crowding the page title. */}
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
            <button className="button-secondary" onClick={generate} disabled={busy}>
              {busy ? 'Working…' : 'Reschedule from start date'}
            </button>
          </div>
          <Card pad="lg">
            <GanttChart items={ganttItems} />
          </Card>
        </div>
      )}

      {/* Next up by party — the deal-team handoff, surfaced (not hidden in a
          disclosure) so each responsible party's next move is visible at a glance. */}
      {roleGroups.length > 0 && (
        <section>
          <h3 className="section-heading" style={{ marginBottom: 'var(--space-2)' }}>Next up by party</h3>
          <div className="nextup-grid">
            {roleGroups.map((g) => (
              <div className="nextup-card" key={g.role}>
                <div className="nextup-head">
                  <span className="handoff-role">{ROLE_LABEL[g.role] ?? g.role}</span>
                  <span className="nextup-count">
                    {g.open > 0 ? <><strong>{g.open}</strong> open</> : <span className="handoff-clear">clear</span>}
                    <span className="muted"> · {g.done}/{g.total}</span>
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

      {/* Milestones is a compact left rail; remediation tasks (the main content)
          take the wider column — so the sparse side never strands a tall empty gap. */}
      <div className="roadmap-cols">
        <div>
          <h3 className="section-heading">Milestones</h3>
          {milestones.length === 0 && <p className="muted">No milestones yet. Add the owner’s personal and business targets below.</p>}
          <ul className="assessment-list">
            {milestones.map((m) => (
              <li key={m.id} className="assessment-card">
                <span className={`rm-role`}>{humanizeKey(m.track)}</span>
                <span className="assessment-score">
                  <strong>{m.title}</strong>
                  {m.target_date && <span className="muted"> · {fmtDate(m.target_date)}</span>}
                </span>
                <button className="linkish" onClick={() => removeMilestone(m.id)}>
                  Remove
                </button>
              </li>
            ))}
          </ul>
          <form className="inline-form" onSubmit={addMilestone} style={{ marginTop: '0.75rem' }}>
            <h3>New milestone</h3>
            <input placeholder="e.g. Estate plan reviewed" value={mTitle} onChange={(e) => setMTitle(e.target.value)} required />
            <select value={mTrack} onChange={(e) => setMTrack(e.target.value as 'business' | 'personal')}>
              <option value="personal">Personal &amp; wealth</option>
              <option value="business">Business readiness</option>
            </select>
            <input type="date" value={mDate} onChange={(e) => setMDate(e.target.value)} />
            <button type="submit">Add</button>
          </form>
        </div>

        <div>
          <h3 className="section-heading">
            Remediation tasks <span className="count-pill">{openTasks.length}</span>
          </h3>
          <p className="muted rm-sprint-note" style={{ marginTop: 0 }}>
            In execution order — use ↑ ↓ to re-sequence, or set a due date to reschedule.
          </p>
          {tasks.length === 0 ? (
            <p className="muted">Build the roadmap to generate tasks from the open gaps.</p>
          ) : (
            <>
              {openOrdered.length > 0 && (
                <ul className="rm-tasklist">
                  {openOrdered.map((t, i) => renderTask(t, { list: openOrdered, index: i }))}
                </ul>
              )}
              {doneTasks.length > 0 && (
                <div className="rm-sprint rm-sprint-done">
                  <h4 className="rm-sprint-head">
                    Completed <span className="count-pill">{doneTasks.length}</span>
                  </h4>
                  <ul className="rm-tasklist">{doneTasks.map((t) => renderTask(t))}</ul>
                </div>
              )}
            </>
          )}
          <form className="inline-form rm-add-task" onSubmit={addTask} style={{ marginTop: '0.9rem' }}>
            <h3>Add a task</h3>
            <p className="muted m-0">
              Capture work underway or planned outside the generated playbooks; mark items done to
              reflect actual progress.
            </p>
            <input
              placeholder="e.g. QoE engagement letter signed"
              value={tTitle}
              onChange={(e) => setTTitle(e.target.value)}
              required
            />
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
    </div>
  );
}
