// Market-context retrieval (docs/sellside-ai/01-market-intelligence-rag.md,
// "Retrieval (the RAG proper)"). The read side of the reasoning lane: given an
// engagement's sector/size keys, return the top licensed passages — each carrying
// its citation — as an INPUT to the narrative payloads (buyer lens, CIM, diligence
// sim, valuation commentary), exactly the way `top_gaps` or `dimensions` are today.
//
// DETERMINISTIC PLUMBING — NO LLM IN THE LOOP (CLAUDE.md §1, §2). Retrieval is a
// plain SQL query (structured filter + Postgres full-text rank); the model is not in
// the retrieval loop and never computes or influences what is returned. It mirrors
// how buildInstitutionalReviewPayload assembles a read-only picture the model then
// narrates. The citation firewall downstream (docs/01 "citation contract") only lets
// a generated sentence quote a figure that was actually retrieved here.
//
// STRUCTURED + FULL-TEXT, pgvector DEFERRED. docs/01 sketches semantic embeddings
// over market.passages; CI runs stock postgres:16 with no vector extension, so this
// ships as structured filtering + full-text ranking (ts_rank / websearch_to_tsquery).
// Semantic embeddings are a documented follow-on behind this same function seam.
//
// NON-TENANT READ — NO FIRM FILTER (CLAUDE.md §5 non-tenant exception, docs/01 "Data
// model"). `market` is GLOBAL licensed reference data, not any firm's tenant data, so
// — unlike the firm-scoped ownBookMultiple (server/comparables.ts), which is STRICTLY
// `o.firm_id = $firmId` — there is no firm_id to filter on. The caller is already
// authorized on its engagement; the industry_key/size_band it passes were derived
// from that engagement's own data.
//
// LICENSE-EXPOSURE ENFORCEMENT (docs/01 "IP & licensing"). A paid dataset has terms,
// encoded on market.datasets.display_scope as an enforced flag, not reviewer memory.
// `exposure` is what the CALLER intends to do with the passage; a dataset only
// qualifies if its license PERMITS that use. Display is the most restrictive
// intent — a dataset licensed 'aggregate_only' can never be surfaced third-party —
// so the query drops any passage whose dataset does not license the requested use:
//   - 'aggregate_only'      (default): any dataset qualifies (every license permits aggregate use)
//   - 'row_level'                    : dataset must license row_level display  → display_scope in ('row_level','third_party_display')
//   - 'third_party_display'          : dataset must license third-party display → display_scope = 'third_party_display'
// This is the retrieval-layer enforcement the market schema's header comment defers
// to it (there is no RLS to do it, since there is no firm to isolate on).
import type pg from 'pg';

// Verbatim shape another agent depends on — do not change without coordinating.
export interface MarketPassage {
  body: string;
  cite_id: string;
  citation: string;
  dataset: string;
  as_of: string | null;
  kind: string;
}

export type MarketExposure = 'aggregate_only' | 'row_level' | 'third_party_display';

// display_scope values that satisfy a requested exposure (the license must permit
// the intended use). aggregate_only → any; stricter intents require a broader license.
const ALLOWED_SCOPES: Record<MarketExposure, string[] | null> = {
  aggregate_only: null, // any dataset qualifies
  row_level: ['row_level', 'third_party_display'],
  third_party_display: ['third_party_display'],
};

export async function retrieveMarketContext(
  db: pg.ClientBase,
  args: {
    industryKey: string;
    sizeBand?: string | null;
    exposure?: MarketExposure;
    query?: string;
    limit?: number;
  },
): Promise<{ passages: MarketPassage[] }> {
  const exposure = args.exposure ?? 'aggregate_only';
  const limit = args.limit ?? 6;
  const scopes = ALLOWED_SCOPES[exposure];

  const conds: string[] = ['p.industry_key = $1'];
  const params: unknown[] = [args.industryKey];

  // Size band: when given, match that band OR a band-agnostic passage (size_band
  // null); when omitted, no band constraint (null-tolerant either way).
  if (args.sizeBand != null) {
    params.push(args.sizeBand);
    conds.push(`(p.size_band = $${params.length} or p.size_band is null)`);
  }

  // License-exposure enforcement: drop passages whose dataset does not permit the
  // requested use. aggregate_only (scopes === null) imposes no constraint.
  if (scopes) {
    params.push(scopes);
    conds.push(`d.display_scope = any($${params.length}::text[])`);
  }

  // Ranking: full-text relevance when a query is given (deterministic ts_rank over
  // the generated search_tsv), else freshness (most recent as_of first).
  let order: string;
  if (args.query && args.query.trim() !== '') {
    params.push(args.query);
    order = `order by ts_rank(p.search_tsv, websearch_to_tsquery('english', $${params.length})) desc, p.as_of desc nulls last`;
  } else {
    order = 'order by p.as_of desc nulls last, p.created_at desc';
  }

  params.push(limit);
  const rows = (
    await db.query(
      `select p.body, p.cite_id, p.citation, d.name as dataset, p.as_of, p.kind
         from market.passages p
         join market.datasets d on d.id = p.dataset_id
        where ${conds.join(' and ')}
        ${order}
        limit $${params.length}`,
      params,
    )
  ).rows;

  const passages: MarketPassage[] = rows.map((r) => ({
    body: r.body as string,
    cite_id: r.cite_id as string,
    citation: r.citation as string,
    dataset: r.dataset as string,
    // Normalize to a YYYY-MM-DD string (or null) so the shape is stable regardless of
    // the driver's date parsing. node-postgres parses a `date` column into a
    // local-midnight Date, so format from its LOCAL parts (a UTC conversion could
    // shift the day); a string date passes through by its first 10 chars.
    as_of: formatDate(r.as_of),
    kind: r.kind as string,
  }));
  return { passages };
}

function formatDate(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    const y = value.getFullYear();
    const m = String(value.getMonth() + 1).padStart(2, '0');
    const d = String(value.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(value).slice(0, 10);
}
