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

// Facts that reconcile compares against a self-reported answer. Maps a fact_key
// to the assessment field_key it verifies.
export const ASSESSMENT_FIELD_MAP: Record<string, string> = {
  'Company:self:revenue_usd': 'annual_revenue',
  'Company:self:ebitda_usd': 'ebitda',
};

// Confidence at or above which reconcile auto-resolves a non-conflicting field;
// below it, the field is queued to review as low_confidence_extraction.
export const RECONCILE_AUTO_THRESHOLD = 0.8;

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
