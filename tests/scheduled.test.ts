import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REASSESS_DAYS,
  DEFAULT_STALE_DAYS,
  DEFAULT_STALLED_DAYS,
  REASSESSMENT_DUE_FIRM_SQL,
  REASSESSMENT_DUE_SQL,
  STALE_ENGAGEMENTS_FIRM_SQL,
  STALE_ENGAGEMENTS_SQL,
  STALLED_TASKS_FIRM_SQL,
  STALLED_TASKS_SQL,
  findReassessmentDue,
  findStaleEngagements,
  findStalledTasks,
  mapReassessmentDueRow,
  mapStaleEngagementRow,
  mapStalledTaskRow,
  verifyWebhookSecret,
} from '../server/scheduled';

// A fake pg client: records the SQL + params it was asked to run, and replays
// canned rows. No real DB, no network — the queries are the substance, so we
// assert on what gets bound and how rows are shaped.
function fakeDb(rows: unknown[]) {
  const calls: { sql: string; params: unknown[] }[] = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows };
    },
  } as never;
  return { db, calls };
}

// Fixed clock anchor. The analyzers compute day-counts against `now`, so tests
// that call the `find*` wrappers must inject this same `now` (via opts) — else
// the wrappers fall back to the real wall clock and the day-counts drift by a
// day for every day since this file was written.
const NOW = new Date('2026-07-20T00:00:00.000Z');
const iso = (daysAgo: number) => new Date(NOW.getTime() - daysAgo * 86_400_000).toISOString();

describe('findStaleEngagements', () => {
  it('binds the default threshold and shapes rows into items', async () => {
    const { db, calls } = fakeDb([
      {
        engagement_id: 'eng-1',
        firm_id: 'firm-1',
        company_id: 'co-1',
        company_name: 'Acme',
        owner_contact_name: 'Jane',
        owner_contact_email: 'jane@acme.test',
        engagement_status: 'active',
        started_at: iso(200),
        last_assessment_at: iso(45),
        last_log_at: iso(50),
        last_activity_at: iso(45),
        assessment_count: '2',
      },
    ]);
    const res = await findStaleEngagements(db, { now: NOW });
    expect(calls[0].sql).toBe(STALE_ENGAGEMENTS_SQL);
    expect(calls[0].params).toEqual([DEFAULT_STALE_DAYS]);
    expect(res.thresholdDays).toBe(30);
    expect(res.count).toBe(1);
    expect(res.items[0]).toMatchObject({
      firmId: 'firm-1',
      engagementId: 'eng-1',
      assessmentCount: 2,
    });
    expect(typeof res.generatedAt).toBe('string');
  });

  it('passes a custom staleDays threshold through to the query', async () => {
    const { db, calls } = fakeDb([]);
    const res = await findStaleEngagements(db, { staleDays: 60 });
    expect(calls[0].params).toEqual([60]);
    expect(res.thresholdDays).toBe(60);
  });

  it('returns the empty-result shape with no rows', async () => {
    const { db } = fakeDb([]);
    const res = await findStaleEngagements(db, { staleDays: 30 });
    expect(res.count).toBe(0);
    expect(res.items).toEqual([]);
  });

  it('mapper computes daysStale and carries firm_id for per-firm routing', () => {
    const item = mapStaleEngagementRow(
      {
        engagement_id: 'eng-9',
        firm_id: 'firm-9',
        company_id: 'co-9',
        company_name: null,
        owner_contact_name: null,
        owner_contact_email: null,
        engagement_status: 'active',
        started_at: iso(300),
        last_assessment_at: null,
        last_log_at: null,
        last_activity_at: iso(40),
        assessment_count: '0',
      },
      NOW,
    );
    expect(item.firmId).toBe('firm-9');
    expect(item.daysStale).toBe(40);
    expect(item.lastAssessmentAt).toBeNull();
    expect(item.assessmentCount).toBe(0);
  });
});

describe('findStalledTasks', () => {
  it('binds the default threshold and shapes rows, computing overdue days', async () => {
    const { db, calls } = fakeDb([
      {
        task_id: 'task-1',
        firm_id: 'firm-1',
        engagement_id: 'eng-1',
        company_id: 'co-1',
        company_name: 'Acme',
        owner_contact_name: 'Jane',
        title: 'Clean up cap table',
        status: 'doing',
        owner_role: 'owner',
        assigned_to_name: 'Jane',
        due_date: iso(10),
        created_at: iso(30),
        past_due: true,
      },
    ]);
    const res = await findStalledTasks(db, { now: NOW });
    expect(calls[0].sql).toBe(STALLED_TASKS_SQL);
    expect(calls[0].params).toEqual([DEFAULT_STALLED_DAYS]);
    expect(res.thresholdDays).toBe(14);
    expect(res.items[0]).toMatchObject({
      firmId: 'firm-1',
      taskId: 'task-1',
      pastDue: true,
      daysStalled: 30,
      daysOverdue: 10,
    });
  });

  it('passes a custom stalledDays threshold', async () => {
    const { db, calls } = fakeDb([]);
    await findStalledTasks(db, { stalledDays: 7 });
    expect(calls[0].params).toEqual([7]);
  });

  it('reports zero overdue days when a task is stalled but not past due', () => {
    const item = mapStalledTaskRow(
      {
        task_id: 'task-2',
        firm_id: 'firm-2',
        engagement_id: 'eng-2',
        company_id: 'co-2',
        company_name: 'Beta',
        owner_contact_name: null,
        title: 'Draft SOPs',
        status: 'todo',
        owner_role: 'ops',
        assigned_to_name: null,
        due_date: null,
        created_at: iso(20),
        past_due: false,
      },
      NOW,
    );
    expect(item.pastDue).toBe(false);
    expect(item.daysOverdue).toBe(0);
    expect(item.daysStalled).toBe(20);
    expect(item.dueDate).toBeNull();
  });
});

describe('findReassessmentDue', () => {
  it('binds the default cadence and shapes rows', async () => {
    const { db, calls } = fakeDb([
      {
        engagement_id: 'eng-1',
        firm_id: 'firm-1',
        company_id: 'co-1',
        company_name: 'Acme',
        owner_contact_name: 'Jane',
        owner_contact_email: 'jane@acme.test',
        last_completed_at: iso(120),
        last_sequence_number: '3',
        completed_count: '3',
      },
    ]);
    const res = await findReassessmentDue(db, { now: NOW });
    expect(calls[0].sql).toBe(REASSESSMENT_DUE_SQL);
    expect(calls[0].params).toEqual([DEFAULT_REASSESS_DAYS]);
    expect(res.thresholdDays).toBe(90);
    expect(res.items[0]).toMatchObject({
      firmId: 'firm-1',
      engagementId: 'eng-1',
      lastSequenceNumber: 3,
      completedCount: 3,
      daysSinceLastAssessment: 120,
    });
  });

  it('passes a custom reassessDays threshold', async () => {
    const { db, calls } = fakeDb([]);
    const res = await findReassessmentDue(db, { reassessDays: 180 });
    expect(calls[0].params).toEqual([180]);
    expect(res.thresholdDays).toBe(180);
  });

  it('mapper carries firm_id and computes days since last assessment', () => {
    const item = mapReassessmentDueRow(
      {
        engagement_id: 'eng-5',
        firm_id: 'firm-5',
        company_id: 'co-5',
        company_name: 'Gamma',
        owner_contact_name: null,
        owner_contact_email: null,
        last_completed_at: iso(95),
        last_sequence_number: '1',
        completed_count: '1',
      },
      NOW,
    );
    expect(item.firmId).toBe('firm-5');
    expect(item.daysSinceLastAssessment).toBe(95);
  });
});

describe('defaults', () => {
  it('exposes the documented cadence constants', () => {
    expect(DEFAULT_STALE_DAYS).toBe(30);
    expect(DEFAULT_STALLED_DAYS).toBe(14);
    expect(DEFAULT_REASSESS_DAYS).toBe(90);
  });
});

describe('verifyWebhookSecret', () => {
  it('accepts an exact match', () => {
    expect(verifyWebhookSecret('s3cret-value', 's3cret-value')).toBe(true);
  });

  it('rejects a wrong secret of the same length without throwing', () => {
    expect(verifyWebhookSecret('s3cret-valuX', 's3cret-value')).toBe(false);
  });

  it('rejects a shorter/longer candidate without throwing on length mismatch', () => {
    expect(verifyWebhookSecret('short', 's3cret-value')).toBe(false);
    expect(verifyWebhookSecret('s3cret-value-and-then-some', 's3cret-value')).toBe(false);
  });

  it('rejects empty, undefined, or null on either side', () => {
    expect(verifyWebhookSecret('', 's3cret-value')).toBe(false);
    expect(verifyWebhookSecret(undefined, 's3cret-value')).toBe(false);
    expect(verifyWebhookSecret(null, 's3cret-value')).toBe(false);
    expect(verifyWebhookSecret('s3cret-value', undefined)).toBe(false);
    expect(verifyWebhookSecret('s3cret-value', '')).toBe(false);
  });
});

// Firm-scoped variants power the in-app "Needs attention" surface (docs/archive/35 Phase
// 9). Same analyzers, firm added to the WHERE and bound as $2.
describe('firm-scoped analyzer variants', () => {
  function fake(rows: unknown[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const db = {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return { rows };
      },
    } as never;
    return { db, calls };
  }

  it('derived firm SQL adds exactly the firm clause to the cross-firm SQL', () => {
    expect(STALE_ENGAGEMENTS_FIRM_SQL).not.toBe(STALE_ENGAGEMENTS_SQL);
    expect(STALE_ENGAGEMENTS_FIRM_SQL).toContain('e.firm_id = $2');
    expect(STALLED_TASKS_FIRM_SQL).toContain('t.firm_id = $2');
    expect(REASSESSMENT_DUE_FIRM_SQL).toContain('e.firm_id = $2');
  });

  it('findStaleEngagements(firmId) uses the firm SQL and binds [days, firmId]', async () => {
    const { db, calls } = fake([]);
    await findStaleEngagements(db, { firmId: 'firm-7' });
    expect(calls[0].sql).toBe(STALE_ENGAGEMENTS_FIRM_SQL);
    expect(calls[0].params).toEqual([DEFAULT_STALE_DAYS, 'firm-7']);
  });

  it('findStalledTasks(firmId) uses the firm SQL and binds [days, firmId]', async () => {
    const { db, calls } = fake([]);
    await findStalledTasks(db, { firmId: 'firm-7', stalledDays: 10 });
    expect(calls[0].sql).toBe(STALLED_TASKS_FIRM_SQL);
    expect(calls[0].params).toEqual([10, 'firm-7']);
  });

  it('findReassessmentDue(firmId) uses the firm SQL and binds [days, firmId]', async () => {
    const { db, calls } = fake([]);
    await findReassessmentDue(db, { firmId: 'firm-7' });
    expect(calls[0].sql).toBe(REASSESSMENT_DUE_FIRM_SQL);
    expect(calls[0].params).toEqual([DEFAULT_REASSESS_DAYS, 'firm-7']);
  });

  it('without firmId, still uses the cross-firm SQL (webhook path unchanged)', async () => {
    const { db, calls } = fake([]);
    await findStaleEngagements(db);
    expect(calls[0].sql).toBe(STALE_ENGAGEMENTS_SQL);
    expect(calls[0].params).toEqual([DEFAULT_STALE_DAYS]);
  });
});
