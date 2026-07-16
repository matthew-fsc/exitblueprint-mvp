// Eval harness skeleton for extraction accuracy. A golden case is a document in
// (the fixture parser's JSON) and the expected extracted_facts out. The runner
// parses the document, compares produced facts to expected per field_key, and
// scores accuracy. A CI script (ci.ts) fails the build when accuracy regresses
// below tolerance. When a real parser/LLM adapter lands, the same golden cases
// score it — only EB_PARSER changes.
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FixtureParserAdapter } from '../../documents/parser';

export interface GoldenCase {
  name: string;
  docPath: string;
  expectedPath: string;
}

export interface FieldResult {
  fact_key: string;
  expected: unknown;
  actual: unknown;
  match: boolean;
}

export interface CaseScore {
  name: string;
  total: number;
  matched: number;
  accuracy: number;
  mismatches: FieldResult[];
}

export async function scoreCase(c: GoldenCase): Promise<CaseScore> {
  const parser = new FixtureParserAdapter();
  const bytes = readFileSync(c.docPath);
  const parsed = await parser.parse({
    bytes,
    mimeType: 'application/json',
    filename: c.name,
    category: null,
  });
  const actual = new Map(parsed.fields.map((f) => [f.fieldKey, f.value]));

  const expected = JSON.parse(readFileSync(c.expectedPath, 'utf8')) as {
    facts: { fact_key: string; fact_value: unknown }[];
  };

  const results: FieldResult[] = expected.facts.map((e) => {
    const got = actual.get(e.fact_key);
    return {
      fact_key: e.fact_key,
      expected: e.fact_value,
      actual: got,
      match: String(got) === String(e.fact_value),
    };
  });
  const matched = results.filter((r) => r.match).length;
  return {
    name: c.name,
    total: results.length,
    matched,
    accuracy: results.length === 0 ? 1 : matched / results.length,
    mismatches: results.filter((r) => !r.match),
  };
}

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'fixtures', 'sellside');

// The registered golden cases. Add a case = drop a doc + expected pair here.
export const GOLDEN_CASES: GoldenCase[] = [
  {
    name: 'customer-financials',
    docPath: join(fixturesDir, 'customer-financials.doc.json'),
    expectedPath: join(fixturesDir, 'customer-financials.expected.json'),
  },
];

export async function runAll(): Promise<CaseScore[]> {
  return Promise.all(GOLDEN_CASES.map(scoreCase));
}
