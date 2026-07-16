// The container for the business ontology. The ontology itself is DATA
// (seed/ontology/business-ontology.json): a registry of node types and edge
// types with typed attributes. This module defines the shape that data conforms
// to, loads it, and validates graph nodes/edges against it. The full ontology
// from the prior repo ports in as more entries in the same JSON file — no code
// changes, per the "rubric lives in data" principle.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const attrType = z.enum(['string', 'number', 'boolean', 'date']);
export type AttrType = z.infer<typeof attrType>;

const attrDef = z.object({
  type: attrType,
  required: z.boolean().default(false),
  description: z.string().optional(),
});

const nodeTypeDef = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  attributes: z.record(attrDef).default({}),
});
export type NodeTypeDef = z.infer<typeof nodeTypeDef>;

const edgeTypeDef = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  from: z.array(z.string().min(1)).min(1), // allowed source node-type keys
  to: z.array(z.string().min(1)).min(1), // allowed target node-type keys
  attributes: z.record(attrDef).default({}),
});
export type EdgeTypeDef = z.infer<typeof edgeTypeDef>;

export const ontologyFileSchema = z.object({
  version: z.string().min(1),
  nodes: z.array(nodeTypeDef),
  edges: z.array(edgeTypeDef),
});
export type OntologyFile = z.infer<typeof ontologyFileSchema>;

// Turn an attribute-definition map into a zod object that validates a node's
// attributes JSONB. Unknown attributes pass through (permissive during porting);
// declared ones are type-checked and required ones must be present.
function attributesValidator(attrs: Record<string, z.infer<typeof attrDef>>) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [name, def] of Object.entries(attrs)) {
    let base: z.ZodTypeAny;
    switch (def.type) {
      case 'number':
        base = z.number();
        break;
      case 'boolean':
        base = z.boolean();
        break;
      default:
        base = z.string(); // string + date (ISO string)
    }
    shape[name] = def.required ? base : base.nullish();
  }
  return z.object(shape).passthrough();
}

export class OntologyRegistry {
  readonly version: string;
  private readonly nodes = new Map<string, NodeTypeDef>();
  private readonly edges = new Map<string, EdgeTypeDef>();
  private readonly nodeAttrValidators = new Map<string, z.ZodTypeAny>();
  private readonly edgeAttrValidators = new Map<string, z.ZodTypeAny>();

  constructor(file: OntologyFile) {
    this.version = file.version;
    for (const n of file.nodes) {
      if (this.nodes.has(n.key)) throw new Error(`ontology: duplicate node type ${n.key}`);
      this.nodes.set(n.key, n);
      this.nodeAttrValidators.set(n.key, attributesValidator(n.attributes));
    }
    for (const e of file.edges) {
      if (this.edges.has(e.key)) throw new Error(`ontology: duplicate edge type ${e.key}`);
      // Edge endpoints must reference known node types.
      for (const ref of [...e.from, ...e.to]) {
        if (!this.nodes.has(ref)) {
          throw new Error(`ontology: edge ${e.key} references unknown node type ${ref}`);
        }
      }
      this.edges.set(e.key, e);
      this.edgeAttrValidators.set(e.key, attributesValidator(e.attributes));
    }
  }

  hasNodeType(key: string): boolean {
    return this.nodes.has(key);
  }

  hasEdgeType(key: string): boolean {
    return this.edges.has(key);
  }

  nodeTypes(): NodeTypeDef[] {
    return [...this.nodes.values()];
  }

  edgeTypes(): EdgeTypeDef[] {
    return [...this.edges.values()];
  }

  // Validate a node's type + attributes. Returns the parsed attributes or throws.
  validateNode(nodeType: string, attributes: unknown): Record<string, unknown> {
    const validator = this.nodeAttrValidators.get(nodeType);
    if (!validator) throw new Error(`ontology: unknown node type ${nodeType}`);
    return validator.parse(attributes ?? {}) as Record<string, unknown>;
  }

  // Validate an edge's type, endpoint node types, and attributes.
  validateEdge(
    edgeType: string,
    fromNodeType: string,
    toNodeType: string,
    attributes: unknown,
  ): Record<string, unknown> {
    const def = this.edges.get(edgeType);
    if (!def) throw new Error(`ontology: unknown edge type ${edgeType}`);
    if (!def.from.includes(fromNodeType)) {
      throw new Error(
        `ontology: edge ${edgeType} cannot originate from ${fromNodeType} (allowed: ${def.from.join(', ')})`,
      );
    }
    if (!def.to.includes(toNodeType)) {
      throw new Error(
        `ontology: edge ${edgeType} cannot point to ${toNodeType} (allowed: ${def.to.join(', ')})`,
      );
    }
    const validator = this.edgeAttrValidators.get(edgeType)!;
    return validator.parse(attributes ?? {}) as Record<string, unknown>;
  }
}

const DEFAULT_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'seed',
  'ontology',
  'business-ontology.json',
);

export function loadOntology(path: string = DEFAULT_PATH): OntologyRegistry {
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const file = ontologyFileSchema.parse(raw);
  return new OntologyRegistry(file);
}
