// Continuous-evaluation webhook analyzers (docs/07 §"IN THE CODE"). An external
// n8n instance calls the authenticated webhook endpoints on a schedule; each one
// runs one of these read-only analyzers with a SERVICE-ROLE connection and turns
// the structured result into per-firm nudges. This is the mechanism behind
// "continuous evaluation" — the system asks "what changed / what went quiet?"
// instead of waiting for a calendar review.
//
// Trust model (CLAUDE.md rules 4 & 5): the caller is a TRUSTED SYSTEM CALLER
// (n8n) authenticated by a shared secret, NOT a per-user RLS path. The scan is
// deliberately cross-firm (service role, RLS bypassed), so every returned item
// carries its own firm_id and n8n routes the notification to the right firm.
// These functions ONLY READ AND REPORT. They never write a score, never mutate an
// immutable assessment (rule 4), and never fabricate data — a completed
// assessment is a snapshot; if a new one is due we surface that fact, we do not
// create one.
//
// Design note: the query strings and the row->item mappers are exported pure
// pieces so the shaping logic is unit-testable without a database (tests/scheduled.test.ts).
import crypto from 'node:crypto';
import type pg from 'pg';

// ---------------------------------------------------------------------------
// Tunable config. These are the continuous-evaluation cadence knobs — sensible
// defaults, overridable per call (n8n can pass its own via the webhook body /
// env). They are days.
// ---------------------------------------------------------------------------
export const DEFAULT_STALE_DAYS = 30; // engagement with no activity in this many days is "stale"
export const DEFAULT_STALLED_DAYS = 14; // an open task untouched this long is "stalled"
export const DEFAULT_REASSESS_DAYS = 90; // last completed assessment older than this → re-assess

// Minimal DB shape we depend on: a `query(sql, params)` returning `{ rows }`.
// Compatible with pg.ClientBase; the tests supply an in-memory fake.
type Db = Pick<pg.ClientBase, 'query'>;

// ---------------------------------------------------------------------------
// Shared result envelope. Every analyzer returns this exact shape so n8n can
// treat all three uniformly.
// ---------------------------------------------------------------------------
export interface AnalyzerResult<Item> {
  generatedAt: string; // ISO timestamp the scan ran
  thresholdDays: number; // the cadence threshold actually applied
  count: number; // items.length, for convenience
  items: Item[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Whole days between an ISO/Date value and `now` (floored, never negative).
function daysBetween(value: string | Date | null | undefined, now: Date): number {
  if (!value) return 0;
  const then = value instanceof Date ? value : new Date(value);
  const ms = now.getTime() - then.getTime();
  if (!Number.isFinite(ms) || ms < 0) return 0;
  return Math.floor(ms / 86_400_000);
}

function toIso(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ---------------------------------------------------------------------------
// 1) Stale engagements — active engagements with no recent activity.
//    "Activity" = the most recent assessment OR engagement-log entry; absent
//    either, the engagement's own start. Anything quieter than staleDays is a
//    nudge candidate.
// ---------------------------------------------------------------------------

export interface StaleEngagementRow {
  engagement_id: string;
  firm_id: string;
  company_id: string;
  company_name: string | null;
  owner_contact_name: string | null;
  owner_contact_email: string | null;
  engagement_status: string;
  started_at: string | Date;
  last_assessment_at: string | Date | null;
  last_log_at: string | Date | null;
  last_activity_at: string | Date;
  assessment_count: string | number;
}

export interface StaleEngagementItem {
  firmId: string;
  engagementId: string;
  companyId: string;
  companyName: string | null;
  ownerContactName: string | null;
  ownerContactEmail: string | null;
  status: string;
  lastActivityAt: string | null;
  lastAssessmentAt: string | null;
  assessmentCount: number;
  daysStale: number;
}

// The scan is cross-firm; the $1 threshold is bound as a plain integer count of
// days so the interval is computed in-DB (`now() - $1 * interval '1 day'`).
export const STALE_ENGAGEMENTS_SQL = `
  select
    e.id as engagement_id,
    e.firm_id,
    e.company_id,
    c.name as company_name,
    c.owner_contact_name,
    c.owner_contact_email,
    e.status as engagement_status,
    e.started_at,
    max(a.created_at) as last_assessment_at,
    max(l.created_at) as last_log_at,
    greatest(
      e.started_at,
      coalesce(max(a.created_at), e.started_at),
      coalesce(max(l.created_at), e.started_at)
    ) as last_activity_at,
    count(distinct a.id) as assessment_count
  from engagements e
  join companies c on c.id = e.company_id
  left join assessments a on a.engagement_id = e.id
  left join engagement_log l on l.engagement_id = e.id
  where e.status = 'active'
  group by e.id, e.firm_id, e.company_id, c.name, c.owner_contact_name,
           c.owner_contact_email, e.status, e.started_at
  having greatest(
           e.started_at,
           coalesce(max(a.created_at), e.started_at),
           coalesce(max(l.created_at), e.started_at)
         ) < now() - ($1::int * interval '1 day')
  order by last_activity_at asc
`;

// Firm-scoped variant, derived from the cross-firm SQL so it can never drift:
// the same query with the caller's firm added to the WHERE, bound as $2. Used by
// the in-app "Needs attention" surface (server/attention.ts); the webhook path
// keeps using the unfiltered cross-firm query above.
export const STALE_ENGAGEMENTS_FIRM_SQL = STALE_ENGAGEMENTS_SQL.replace(
  `where e.status = 'active'`,
  `where e.status = 'active' and e.firm_id = $2`,
);

export function mapStaleEngagementRow(row: StaleEngagementRow, now: Date): StaleEngagementItem {
  return {
    firmId: row.firm_id,
    engagementId: row.engagement_id,
    companyId: row.company_id,
    companyName: row.company_name,
    ownerContactName: row.owner_contact_name,
    ownerContactEmail: row.owner_contact_email,
    status: row.engagement_status,
    lastActivityAt: toIso(row.last_activity_at),
    lastAssessmentAt: toIso(row.last_assessment_at),
    assessmentCount: Number(row.assessment_count) || 0,
    daysStale: daysBetween(row.last_activity_at, now),
  };
}

export async function findStaleEngagements(
  db: Db,
  opts: { staleDays?: number; firmId?: string } = {},
): Promise<AnalyzerResult<StaleEngagementItem>> {
  const thresholdDays = opts.staleDays ?? DEFAULT_STALE_DAYS;
  const now = new Date();
  const { rows } = opts.firmId
    ? await db.query(STALE_ENGAGEMENTS_FIRM_SQL, [thresholdDays, opts.firmId])
    : await db.query(STALE_ENGAGEMENTS_SQL, [thresholdDays]);
  const items = (rows as StaleEngagementRow[]).map((r) => mapStaleEngagementRow(r, now));
  return { generatedAt: now.toISOString(), thresholdDays, count: items.length, items };
}

// ---------------------------------------------------------------------------
// 2) Stalled tasks — open roadmap tasks that have gone quiet or slipped past
//    due. `tasks` has no updated_at column, so "untouched" is measured from
//    created_at; "past due" uses due_date. Either condition qualifies.
// ---------------------------------------------------------------------------

export interface StalledTaskRow {
  task_id: string;
  firm_id: string;
  engagement_id: string;
  company_id: string;
  company_name: string | null;
  owner_contact_name: string | null;
  title: string;
  status: string;
  owner_role: string;
  assigned_to_name: string | null;
  due_date: string | Date | null;
  created_at: string | Date;
  past_due: boolean;
}

export interface StalledTaskItem {
  firmId: string;
  taskId: string;
  engagementId: string;
  companyId: string;
  companyName: string | null;
  ownerContactName: string | null;
  title: string;
  status: string;
  ownerRole: string;
  assignedToName: string | null;
  dueDate: string | null;
  createdAt: string | null;
  pastDue: boolean;
  daysStalled: number; // whole days since created_at
  daysOverdue: number; // whole days past due_date (0 if not past due)
}

export const STALLED_TASKS_SQL = `
  select
    t.id as task_id,
    t.firm_id,
    t.engagement_id,
    e.company_id,
    c.name as company_name,
    c.owner_contact_name,
    t.title,
    t.status,
    t.owner_role,
    t.assigned_to_name,
    t.due_date,
    t.created_at,
    (t.due_date is not null and t.due_date < current_date) as past_due
  from tasks t
  join engagements e on e.id = t.engagement_id
  join companies c on c.id = e.company_id
  where t.status <> 'done'
    and (
      t.created_at < now() - ($1::int * interval '1 day')
      or (t.due_date is not null and t.due_date < current_date)
    )
  order by t.due_date asc nulls last, t.created_at asc
`;

// Firm-scoped variant (see STALE_ENGAGEMENTS_FIRM_SQL): the task filter is on
// t.firm_id, added as $2.
export const STALLED_TASKS_FIRM_SQL = STALLED_TASKS_SQL.replace(
  `where t.status <> 'done'`,
  `where t.status <> 'done'\n    and t.firm_id = $2`,
);

export function mapStalledTaskRow(row: StalledTaskRow, now: Date): StalledTaskItem {
  const pastDue = row.past_due === true;
  return {
    firmId: row.firm_id,
    taskId: row.task_id,
    engagementId: row.engagement_id,
    companyId: row.company_id,
    companyName: row.company_name,
    ownerContactName: row.owner_contact_name,
    title: row.title,
    status: row.status,
    ownerRole: row.owner_role,
    assignedToName: row.assigned_to_name,
    dueDate: toIso(row.due_date),
    createdAt: toIso(row.created_at),
    pastDue,
    daysStalled: daysBetween(row.created_at, now),
    daysOverdue: pastDue ? daysBetween(row.due_date, now) : 0,
  };
}

export async function findStalledTasks(
  db: Db,
  opts: { stalledDays?: number; firmId?: string } = {},
): Promise<AnalyzerResult<StalledTaskItem>> {
  const thresholdDays = opts.stalledDays ?? DEFAULT_STALLED_DAYS;
  const now = new Date();
  const { rows } = opts.firmId
    ? await db.query(STALLED_TASKS_FIRM_SQL, [thresholdDays, opts.firmId])
    : await db.query(STALLED_TASKS_SQL, [thresholdDays]);
  const items = (rows as StalledTaskRow[]).map((r) => mapStalledTaskRow(r, now));
  return { generatedAt: now.toISOString(), thresholdDays, count: items.length, items };
}

// ---------------------------------------------------------------------------
// 3) Reassessment due — active engagements whose most recent COMPLETED
//    assessment is older than the cadence window. We only look at completed
//    assessments (an in-progress one isn't a measurement yet). Engagements that
//    have never completed one are the stale-engagement concern, not this one.
// ---------------------------------------------------------------------------

export interface ReassessmentDueRow {
  engagement_id: string;
  firm_id: string;
  company_id: string;
  company_name: string | null;
  owner_contact_name: string | null;
  owner_contact_email: string | null;
  last_completed_at: string | Date;
  last_sequence_number: string | number;
  completed_count: string | number;
}

export interface ReassessmentDueItem {
  firmId: string;
  engagementId: string;
  companyId: string;
  companyName: string | null;
  ownerContactName: string | null;
  ownerContactEmail: string | null;
  lastCompletedAt: string | null;
  lastSequenceNumber: number;
  completedCount: number;
  daysSinceLastAssessment: number;
}

export const REASSESSMENT_DUE_SQL = `
  select
    e.id as engagement_id,
    e.firm_id,
    e.company_id,
    c.name as company_name,
    c.owner_contact_name,
    c.owner_contact_email,
    max(a.completed_at) as last_completed_at,
    max(a.sequence_number) as last_sequence_number,
    count(a.id) as completed_count
  from engagements e
  join companies c on c.id = e.company_id
  join assessments a
    on a.engagement_id = e.id
   and a.status = 'completed'
   and a.completed_at is not null
  where e.status = 'active'
  group by e.id, e.firm_id, e.company_id, c.name, c.owner_contact_name, c.owner_contact_email
  having max(a.completed_at) < now() - ($1::int * interval '1 day')
  order by last_completed_at asc
`;

// Firm-scoped variant (see STALE_ENGAGEMENTS_FIRM_SQL): firm added on e.firm_id
// as $2.
export const REASSESSMENT_DUE_FIRM_SQL = REASSESSMENT_DUE_SQL.replace(
  `where e.status = 'active'`,
  `where e.status = 'active' and e.firm_id = $2`,
);

export function mapReassessmentDueRow(row: ReassessmentDueRow, now: Date): ReassessmentDueItem {
  return {
    firmId: row.firm_id,
    engagementId: row.engagement_id,
    companyId: row.company_id,
    companyName: row.company_name,
    ownerContactName: row.owner_contact_name,
    ownerContactEmail: row.owner_contact_email,
    lastCompletedAt: toIso(row.last_completed_at),
    lastSequenceNumber: Number(row.last_sequence_number) || 0,
    completedCount: Number(row.completed_count) || 0,
    daysSinceLastAssessment: daysBetween(row.last_completed_at, now),
  };
}

export async function findReassessmentDue(
  db: Db,
  opts: { reassessDays?: number; firmId?: string } = {},
): Promise<AnalyzerResult<ReassessmentDueItem>> {
  const thresholdDays = opts.reassessDays ?? DEFAULT_REASSESS_DAYS;
  const now = new Date();
  const { rows } = opts.firmId
    ? await db.query(REASSESSMENT_DUE_FIRM_SQL, [thresholdDays, opts.firmId])
    : await db.query(REASSESSMENT_DUE_SQL, [thresholdDays]);
  const items = (rows as ReassessmentDueRow[]).map((r) => mapReassessmentDueRow(r, now));
  return { generatedAt: now.toISOString(), thresholdDays, count: items.length, items };
}

// ---------------------------------------------------------------------------
// Shared-secret auth for the webhook routes. n8n sends the secret in a header;
// http.ts compares it against WEBHOOK_SECRET with this constant-time helper.
//
// Constant-time is only meaningful for equal-length buffers — timingSafeEqual
// THROWS on a length mismatch — so we length-guard first and return false. That
// short-circuit does leak whether the lengths match, but the secret's length is
// not itself the secret; the value is what must not leak, and equal-length
// candidates are compared in constant time.
// ---------------------------------------------------------------------------
export function verifyWebhookSecret(
  provided: string | undefined | null,
  expected: string | undefined | null,
): boolean {
  if (!provided || !expected) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
