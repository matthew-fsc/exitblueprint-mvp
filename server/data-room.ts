// Data Room Readiness (docs/15, work stream B). Turns the buyer's diligence
// request list into the client's pre-built checklist: a canonical, versioned
// template (global methodology, seeded) plus a per-engagement readiness state
// per item. Deterministic and LLM-free — nothing here computes or writes a score
// (rule 2). An item that maps to a scored gap carries that gap's code, so the
// data room and the gap taxonomy are one taxonomy (docs/15 decision 4).
import type pg from 'pg';
import { uploadDocument } from './documents/pipeline';

// Documents uploaded against a data room item are tagged with this category
// prefix, so the parse/extract pipeline (and the review queue) can key off the
// specific diligence item the file answers.
export const DATA_ROOM_CATEGORY_PREFIX = 'data_room:';

const STATES = ['not_started', 'in_progress', 'ready', 'gap', 'not_applicable'] as const;
export type DataRoomState = (typeof STATES)[number];

export interface DataRoomSection {
  code: string;
  name: string;
  description: string | null;
  sort_order: number;
}

export interface DataRoomItemState {
  section_code: string;
  item_code: string;
  label: string;
  description: string | null;
  buyer_rationale: string | null;
  applies_to: string;
  gap_code: string | null;
  sort_order: number;
  readiness_state: DataRoomState;
  note: string | null;
  document_id: string | null;
  document_filename: string | null;
  document_status: string | null;
  updated_at: string | null;
}

export interface DataRoomView {
  sections: DataRoomSection[];
  items: DataRoomItemState[];
  summary: {
    total: number;
    ready: number;
    in_progress: number;
    gap: number;
    not_started: number;
    not_applicable: number;
    /** Ready as a share of items that are in scope (not marked N/A), 0–100. */
    readiness_pct: number;
  };
}

/**
 * The template plus this engagement's current state per item. Items with no
 * saved state default to 'not_started' via the left join. Ordered by section
 * then item sort order so the UI can render sections in buyer-list order.
 */
export async function listDataRoom(db: pg.ClientBase, engagementId: string): Promise<DataRoomView> {
  const sections = (
    await db.query(
      `select code, name, description, sort_order from data_room_sections order by sort_order, code`,
    )
  ).rows as DataRoomSection[];

  const items = (
    await db.query(
      `select i.section_code, i.code as item_code, i.label, i.description, i.buyer_rationale,
              i.applies_to, i.gap_code, i.sort_order,
              coalesce(e.readiness_state::text, 'not_started') as readiness_state,
              e.note, e.document_id, d.original_filename as document_filename,
              d.status::text as document_status, e.updated_at
       from data_room_items i
       left join engagement_data_room_items e
         on e.item_code = i.code and e.engagement_id = $1
       left join documents d on d.id = e.document_id
       order by i.sort_order, i.code`,
      [engagementId],
    )
  ).rows as DataRoomItemState[];

  const count = (s: DataRoomState) => items.filter((i) => i.readiness_state === s).length;
  const ready = count('ready');
  const inScope = items.length - count('not_applicable');
  const summary = {
    total: items.length,
    ready,
    in_progress: count('in_progress'),
    gap: count('gap'),
    not_started: count('not_started'),
    not_applicable: count('not_applicable'),
    readiness_pct: inScope === 0 ? 0 : Math.round((ready / inScope) * 100),
  };
  return { sections, items, summary };
}

export interface SetDataRoomItemInput {
  engagementId: string;
  itemCode: string;
  readinessState: string;
  note?: string | null;
  documentId?: string | null;
  updatedBy: string | null;
}

/**
 * Upsert one item's readiness for an engagement. The caller has already been
 * authorized to see the engagement (functions.ts), so the engagement id is
 * trusted here; firm_id is resolved from it (never taken from the body). A
 * linked document, if provided, must belong to the same engagement.
 */
export async function setDataRoomItem(
  db: pg.ClientBase,
  input: SetDataRoomItemInput,
): Promise<DataRoomItemState> {
  const { engagementId, itemCode, readinessState, note, documentId, updatedBy } = input;

  if (!STATES.includes(readinessState as DataRoomState)) {
    throw new Error(`invalid readiness_state '${readinessState}'`);
  }
  const firmId = (await db.query(`select firm_id from engagements where id = $1`, [engagementId]))
    .rows[0]?.firm_id as string | undefined;
  if (!firmId) throw new Error('engagement not found');

  const itemExists =
    (await db.query(`select 1 from data_room_items where code = $1`, [itemCode])).rowCount === 1;
  if (!itemExists) throw new Error(`unknown data room item '${itemCode}'`);

  if (documentId) {
    const docOk =
      (
        await db.query(`select 1 from documents where id = $1 and engagement_id = $2`, [
          documentId,
          engagementId,
        ])
      ).rowCount === 1;
    if (!docOk) throw new Error('document does not belong to this engagement');
  }

  const row = (
    await db.query(
      `insert into engagement_data_room_items
         (firm_id, engagement_id, item_code, readiness_state, note, document_id, updated_by, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, now())
       on conflict (engagement_id, item_code) do update
         set readiness_state = excluded.readiness_state, note = excluded.note,
             document_id = excluded.document_id, updated_by = excluded.updated_by,
             updated_at = now()
       returning item_code, readiness_state, note, document_id, updated_at`,
      [firmId, engagementId, itemCode, readinessState, note ?? null, documentId ?? null, updatedBy],
    )
  ).rows[0];

  // Return the full item shape (template fields + fresh state) so the client can
  // update in place without a refetch.
  const full = (
    await db.query(
      `select i.section_code, i.code as item_code, i.label, i.description, i.buyer_rationale,
              i.applies_to, i.gap_code, i.sort_order,
              $2::text as readiness_state, $3::text as note, $4::uuid as document_id,
              d.original_filename as document_filename, d.status::text as document_status,
              $5::timestamptz as updated_at
       from data_room_items i
       left join documents d on d.id = $4::uuid
       where i.code = $1`,
      [itemCode, row.readiness_state, row.note, row.document_id, row.updated_at],
    )
  ).rows[0] as DataRoomItemState;
  return full;
}

export interface AttachDataRoomDocumentInput {
  engagementId: string;
  itemCode: string;
  filename: string;
  mimeType: string;
  contentBase64: string;
  actorProfileId: string | null;
}

/**
 * Upload a document and tag it to a data room item. The file runs through the
 * normal ingest pipeline (scan → classify → extract → review queue) with a
 * category of `data_room:<item_code>`, so parsing knows which diligence item it
 * answers; the item is linked to the document and, if still untouched, advanced
 * to 'in_progress'. The caller is already authorized on the engagement; firm_id
 * is resolved from it, never the body.
 */
export async function attachDataRoomDocument(
  db: pg.ClientBase,
  input: AttachDataRoomDocumentInput,
): Promise<{ item: DataRoomItemState; document_id: string; document_status: string }> {
  const { engagementId, itemCode, filename, mimeType, contentBase64, actorProfileId } = input;

  const firmId = (await db.query(`select firm_id from engagements where id = $1`, [engagementId]))
    .rows[0]?.firm_id as string | undefined;
  if (!firmId) throw new Error('engagement not found');

  const itemExists =
    (await db.query(`select 1 from data_room_items where code = $1`, [itemCode])).rowCount === 1;
  if (!itemExists) throw new Error(`unknown data room item '${itemCode}'`);

  const uploaded = await uploadDocument(db, firmId, actorProfileId, {
    engagement_id: engagementId,
    category: `${DATA_ROOM_CATEGORY_PREFIX}${itemCode}`,
    filename,
    mime_type: mimeType,
    content_base64: contentBase64,
  });

  // Link the document and advance an untouched item to in_progress (leave any
  // explicit state — ready/gap/not_applicable — as the advisor set it).
  await db.query(
    `insert into engagement_data_room_items
       (firm_id, engagement_id, item_code, readiness_state, document_id, updated_by, updated_at)
     values ($1, $2, $3, 'in_progress', $4, $5, now())
     on conflict (engagement_id, item_code) do update
       set document_id = excluded.document_id, updated_by = excluded.updated_by, updated_at = now(),
           readiness_state = case
             when engagement_data_room_items.readiness_state = 'not_started' then 'in_progress'::data_room_state
             else engagement_data_room_items.readiness_state end`,
    [firmId, engagementId, itemCode, uploaded.document_id, actorProfileId],
  );

  const item = (
    await db.query(
      `select i.section_code, i.code as item_code, i.label, i.description, i.buyer_rationale,
              i.applies_to, i.gap_code, i.sort_order,
              e.readiness_state::text as readiness_state, e.note, e.document_id,
              d.original_filename as document_filename, d.status::text as document_status, e.updated_at
       from data_room_items i
       join engagement_data_room_items e on e.item_code = i.code and e.engagement_id = $1
       left join documents d on d.id = e.document_id
       where i.code = $2`,
      [engagementId, itemCode],
    )
  ).rows[0] as DataRoomItemState;

  return { item, document_id: uploaded.document_id, document_status: uploaded.status };
}
