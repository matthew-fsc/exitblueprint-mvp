import { useOwnerContext } from '../../lib/owner';
import { useTasks, useMilestones } from '../../lib/queries';
import { Card, EmptyState, ErrorState, PageHeader, SkeletonLines } from '../../components/ui';
import { fmtDate } from '../../lib/format';

const STATUS_LABEL: Record<string, string> = {
  todo: 'To do', doing: 'In progress', done: 'Done', blocked: 'Blocked',
};

export default function OwnerPlanPage() {
  const { engagement, loading, isError, error, refetch } = useOwnerContext();
  const tasksQ = useTasks(engagement?.id);
  const milestonesQ = useMilestones(engagement?.id);
  const tasks = tasksQ.data ?? [];
  const milestones = milestonesQ.data ?? [];
  const open = tasks.filter((t) => t.status !== 'done');
  const done = tasks.filter((t) => t.status === 'done');

  return (
    <div className="stack-lg">
      <PageHeader
        title="Your plan"
        subtitle="The steps your advisor and team have laid out to move your business toward a sale."
      />
      {loading || tasksQ.isLoading || milestonesQ.isLoading ? (
        <Card><SkeletonLines lines={6} /></Card>
      ) : isError || tasksQ.isError || milestonesQ.isError ? (
        <ErrorState variant="section" error={error ?? tasksQ.error ?? milestonesQ.error} onRetry={refetch} />
      ) : tasks.length === 0 && milestones.length === 0 ? (
        <EmptyState title="Your plan is being built">
          Once your advisor turns your assessment into a roadmap, the steps will appear here.
        </EmptyState>
      ) : (
        <>
          {milestones.length > 0 && (
            <Card>
              <span className="stat-block-label">Milestones</span>
              <ul className="owner-milestones">
                {milestones.map((m) => (
                  <li key={m.id}>
                    <span className={`owner-track owner-track-${m.track}`}>{m.track === 'personal' ? 'Personal' : 'Business'}</span>
                    <span><strong>{m.title}</strong>{m.target_date && <span className="muted"> · target {fmtDate(m.target_date)}</span>}</span>
                    {m.completed_at && <span className="owner-done-tag">✓ reached</span>}
                  </li>
                ))}
              </ul>
            </Card>
          )}
          <Card>
            <span className="stat-block-label">
              Steps <span className="count-pill">{open.length} open</span>
            </span>
            <ul className="owner-tasklist">
              {[...open, ...done].map((t) => (
                <li key={t.id} className={t.status === 'done' ? 'owner-task-done' : ''}>
                  <span className={`owner-task-dot owner-status-${t.status}`} aria-hidden />
                  <span className="owner-task-main">
                    <span className="owner-task-title">{t.title}</span>
                    {t.description && <span className="owner-task-desc muted">{t.description}</span>}
                  </span>
                  <span className="owner-task-meta muted">
                    {STATUS_LABEL[t.status] ?? t.status}
                    {t.due_date && ` · due ${fmtDate(t.due_date)}`}
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
}
