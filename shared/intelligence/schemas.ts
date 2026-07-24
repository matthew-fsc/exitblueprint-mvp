// Domain contracts for the sell-side intelligence layer, as zod schemas with
// inferred types. These are the validated shapes that cross a trust boundary:
// LLM extraction output, fact-to-graph payloads, reconciliation results, and
// pipeline job checkpoints. Table columns live in the migration; these describe
// the JSONB payloads and the structured outputs the pipeline validates.
import { z } from 'zod';

// A JSON value, for the JSONB columns (attributes, fact_value, payloads).
export type Json = string | number | boolean | null | Json[] | { [k: string]: Json };
export const jsonValue: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(jsonValue),
  ]),
);

// One fact pulled from a document. This is the schema the extract step validates
// LLM structured output against before anything is written to document_fields.
// confidence is 0..1; a fact below the reconcile threshold is queued to review.
export const extractedFactSchema = z.object({
  fact_key: z.string().min(1),
  fact_value: jsonValue,
  confidence: z.number().min(0).max(1),
  source_page: z.number().int().nonnegative().nullable().optional(),
  source_span: z.string().nullable().optional(),
  // Optional mapping hints consumed by populate_graph / reconcile.
  node_type: z.string().optional(),
  node_key: z.string().optional(), // stable key to dedupe/merge nodes within a run
  question_code: z.string().nullable().optional(),
});
export type ExtractedFact = z.infer<typeof extractedFactSchema>;

// The whole structured output of one extraction run over one document.
export const extractionOutputSchema = z.object({
  facts: z.array(extractedFactSchema),
});
export type ExtractionOutput = z.infer<typeof extractionOutputSchema>;

// One proposed answer candidate the extraction LLM returns (docs/sellside-ai
// WS-EXTRACT). This is the schema the extract step validates the model's output
// against before ANY candidate row is staged — a strict, values-only contract, so
// a malformed or prose-laden response is rejected rather than written. confidence
// is 0..1; question_code names an existing scored question; value is the proposed
// answer (JSON, values only); source_span is the excerpt it came from.
export const answerCandidateSchema = z.object({
  question_code: z.string().min(1),
  value: jsonValue,
  confidence: z.number().min(0).max(1),
  source_span: z.string().nullable().optional(),
});
export type AnswerCandidate = z.infer<typeof answerCandidateSchema>;

// The whole structured output of one answer-extraction run over one document.
export const answerCandidatesOutputSchema = z.object({
  candidates: z.array(answerCandidateSchema),
});
export type AnswerCandidatesOutput = z.infer<typeof answerCandidatesOutputSchema>;

export const valueSource = z.enum(['self_reported', 'document_verified', 'conflicting']);
export type ValueSource = z.infer<typeof valueSource>;

// A reconciled field: self-reported answer vs document-verified value, with the
// evidence fact that verified it and how it resolved.
export const assessmentValueSchema = z.object({
  field_key: z.string().min(1),
  self_reported_value: jsonValue.nullable(),
  verified_value: jsonValue.nullable(),
  source: valueSource,
  evidence_fact_id: z.string().uuid().nullable(),
  confidence: z.number().min(0).max(1).nullable(),
});
export type AssessmentValueInput = z.infer<typeof assessmentValueSchema>;

export const findingSeverity = z.enum(['low', 'medium', 'high', 'critical']);
export type FindingSeverity = z.infer<typeof findingSeverity>;

// Graph evidence a finding cites: the node and edge ids that matched the pattern.
export const graphEvidenceSchema = z.object({
  nodes: z.array(z.string().uuid()).default([]),
  edges: z.array(z.string().uuid()).default([]),
  // Numbers the matcher computed, echoed so the narrative can only cite these.
  facts: z.record(z.union([z.number(), z.string()])).default({}),
});
export type GraphEvidence = z.infer<typeof graphEvidenceSchema>;

export const findingDraftSchema = z.object({
  pattern_key: z.string().min(1),
  severity: findingSeverity,
  graph_evidence: graphEvidenceSchema,
});
export type FindingDraft = z.infer<typeof findingDraftSchema>;

// Pipeline step names, in run order. The runner drives a job through this list.
export const PIPELINE_STEPS = [
  'intake',
  'parse',
  'extract',
  'populate_graph',
  'reconcile',
  'score',
  'match_findings',
  'assemble',
  'deliver',
] as const;
export const pipelineStep = z.enum(PIPELINE_STEPS);
export type PipelineStep = z.infer<typeof pipelineStep>;

export const jobStatus = z.enum([
  'pending',
  'running',
  'waiting_review',
  'completed',
  'failed',
]);
export type JobStatus = z.infer<typeof jobStatus>;

// A job's resumable state. Steps read and write their own slice; the runner
// persists the whole object between steps so a retry resumes where it left off.
export const jobCheckpointSchema = z.record(jsonValue);
export type JobCheckpoint = z.infer<typeof jobCheckpointSchema>;
