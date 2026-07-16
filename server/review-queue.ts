// Review queue state machine + API. States: pending → in_review → resolved |
// escalated. Resolving a reconciliation item (conflict / low_confidence) writes
// the human-chosen verified_value + resolved_by back to assessment_values and
// unblocks any pipeline job parked on review. Resolving a finding_approval item
// approves or rejects the finding. Everything is firm-scoped; callers pass the
// service client after the router has authorized the item's engagement under RLS.
import type pg from 'pg';
import { engagementMetrics, type EngagementMetrics } from './pipeline/runner';

export interface ReviewItemRow {
  id: string;
  engagement_id: string;
  type: string;
  payload: Record<string, unknown>;
  status: string;
  assigned_to: string | null;
}

export async function listReviewItems(
  db: pg.ClientBase,
  engagementId: string,
  status?: string,
): Promise<ReviewItemRow[]> {
  const rows = await db.query(
    `select id, engagement_id, type, payload, status, assigned_to
       from review_items
      where engagement_id = $1 ${status ? 'and status = $2' : ''}
      order by created_at asc`,
    status ? [engagementId, status] : [engagementId],
  );
  return rows.rows as ReviewItemRow[];
}

async function loadItem(db: pg.ClientBase, itemId: string): Promise<ReviewItemRow> {
  const r = await db.query(
    `select id, engagement_id, type, payload, status, assigned_to, firm_id from review_items where id = $1`,
    [itemId],
  );
  if (r.rowCount !== 1) throw new Error('review item not found');
  return r.rows[0] as ReviewItemRow & { firm_id: string };
}

// Claim an item: pending → in_review, assigned to the caller. Idempotent if the
// caller already holds it; rejects if someone else is mid-review.
export async function claimReviewItem(
  db: pg.ClientBase,
  itemId: string,
  userId: string | null,
): Promise<ReviewItemRow> {
  const item = await loadItem(db, itemId);
  if (item.status === 'in_review' && item.assigned_to && item.assigned_to !== userId) {
    throw new Error('review item already claimed by another reviewer');
  }
  if (item.status === 'resolved') throw new Error('review item already resolved');
  const updated = await db.query(
    `update review_items set status = 'in_review', assigned_to = $2 where id = $1
     returning id, engagement_id, type, payload, status, assigned_to`,
    [itemId, userId],
  );
  return updated.rows[0] as ReviewItemRow;
}

export interface ResolveInput {
  // For conflict / low_confidence: the value the reviewer confirms as verified.
  verified_value?: unknown;
  // For finding_approval: whether to approve the finding.
  approve?: boolean;
  note?: string;
}

// Resolve an item. Writes the human decision, advances the item to resolved, and
// records who resolved it. Runs in a transaction so the side effects
// (assessment_values / findings write) commit atomically with the item.
export async function resolveReviewItem(
  db: pg.ClientBase,
  itemId: string,
  userId: string | null,
  input: ResolveInput,
): Promise<{ item: ReviewItemRow; unblockedJobs: number }> {
  const item = (await loadItem(db, itemId)) as ReviewItemRow & { firm_id: string };
  if (item.status === 'resolved') throw new Error('review item already resolved');

  await db.query('begin');
  try {
    let unblockedJobs = 0;
    if (item.type === 'conflict' || item.type === 'low_confidence_extraction') {
      const fieldKey = item.payload.field_key as string | undefined;
      if (!fieldKey) throw new Error('review item payload missing field_key');
      // The verified value the reviewer confirmed; default to the extracted value.
      const verified =
        input.verified_value !== undefined ? input.verified_value : item.payload.verified;
      await db.query(
        `update assessment_values
            set verified_value = $3, source = 'document_verified', resolved_by = $4
          where engagement_id = $1 and field_key = $2`,
        [item.engagement_id, fieldKey, JSON.stringify(verified ?? null), userId],
      );
      // Unblock any pipeline job parked on review for this engagement.
      const unblocked = await db.query(
        `update jobs set status = 'pending'
          where engagement_id = $1 and status = 'waiting_review'`,
        [item.engagement_id],
      );
      unblockedJobs = unblocked.rowCount ?? 0;
    } else if (item.type === 'finding_approval') {
      const findingId = item.payload.finding_id as string | undefined;
      if (!findingId) throw new Error('review item payload missing finding_id');
      const approve = input.approve !== false; // default approve
      await db.query(
        `update findings set status = $2, narrative_approved = $3 where id = $1`,
        [findingId, approve ? 'approved' : 'rejected', approve],
      );
    }

    const resolution = { ...input, resolved_type: item.type };
    const updated = await db.query(
      `update review_items
          set status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3
        where id = $1
        returning id, engagement_id, type, payload, status, assigned_to`,
      [itemId, userId, JSON.stringify(resolution)],
    );
    await db.query('commit');
    return { item: updated.rows[0] as ReviewItemRow, unblockedJobs };
  } catch (e) {
    await db.query('rollback').catch(() => {});
    throw e;
  }
}

// Escalate an item to a senior reviewer/advisor: → escalated. Terminal for the
// queue's automated flow; a human decides next.
export async function escalateReviewItem(
  db: pg.ClientBase,
  itemId: string,
  userId: string | null,
  note?: string,
): Promise<ReviewItemRow> {
  const item = await loadItem(db, itemId);
  if (item.status === 'resolved') throw new Error('review item already resolved');
  const updated = await db.query(
    `update review_items
        set status = 'escalated', assigned_to = $2, resolution = $3
      where id = $1
      returning id, engagement_id, type, payload, status, assigned_to`,
    [itemId, userId, JSON.stringify({ escalated: true, note: note ?? null })],
  );
  return updated.rows[0] as ReviewItemRow;
}

export async function reviewMetrics(
  db: pg.ClientBase,
  engagementId: string,
): Promise<EngagementMetrics> {
  return engagementMetrics(db, engagementId);
}
