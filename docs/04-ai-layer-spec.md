# 04 - AI Layer Spec (Narrative Service)

## Boundary

Claude generates prose from structured inputs. It never sees raw question answers as its source of truth for numbers; it receives computed scores, gap names, and the explain trace. It never invents scores, gaps, valuations, or dollar figures. Outputs are stored in generated_documents with prompt_version and model, and are editable drafts for the advisor.

## Server-side only

One edge function `generateDocument(assessment_id, doc_type)`. API key is a function secret. Rate-limit per firm. Log token usage per document for cost tracking.

## Document types and prompt contracts

### owner_report
- Audience: business owner, non-technical, plain language, encouraging but honest.
- Inputs: company name/industry, overall_score + band label, dimension scores with one-line meaning each, top gaps (max 5) with severity and the mapped playbook summaries, engagement target window.
- Structure: what the score means; strengths (top 2 dimensions); priority issues (each gap: what it is, why buyers care, what the fix looks like at a high level); what happens next.
- Hard rules in system prompt: use only the numbers provided; no valuation estimates or multiples; no legal/tax advice, refer to advisor; length 800-1200 words; no em dashes; plain direct sentences.

### advisor_brief
- Audience: the advisor before a client meeting.
- Inputs: same as above plus score deltas vs prior assessment, stalled tasks, gap status changes.
- Structure: one-paragraph state of the engagement; what improved / what regressed with the specific driver from the explain trace; talking points (3-5); risks to the timeline; suggested next actions.
- Length 300-500 words.

### engagement_summary (n8n monthly digest)
- Terse status roll-up per engagement for the firm principal. 5 bullets max per client.

## Versioning and evaluation

- Prompts live in /prompts as versioned files (owner_report.v1.md etc.). prompt_version stored on every generated document.
- A golden-set check: 3 fixture assessments have reference reports reviewed by Matthew. Any prompt change gets regenerated against fixtures and eyeballed before version bump.
- If Claude output references a number not present in the input payload, the service rejects and regenerates once, then fails loudly. Implement as a simple post-generation check: every numeral in output must appear in input (whitelist years and list numbering).
