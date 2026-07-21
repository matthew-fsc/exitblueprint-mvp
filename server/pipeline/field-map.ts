// The seam between flat extracted facts and the knowledge graph / assessment
// fields. A fact_key is structured `NodeType:entityId:attribute` (entityId
// 'self' for the singleton Company node). This module parses that, tells
// populate_graph which edge connects the Company to each node type, and maps
// selected facts to the assessment fields reconcile compares against.

export interface ParsedFactKey {
  nodeType: string;
  entityId: string;
  attribute: string;
}

// Parse `NodeType:entityId:attribute`. Returns null for keys that are not graph
// facts (they are still stored as document_fields, just not graphed).
export function parseFactKey(factKey: string): ParsedFactKey | null {
  const parts = factKey.split(':');
  if (parts.length !== 3) return null;
  const [nodeType, entityId, attribute] = parts;
  if (!nodeType || !entityId || !attribute) return null;
  return { nodeType, entityId, attribute };
}

// The edge that connects the singleton Company node to each node type. Keeps
// populate_graph deterministic where the ontology allows more than one edge
// between the same endpoints (e.g. Person via EMPLOYS vs DEPENDS_ON).
export const NODE_EDGE_FROM_COMPANY: Record<string, string> = {
  Customer: 'HAS_CUSTOMER',
  RevenueYear: 'HAS_REVENUE_YEAR',
  Person: 'EMPLOYS',
  Contract: 'PARTY_TO',
  Addback: 'CLAIMS_ADDBACK',
};

// How reconcile compares a self-reported answer against a document-verified fact.
// `number` runs the tolerance band (units/formatting normalized first); anything
// else falls back to a normalized string compare.
export type CompareType = 'number' | 'string';

// From a numeric_list answer (e.g. REV-ANNUAL is the last four fiscal years,
// oldest→newest) pick the single scalar the singleton fact represents. A P&L's
// extracted revenue_usd is the most recent year, so `last`.
export type ListSelect = 'last' | 'first' | 'max';

export interface FieldMapping {
  // The assessment_values.field_key this fact reconciles into (a stable label,
  // free text — NOT a questions FK).
  fieldKey: string;
  // The scored self-reported question code whose answer is compared against the
  // verified fact. null = extractable-only: the figure is captured for provenance
  // and findings, but the methodology has no scored self-reported counterpart to
  // reconcile it against, so it never conflicts.
  questionCode: string | null;
  compare: CompareType;
  // When the self-reported answer is a numeric_list, how to reduce it to the
  // scalar the fact represents. Ignored for scalar answers.
  listSelect?: ListSelect;
  // One-line rationale for the mapping (documentation, not used at runtime).
  note: string;
}

// Facts that reconcile compares against a self-reported answer. Keyed by the
// singleton Company fact_key (`Company:self:*`); per-entity facts (Customer share,
// per-year revenue) carry dynamic entity ids and are not statically mappable here.
// Question codes are drawn from the scored financial set and the P&L extractable
// set (server/pl-extract.ts EXTRACTABLE_CODES: REV-ANNUAL, REV-RECUR-PCT,
// REV-TOP5-SHARES) so a self-reported number and its verified counterpart line up.
export const ASSESSMENT_FIELD_MAP: Record<string, FieldMapping> = {
  // Annual revenue: REV-ANNUAL is the four-year series oldest→newest; the fact is
  // the most recent year, so compare against the last element. Extractable + scored.
  'Company:self:revenue_usd': {
    fieldKey: 'annual_revenue',
    questionCode: 'REV-ANNUAL',
    compare: 'number',
    listSelect: 'last',
    note: 'Most-recent annual revenue vs REV-ANNUAL series (last element).',
  },
  // EBITDA: extractable and used by findings/provenance, but the rubric has no
  // scored numeric EBITDA question (FIN-ADDBACK-DOC scores addback documentation,
  // not the figure), so there is no self-reported side to conflict with.
  'Company:self:ebitda_usd': {
    fieldKey: 'ebitda',
    questionCode: null,
    compare: 'number',
    note: 'Extractable-only: no scored numeric EBITDA question to reconcile against.',
  },
  // Recurring revenue share: REV-RECUR-PCT is a scalar percent and a P&L
  // extractable code. Percent normalization strips a trailing %. Extractable + scored.
  'Company:self:recurring_revenue_pct': {
    fieldKey: 'recurring_revenue_pct',
    questionCode: 'REV-RECUR-PCT',
    compare: 'number',
    note: 'Recurring-revenue percentage vs REV-RECUR-PCT (extractable code).',
  },
  // Net revenue retention: REV-NRR is a scalar percent (or "unknown"); numeric when
  // present, else the string fallback keeps "unknown" from spuriously conflicting.
  'Company:self:nrr_pct': {
    fieldKey: 'nrr_pct',
    questionCode: 'REV-NRR',
    compare: 'number',
    note: 'Net revenue retention vs REV-NRR (scored financial question).',
  },
  // Industry: a non-numeric identity check demonstrating the normalized string
  // fallback path (case/whitespace-insensitive). No scored question — descriptive.
  'Company:self:industry': {
    fieldKey: 'industry',
    questionCode: null,
    compare: 'string',
    note: 'Extractable-only descriptive field; exercises the string-compare fallback.',
  },
};

// Confidence at or above which reconcile auto-resolves a non-conflicting field;
// below it, the field is queued to review as low_confidence_extraction.
export const RECONCILE_AUTO_THRESHOLD = 0.8;

// Numeric agreement band. A self-reported and a verified figure agree when they
// differ by no more than max(absolute epsilon, relative fraction × larger value).
// The absolute floor absorbs sub-dollar rounding on small figures; the relative
// band (1%) absorbs extraction/rounding noise on large ones. Anything wider is a
// genuine conflict a human must reconcile.
export const RECONCILE_ABS_EPSILON = 1; // absolute units (e.g. $1)
export const RECONCILE_REL_TOLERANCE = 0.01; // 1% of the larger magnitude

export type CompareOutcome = 'match' | 'within_tolerance' | 'conflict';

// Normalize a stored value to a number for tolerance comparison. Accepts numbers
// and numeric strings, stripping $, commas, %, whitespace and treating (1,234) as
// -1234. Returns null when the value is not a single number (a label, a list, a
// blank, "unknown") — the caller then falls back to a string compare.
export function normalizeNumeric(raw: unknown): number | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  let s = raw.trim();
  if (s === '' || s === '-' || s === '—') return null;
  let negative = false;
  if (s.startsWith('(') && s.endsWith(')')) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[$,%\s]/g, '');
  if (!/^-?\d*\.?\d+$/.test(s)) return null;
  const n = Number(s);
  if (Number.isNaN(n)) return null;
  return negative ? -n : n;
}

// Normalize a value for the non-numeric equality fallback: JSON-scalarize,
// lowercase, collapse whitespace. Deterministic; no locale surprises.
function normalizeString(raw: unknown): string {
  if (raw === null || raw === undefined) return '';
  const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

// Classify a self-reported value against a verified value. `number` uses the
// tolerance band after unit normalization, but falls back to the string compare
// when either side is not a clean number (so "unknown" vs "unknown" matches
// instead of conflicting). Non-numeric fields always use the string compare.
// Pure and deterministic — no DB, no LLM. within_tolerance is treated as
// reconciled by the caller; only `conflict` queues a conflict review item.
export function compareValues(
  selfValue: unknown,
  verifiedValue: unknown,
  type: CompareType,
): CompareOutcome {
  if (type === 'number') {
    const a = normalizeNumeric(selfValue);
    const b = normalizeNumeric(verifiedValue);
    if (a !== null && b !== null) {
      const diff = Math.abs(a - b);
      if (diff === 0) return 'match';
      const band = Math.max(
        RECONCILE_ABS_EPSILON,
        RECONCILE_REL_TOLERANCE * Math.max(Math.abs(a), Math.abs(b)),
      );
      return diff <= band ? 'within_tolerance' : 'conflict';
    }
    // One side isn't a clean number → fall through to normalized string compare.
  }
  return normalizeString(selfValue) === normalizeString(verifiedValue) ? 'match' : 'conflict';
}

// Reduce a self-reported answer to the scalar a singleton fact compares against.
// Arrays are selected per `listSelect` (default last); scalars pass through.
export function selectSelfValue(answer: unknown, listSelect?: ListSelect): unknown {
  if (!Array.isArray(answer)) return answer;
  if (answer.length === 0) return undefined;
  switch (listSelect ?? 'last') {
    case 'first':
      return answer[0];
    case 'max': {
      const nums = answer.map((v) => normalizeNumeric(v)).filter((n): n is number => n !== null);
      return nums.length ? Math.max(...nums) : answer[answer.length - 1];
    }
    case 'last':
    default:
      return answer[answer.length - 1];
  }
}

// Coerce a stored string value to the type the ontology declares for an
// attribute. Parsers emit strings; the graph stores typed JSON.
export function coerceValue(raw: string | null, type: 'string' | 'number' | 'boolean'): unknown {
  if (raw === null) return null;
  if (type === 'number') {
    const n = Number(raw);
    if (Number.isNaN(n)) throw new Error(`expected number for value '${raw}'`);
    return n;
  }
  if (type === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}
