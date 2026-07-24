// Pure unit tests for the sell-side intelligence layer: ontology registry,
// domain schemas, the LLM client wrapper (fake transport, no network/DB), the
// findings narrative guard, and the eval harness. No database required.
import { describe, expect, it } from 'vitest';
import { loadOntology, OntologyRegistry } from '../server/ontology/registry';
import { extractionOutputSchema } from '../shared/intelligence/schemas';
import { LlmClient, costUsd, type LlmTransport } from '../server/llm/client';
import { checkNarrativeNumbers } from '../server/findings/patterns';
import { runAll } from '../server/llm/evals/runner';

describe('ontology registry', () => {
  const reg = loadOntology();

  it('validates a well-formed node', () => {
    expect(() => reg.validateNode('Company', { name: 'Acme', revenue_usd: 100 })).not.toThrow();
  });

  it('rejects an unknown node type', () => {
    expect(() => reg.validateNode('Nope', {})).toThrow(/unknown node type/);
  });

  it('rejects a wrong attribute type', () => {
    expect(() => reg.validateNode('RevenueYear', { year: 'not-a-number', revenue_usd: 1 })).toThrow();
  });

  it('validates an edge and its endpoints', () => {
    expect(() => reg.validateEdge('HAS_CUSTOMER', 'Company', 'Customer', {})).not.toThrow();
    expect(() => reg.validateEdge('HAS_CUSTOMER', 'Customer', 'Company', {})).toThrow(/cannot originate/);
  });

  it('rejects an edge whose endpoint node type is unknown at load', () => {
    expect(
      () =>
        new OntologyRegistry({
          version: 't',
          nodes: [{ key: 'A', label: 'A', attributes: {} }],
          edges: [{ key: 'E', label: 'E', from: ['A'], to: ['B'], attributes: {} }],
        }),
    ).toThrow(/unknown node type B/);
  });
});

describe('extraction schema', () => {
  it('accepts valid facts', () => {
    const out = extractionOutputSchema.parse({
      facts: [{ fact_key: 'Company:self:name', fact_value: 'Acme', confidence: 0.9 }],
    });
    expect(out.facts).toHaveLength(1);
  });

  it('rejects out-of-range confidence', () => {
    expect(() =>
      extractionOutputSchema.parse({
        facts: [{ fact_key: 'k', fact_value: 1, confidence: 1.5 }],
      }),
    ).toThrow();
  });
});

describe('llm client', () => {
  it('computes cost from token usage', () => {
    const cost = costUsd('claude-opus-4-8', { input_tokens: 1_000_000, output_tokens: 1_000_000 });
    expect(cost).toBeCloseTo(90, 5); // 15 + 75 per million
  });

  it('renders the registered prompt and returns cost + latency', async () => {
    let seenUser = '';
    // Report a PAID model so cost>0 stays a meaningful signal: the extract prompt now
    // routes to the free economy tier (server/llm/models.ts, priced $0); this test is
    // about the client computing/returning cost + latency, not extraction's tier.
    const transport: LlmTransport = async (req) => {
      seenUser = req.user;
      return { text: 'ok', model: 'claude-opus-4-8', usage: { input_tokens: 10, output_tokens: 5 } };
    };
    const client = new LlmClient({ transport });
    const res = await client.call({
      promptKey: 'extract.financials.v1',
      vars: { documentText: 'REV 100', category: 'financial_statement' },
    });
    expect(seenUser).toContain('REV 100');
    expect(res.text).toBe('ok');
    expect(res.cost_usd).toBeGreaterThan(0);
    expect(res.latency_ms).toBeGreaterThanOrEqual(0);
  });

  it('retries a transient error then succeeds', async () => {
    let calls = 0;
    const transport: LlmTransport = async (req) => {
      calls++;
      if (calls === 1) {
        const err = new Error('rate limited') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return { text: 'recovered', model: req.model, usage: { input_tokens: 1, output_tokens: 1 } };
    };
    const client = new LlmClient({ transport });
    const res = await client.call({ promptKey: 'extract.financials.v1', vars: { documentText: '', category: '' } });
    expect(calls).toBe(2);
    expect(res.text).toBe('recovered');
  });

  it('does not retry a non-transient error', async () => {
    let calls = 0;
    const transport: LlmTransport = async () => {
      calls++;
      const err = new Error('bad request') as Error & { status: number };
      err.status = 400;
      throw err;
    };
    const client = new LlmClient({ transport });
    await expect(
      client.call({ promptKey: 'extract.financials.v1', vars: { documentText: '', category: '' } }),
    ).rejects.toThrow(/bad request/);
    expect(calls).toBe(1);
  });
});

describe('finding narrative guard', () => {
  const evidence = { nodes: [], edges: [], facts: { top_customer_pct: 0.32, top_customer_name: 'Acme' } };

  it('allows numbers backed by evidence (incl percent form)', () => {
    expect(checkNarrativeNumbers('The top customer is 32% of revenue.', evidence).ok).toBe(true);
  });

  it('rejects a fabricated number', () => {
    const r = checkNarrativeNumbers('The top customer is 88% of revenue.', evidence);
    expect(r.ok).toBe(false);
    expect(r.offending).toContain('88%');
  });
});

describe('extraction eval harness', () => {
  it('scores the golden case at full accuracy', async () => {
    const scores = await runAll();
    expect(scores.length).toBeGreaterThan(0);
    for (const s of scores) expect(s.accuracy).toBe(1);
  });
});
