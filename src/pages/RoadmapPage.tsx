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
  Collapsible,
  EmptyState,
  EngagementNav,
  GanttChart,
  PageHeader,
  SkeletonLines,
  useToast,
  type GanttItem,
} from '../components/ui';
import { fmtDate } from '../lib/format';
import { engagementCrumbs } from '../lib/nav';
import { groupIntoSprints } from '../lib/practitioner';

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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: qk.tasks(engagementId!) });
    qc.invalidateQueries({ queryKey: qk.milestones(engagementId!) });
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

  const renderTask = (t: TaskRow) => (
    <li key={t.id} className={`rm-task ${t.status === 'done' ? 'rm-task-done' : ''}`}>
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
      <span className="rm-role">{t.owner_role}</span>
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

  // Build Gantt items: business-track tasks chained by workstream (playbook),
  // plus milestones on their tracks.
  const ganttItems = useMemo<GanttItem[]>(() => {
    const items: GanttItem[] = [];
    const byPlaybook = new Map<string, TaskRow[]>();
    for (const t of tasks) {
      const key = t.playbook_id ?? 'none';
      const list = byPlaybook.get(key) ?? [];
      list.push(t);
      byPlaybook.set(key, list);
    }
    for (const [pid, list] of byPlaybook) {
      const ordered = [...list].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      let prevEnd = startDate;
      for (const t of ordered) {
        if (!t.due_date) continue;
        items.push({
          id: t.id,
          label: t.title,
          sublabel: `${t.owner_role}${playbooks.get(pid)?.name ? ` · ${playbooks.get(pid)!.name}` : ''}`,
          track: 'business',
          kind: 'task',
          start: prevEnd,
          end: t.due_date,
          status: t.status,
        });
        prevEnd = t.due_date;
      }
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
    return items;
  }, [tasks, milestones, startDate, playbooks]);

  if (engagementQ.isLoading || tasksQ.isLoading) {
    return (
      <Card>
        <SkeletonLines lines={5} />
      </Card>
    );
  }
  if (!engagement) return <p className="form-error">Engagement not found</p>;

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
    const nextDue = rt
      .filter((t) => t.status !== 'done' && t.due_date)
      .map((t) => t.due_date as string)
      .sort()[0];
    return { role, total: rt.length, done, open: rt.length - done, nextDue };
  }).filter((g) => g.total > 0);

  return (
    <div className="stack-lg">
      <PageHeader
        title="Roadmap"
        crumbs={engagementCrumbs(engagementId, companyName, 'Roadmap')}
        subtitle="Remediation work and milestones on one timeline — business readiness and the owner’s personal plan."
        actions={
          <div className="roadmap-controls">
            <label className="roadmap-startdate">
              <span>Start date</span>
              <input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
            </label>
            <button onClick={generate} disabled={busy}>
              {busy ? 'Working…' : tasks.length ? 'Reschedule from start date' : 'Build roadmap from gaps'}
            </button>
          </div>
        }
      />
      <EngagementNav engagementId={engagementId!} />
      {error && <p className="form-error">{error}</p>}

      {ganttItems.length === 0 ? (
        <EmptyState
          icon="◷"
          title="No roadmap yet"
          action={<button onClick={generate} disabled={busy}>Build roadmap from gaps</button>}
        >
          Building the roadmap turns this engagement’s open gaps — most critical first — into a
          sequenced set of remediation tasks. Add personal milestones for the owner’s wealth plan
          alongside them.
        </EmptyState>
      ) : (
        <Card pad="lg">
          <GanttChart items={ganttItems} />
        </Card>
      )}

      {/* deal-team handoff: what each responsible party owns */}
      {roleGroups.length > 0 && (
        <Collapsible
          title="By responsible party"
          hint="Who owns the remaining work — advisor, owner, and deal team"
        >
          <div className="handoff">
            {roleGroups.map((g) => {
              const pct = g.total > 0 ? Math.round((g.done / g.total) * 100) : 0;
              return (
                <div className="handoff-row" key={g.role}>
                  <span className="handoff-role">{ROLE_LABEL[g.role] ?? g.role}</span>
                  <div className="handoff-bar" title={`${g.done} of ${g.total} done`}>
                    <div className="handoff-fill" style={{ width: `${pct}%` }} />
                  </div>
                  <span className="handoff-count">
                    {g.open > 0 ? <><strong>{g.open}</strong> open</> : <span className="handoff-clear">clear</span>}
                    <span className="muted"> · {g.done}/{g.total}</span>
                  </span>
                  <span className="handoff-due muted">
                    {g.nextDue ? `next ${fmtDate(g.nextDue)}` : '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </Collapsible>
      )}

      {/* milestone entry */}
      <div className="eng-grid">
        <div>
          <h3 className="section-heading">Milestones</h3>
          {milestones.length === 0 && <p className="muted">No milestones yet — add the owner’s personal and business targets below.</p>}
          <ul className="assessment-list">
            {milestones.map((m) => (
              <li key={m.id} className="assessment-card">
                <span className={`rm-role`}>{m.track}</span>
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
            Grouped into 90-day sprints — the Prepare-gate cadence advisors execute against.
          </p>
          {tasks.length === 0 ? (
            <p className="muted">Build the roadmap to generate tasks from the open gaps.</p>
          ) : (
            <>
              {groupIntoSprints(openTasks, new Date().toISOString()).map((sprint) => (
                <div key={sprint.key} className="rm-sprint">
                  <h4 className="rm-sprint-head">
                    {sprint.label} <span className="count-pill">{sprint.tasks.length}</span>
                  </h4>
                  <ul className="rm-tasklist">{sprint.tasks.map(renderTask)}</ul>
                </div>
              ))}
              {doneTasks.length > 0 && (
                <div className="rm-sprint rm-sprint-done">
                  <h4 className="rm-sprint-head">
                    Completed <span className="count-pill">{doneTasks.length}</span>
                  </h4>
                  <ul className="rm-tasklist">{doneTasks.map(renderTask)}</ul>
                </div>
              )}
            </>
          )}
          <form className="inline-form rm-add-task" onSubmit={addTask} style={{ marginTop: '0.9rem' }}>
            <h3>Add a task</h3>
            <p className="muted" style={{ margin: 0 }}>
              Capture work already underway or planned outside the generated playbooks — mark it done
              to reflect what’s finished.
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
