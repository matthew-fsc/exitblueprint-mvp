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
- Inputs: same as above plus score deltas vs prior assessment, stalled tasks, gap status changes. Deltas come precomputed from compareAssessments (docs/03) when comparable; when the prior assessment is on a different rubric_version the payload carries the incomparable marker and the brief says so instead of citing a delta.
- Structure: one-paragraph state of the engagement; what improved / what regressed with the specific driver from the explain trace; talking points (3-5); risks to the timeline; suggested next actions.
- Length 300-500 words.

### engagement_summary (n8n monthly digest)
- Terse status roll-up per engagement for the firm principal. 5 bullets max per client.

## Versioning and evaluation

- Prompts live in /prompts as versioned files (owner_report.v1.md etc.). prompt_version stored on every generated document.
- A golden-set check: 3 fixture assessments have reference reports reviewed by Matthew. Any prompt change gets regenerated against fixtures and eyeballed before version bump.
- Numeral post-check: v1 prompts must instruct the model to use only supplied numbers and to NEVER perform arithmetic — no computed deltas, percentages, sums, or rounding of its own. The post-generation check stays strict: every numeral in the output must appear in the input payload (whitelist: years, list numbering, and numbers present in the payload). Any derived figure the document needs (score deltas, gap counts, percentages) is computed server-side and included in the input payload — owner_report and advisor_brief payloads include precomputed deltas from compareAssessments when comparable. On a violation the service rejects and regenerates once, then fails loudly.
