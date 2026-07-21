// Pipeline step implementations. Steps intake → reconcile are implemented and
// idempotent; score → deliver are declared but throw NotImplementedError so the
// runner parks a job there until the slice that builds them lands. Each step is
// safe to re-run: it rebuilds its own outputs for the engagement rather than
// appending, so a retry or resume converges to the same state.
import { randomUUID } from 'node:crypto';
import type { PipelineStep } from '../../shared/intelligence/schemas';
import { extractionOutputSchema } from '../../shared/intelligence/schemas';
import { resolveParser, type ExtractedField } from '../documents/parser';
import {
  ASSESSMENT_FIELD_MAP,
  NODE_EDGE_FROM_COMPANY,
  RECONCILE_AUTO_THRESHOLD,
  coerceValue,
  compareValues,
  parseFactKey,
} from './field-map';
import { NotImplementedError, type StepContext, type StepFn, type StepResult } from './types';

// intake: validate the engagement and mint the extraction run id every later
// step scopes its writes to. Idempotent: reuses an existing run id on resume.
const intake: StepFn = async (ctx) => {
  const eng = await ctx.db.query(`select firm_id from engagements where id = $1`, [
    ctx.job.engagement_id,
  ]);
  if (eng.rowCount !== 1) throw new Error(`engagement ${ctx.job.engagement_id} not found`);
  const extractionRunId = (ctx.job.checkpoint.extraction_run_id as string) ?? randomUUID();
  return { checkpoint: { extraction_run_id: extractionRunId } };
};

// parse: run the ParserAdapter over each document's bytes and stash the raw
// fields in the checkpoint for extract to validate + persist. Updates the
// document row's parser/classification. No fact rows written here.
const parse: StepFn = async (ctx) => {
  const parser = resolveParser();
  const docs = await ctx.db.query(
    `select d.id, d.category, d.original_filename, d.mime_type, b.bytes
       from documents d join document_blobs b on b.document_id = d.id
      where d.engagement_id = $1 and d.status <> 'rejected'`,
    [ctx.job.engagement_id],
  );
  const parsed: Record<string, ExtractedField[]> = {};
  for (const d of docs.rows) {
    const result = await parser.parse({
      bytes: d.bytes as Buffer,
      mimeType: d.mime_type,
      filename: d.original_filename,
      category: d.category ?? null,
    });
    parsed[d.id] = result.fields;
    await ctx.db.query(
      `update documents set parser_name = $1, classification = $2, status = 'classified' where id = $3`,
      [result.parserName, result.classification, d.id],
    );
  }
  return { checkpoint: { parsed } };
};

// extract: validate the parsed fields with zod and persist them as document_fields
// (the extracted-facts substrate), scoped to this run's extraction_run_id.
const extract: StepFn = async (ctx) => {
  const runId = ctx.job.checkpoint.extraction_run_id as string;
  const parsed = (ctx.job.checkpoint.parsed as Record<string, ExtractedField[]>) ?? {};
  const firmId = ctx.job.firm_id;

  // Idempotent across runs: clear this engagement's prior pipeline-produced facts
  // (extraction_run_id not null), then re-insert. Beta manual-path fields
  // (extraction_run_id null) are left untouched.
  await ctx.db.query(
    `delete from document_fields
      where extraction_run_id is not null
        and document_id in (select id from documents where engagement_id = $1)`,
    [ctx.job.engagement_id],
  );

  let count = 0;
  for (const [documentId, fields] of Object.entries(parsed)) {
    // Validate the parser output as structured facts before persisting anything.
    const output = extractionOutputSchema.parse({
      facts: fields.map((f) => ({
        fact_key: f.fieldKey,
        fact_value: f.value,
        confidence: f.confidence ?? 1,
      })),
    });
    for (let i = 0; i < output.facts.length; i++) {
      const fact = output.facts[i];
      const field = fields[i];
      await ctx.db.query(
        `insert into document_fields
           (firm_id, document_id, field_key, value, verification_status, confidence,
            source_page, source_span, extraction_run_id)
         values ($1, $2, $3, $4, 'extracted', $5, $6, $7, $8)`,
        [
          firmId,
          documentId,
          fact.fact_key,
          field.value,
          fact.confidence,
          fact.source_page ?? null,
          fact.source_span ?? null,
          runId,
        ],
      );
      count++;
    }
  }
  return { checkpoint: { facts_extracted: count } };
};

// populate_graph: build nodes/edges from this run's facts per the ontology, and
// link each fact to the node it populated. Idempotent: the engagement's graph is
// rebuilt from scratch each run.
const populateGraph: StepFn = async (ctx) => {
  const runId = ctx.job.checkpoint.extraction_run_id as string;
  const engagementId = ctx.job.engagement_id;
  const firmId = ctx.job.firm_id;

  // Attribute-type lookup from the ontology, for coercing string values.
  const attrType = new Map<string, 'string' | 'number' | 'boolean'>();
  for (const nt of ctx.ontology.nodeTypes()) {
    for (const [attr, def] of Object.entries(nt.attributes)) {
      const t = def.type === 'number' ? 'number' : def.type === 'boolean' ? 'boolean' : 'string';
      attrType.set(`${nt.key}.${attr}`, t);
    }
  }

  // Rebuild the engagement's graph. node_id on document_fields is ON DELETE SET
  // NULL, so deleting nodes clears the fact->node links automatically.
  await ctx.db.query(`delete from graph_edges where engagement_id = $1`, [engagementId]);
  await ctx.db.query(`delete from graph_nodes where engagement_id = $1`, [engagementId]);

  const facts = await ctx.db.query(
    `select id, field_key, value from document_fields where extraction_run_id = $1`,
    [runId],
  );

  // Group graph facts by (nodeType, entityId); remember which fact ids fed each.
  interface Entity {
    nodeType: string;
    entityId: string;
    attributes: Record<string, unknown>;
    factIds: string[];
  }
  const entities = new Map<string, Entity>();
  for (const f of facts.rows) {
    const parsedKey = parseFactKey(f.field_key);
    if (!parsedKey) continue; // non-graph fact
    if (!ctx.ontology.hasNodeType(parsedKey.nodeType)) continue;
    const mapKey = `${parsedKey.nodeType}:${parsedKey.entityId}`;
    const entity =
      entities.get(mapKey) ??
      { nodeType: parsedKey.nodeType, entityId: parsedKey.entityId, attributes: {}, factIds: [] };
    const t = attrType.get(`${parsedKey.nodeType}.${parsedKey.attribute}`) ?? 'string';
    entity.attributes[parsedKey.attribute] = coerceValue(f.value, t);
    entity.factIds.push(f.id);
    entities.set(mapKey, entity);
  }

  // Company (the singleton subject) must exist before edges reference it.
  const nodeIds = new Map<string, string>();
  const ordered = [...entities.values()].sort((a, b) =>
    a.nodeType === 'Company' ? -1 : b.nodeType === 'Company' ? 1 : 0,
  );
  let companyNodeId: string | null = null;
  for (const entity of ordered) {
    const attrs = ctx.ontology.validateNode(entity.nodeType, entity.attributes);
    const inserted = await ctx.db.query(
      `insert into graph_nodes (firm_id, engagement_id, node_type, attributes)
       values ($1, $2, $3, $4) returning id`,
      [firmId, engagementId, entity.nodeType, JSON.stringify(attrs)],
    );
    const nodeId = inserted.rows[0].id as string;
    nodeIds.set(`${entity.nodeType}:${entity.entityId}`, nodeId);
    if (entity.nodeType === 'Company') companyNodeId = nodeId;
    // Provenance: point the source facts at the node they populated.
    await ctx.db.query(`update document_fields set node_id = $1 where id = any($2::uuid[])`, [
      nodeId,
      entity.factIds,
    ]);
  }

  // Connect every non-Company node to the Company via its declared edge.
  let edgeCount = 0;
  if (companyNodeId) {
    for (const entity of ordered) {
      if (entity.nodeType === 'Company') continue;
      const edgeType = NODE_EDGE_FROM_COMPANY[entity.nodeType];
      if (!edgeType) continue;
      const toNodeId = nodeIds.get(`${entity.nodeType}:${entity.entityId}`)!;
      const attrs = ctx.ontology.validateEdge(edgeType, 'Company', entity.nodeType, {});
      await ctx.db.query(
        `insert into graph_edges (firm_id, engagement_id, edge_type, from_node, to_node, attributes)
         values ($1, $2, $3, $4, $5, $6)`,
        [firmId, engagementId, edgeType, companyNodeId, toNodeId, JSON.stringify(attrs)],
      );
      edgeCount++;
    }
  }

  return { checkpoint: { nodes: nodeIds.size, edges: edgeCount } };
};

// reconcile: compare self-reported answers (from the checkpoint) against the
// document-verified facts, write assessment_values with provenance, auto-resolve
// confident agreements, and queue conflicts / low-confidence fields to review.
const reconcile: StepFn = async (ctx) => {
  const runId = ctx.job.checkpoint.extraction_run_id as string;
  const engagementId = ctx.job.engagement_id;
  const firmId = ctx.job.firm_id;
  const selfReported = (ctx.job.checkpoint.self_reported as Record<string, unknown>) ?? {};

  // Idempotent rebuild.
  await ctx.db.query(`delete from assessment_values where engagement_id = $1`, [engagementId]);
  await ctx.db.query(
    `delete from review_items
      where engagement_id = $1 and status = 'pending'
        and type in ('conflict', 'low_confidence_extraction')`,
    [engagementId],
  );

  let queued = 0;
  let autoResolved = 0;
  for (const [factKey, mapping] of Object.entries(ASSESSMENT_FIELD_MAP)) {
    const fieldKey = mapping.fieldKey;
    const factRow = await ctx.db.query(
      `select id, value, confidence from document_fields
        where extraction_run_id = $1 and field_key = $2
        order by created_at desc limit 1`,
      [runId, factKey],
    );
    if (factRow.rowCount === 0) continue;
    const fact = factRow.rows[0];
    const verifiedValue = fact.value as string | null;
    const confidence = fact.confidence === null ? null : Number(fact.confidence);
    const selfValue = factKey in selfReported ? selfReported[factKey] : undefined;
    const hasSelf = selfValue !== undefined && selfValue !== null;

    // Typed comparison with a numeric tolerance band (units normalized first);
    // non-numeric fields fall back to a normalized string compare. within_tolerance
    // counts as reconciled — only a genuine conflict marks the value conflicting.
    const outcome = hasSelf ? compareValues(selfValue, verifiedValue, mapping.compare) : 'match';
    const conflicting = outcome === 'conflict';
    const lowConfidence = confidence !== null && confidence < RECONCILE_AUTO_THRESHOLD;
    const source = conflicting ? 'conflicting' : 'document_verified';

    await ctx.db.query(
      `insert into assessment_values
         (firm_id, engagement_id, field_key, self_reported_value, verified_value, source,
          evidence_fact_id, confidence, resolved_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, null)
       on conflict (engagement_id, field_key) do update set
         self_reported_value = excluded.self_reported_value,
         verified_value = excluded.verified_value,
         source = excluded.source,
         evidence_fact_id = excluded.evidence_fact_id,
         confidence = excluded.confidence`,
      [
        firmId,
        engagementId,
        fieldKey,
        hasSelf ? JSON.stringify(selfValue) : null,
        verifiedValue === null ? null : JSON.stringify(verifiedValue),
        source,
        fact.id,
        confidence,
      ],
    );

    if (conflicting || lowConfidence) {
      const type = conflicting ? 'conflict' : 'low_confidence_extraction';
      await ctx.db.query(
        `insert into review_items (firm_id, engagement_id, type, payload)
         values ($1, $2, $3, $4)`,
        [
          firmId,
          engagementId,
          type,
          JSON.stringify({
            field_key: fieldKey,
            fact_key: factKey,
            self_reported: hasSelf ? selfValue : null,
            verified: verifiedValue,
            confidence,
            evidence_fact_id: fact.id,
          }),
        ],
      );
      queued++;
    } else {
      autoResolved++;
    }
  }
  return { checkpoint: { reconciled_auto: autoResolved, reconciled_queued: queued } };
};

// Declared but not yet implemented — later slices fill these in.
const notImplemented = (step: PipelineStep): StepFn => {
  return async () => {
    throw new NotImplementedError(step);
  };
};

export const STEP_HANDLERS: Record<PipelineStep, StepFn> = {
  intake,
  parse,
  extract,
  populate_graph: populateGraph,
  reconcile,
  score: notImplemented('score'),
  match_findings: notImplemented('match_findings'),
  assemble: notImplemented('assemble'),
  deliver: notImplemented('deliver'),
};

export type { StepResult };
