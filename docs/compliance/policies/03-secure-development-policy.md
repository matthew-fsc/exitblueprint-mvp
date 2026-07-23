# Secure Development Policy

| | |
| --- | --- |
| **Policy** | Secure Development |
| **Owner** | Matthew (matthew@fracturesystems.com) |
| **Version** | 1.0 |
| **Effective** | 2026-07-23 |
| **Review** | Annually / on material change |
| **Applies to** | All Exit Blueprint personnel and systems |

## Purpose

Define how Exit Blueprint builds software securely: how untrusted input is
validated, how data reaches the database and the browser safely, how secrets are
handled, how dependencies are managed, and what the threat model is. The goal is
that security is a property of how the code is written and reviewed, not a
bolt-on.

## Scope

All application code in the audited system: the React + Vite frontend, the Node
compute service (`server/`), shared libraries (`src/lib/`), migrations, seed
code, and the CI configuration that gates them. Third-party managed platforms
(Supabase, Render, Vercel, Clerk, Stripe, Anthropic) provide inherited
infrastructure controls and are out of scope for our source but in scope for our
vendor due diligence (docs/16).

## Policy statements

1. **Secure SDLC.** Security requirements are considered at design time and
   verified through review and the automated CI gate (see
   `docs/compliance/policies/02-change-management-policy.md`). No change reaches
   `main` without passing CI and review.
2. **Input validation.** External and structured inputs are validated against
   explicit schemas (zod) before use; malformed input is rejected rather than
   coerced.
3. **Parameterized SQL only.** User-supplied values are always passed as query
   parameters (`$1`, `$2`, …), never concatenated into SQL strings. Where a table
   or column *name* is interpolated (`${table}`), the value is a code literal or
   comes from `information_schema` — never from user input — and this is
   documented at each call site in code.
4. **Output encoding / no raw HTML injection.** React auto-escapes rendered
   values. `dangerouslySetInnerHTML` is not used. Generated Markdown deliverables
   are rendered by building React nodes from a constrained token set
   (`src/lib/markdown.tsx`), not by injecting an HTML string — so authored or
   AI-drafted document text cannot become executable markup.
5. **Secrets never in code.** Secrets are supplied via environment variables
   from provider/CI secret stores; `.env` / `.env.local` are git-ignored.
   Production **hard-fails at startup** if `EB_DOCUMENT_KEY` or `EB_SIGNING_KEY`
   is missing, so real client data can never be protected by a dev default.
6. **Dependency management.** Dependencies are added deliberately and reviewed.
   `npm audit` is run against the dependency tree; the current result is 0
   vulnerabilities. Automating this scan in CI as a blocking step is a planned
   hardening item.
7. **Least-privilege service accounts.** The application acts under scoped
   credentials; database access is further constrained by row-level security so
   even the application path cannot read across tenants. Admin reach is defined
   by RLS policy, not ad-hoc grants.
8. **Peer review and test coverage.** Every change is reviewed before merge and
   must carry the tests the Definition of done requires — scoring fixtures, the
   RLS isolation suite, and the extraction eval where the AI layer is touched.
   Security-relevant behavior (isolation, signing, encryption, webhook
   verification) is covered by executable tests, not inspection.

## Roles & responsibilities

- **Policy owner (Matthew):** owns the secure-development standard; reviews
  changes for security impact; approves exceptions.
- **Authors / agents:** validate inputs, parameterize queries, avoid raw HTML,
  keep secrets out of source, and meet the test/coverage bar before opening a PR.
- **CI system:** runs the isolation, scoring, eval, and build gates on every PR.

## Implementation / evidence

- ✅ **Input validation (zod)** — schema validation, e.g.
  `server/ontology/registry.ts`; zod is a project dependency.
- ✅ **Parameterized SQL** — parameterized queries throughout `server/`;
  identifier interpolation is whitelist/`information_schema`-sourced and
  documented in code (e.g. `server/export.ts`, `server/engagements.ts`,
  `server/migrate.ts`).
- ✅ **Output safety** — no `dangerouslySetInnerHTML` in `src/` or `server/`; the
  Markdown renderer builds React elements (`src/lib/markdown.tsx`).
- ✅ **Secrets handling** — git-ignored `.env*`; production startup hard-fail on
  missing `EB_DOCUMENT_KEY` / `EB_SIGNING_KEY` (`server/http.ts`).
- ✅ **Least privilege via RLS** — `scripts/rls-test.ts` (`npm run test:rls`),
  run in CI.
- ✅ **Webhook signature verification** — Clerk/Svix and Stripe verified on the
  raw body with replay tolerance; n8n shared secret compared timing-safely; unset
  secret disables the endpoint (503) (`server/http.ts`).
- ✅ **Deterministic-scoring integrity** — versioned rule-based scoring verified
  against `seed/fixtures/reference_scorer.py`; no LLM computes or influences a
  score (CLAUDE.md rule 1).
- ✅ **Stored-XSS defense on document serving** — safe recomputed content-type,
  `attachment` octet-stream for untrusted types, `X-Content-Type-Options: nosniff`
  (`server/http.ts` `/documents/download`).
- 📄 **Peer review before merge** — established in this policy and
  `docs/compliance/policies/02-change-management-policy.md`.
- 🟡 **Automated dependency/vulnerability scan in CI** — manual `npm audit` is
  clean (0 vulns) today; the blocking CI step is planned (see
  `docs/compliance/policies/15-vulnerability-management-policy.md`).

## Threat model highlights

- **Multi-tenant isolation** is the primary threat. Defense: `firm_id` on every
  domain table with Postgres RLS enforced in the database, verified by an
  automated suite in CI — not app-layer filtering alone.
- **Stored XSS via served documents.** Defense: signed short-expiry delivery,
  recomputed safe content-type, forced `attachment` for untrusted types,
  `nosniff`.
- **Forged/replayed webhooks.** Defense: signature verification on the raw body
  with timestamp/replay tolerance; secretless endpoints disabled by default.
- **Scoring integrity / LLM tampering.** Defense: scores are deterministic,
  versioned, and reference-checked; AI is narrative-only and its output is
  labeled draft (CLAUDE.md rules 1–2).
- **Secret exposure.** Defense: secrets never in source; production hard-fail on
  missing keys; document keys never stored alongside the data they protect
  (`server/documents/crypto.ts`).

## Exceptions

Exceptions require the policy owner's explicit approval and are recorded in
`docs/06-decisions.md` with rationale and any compensating control. Disabling
input validation, using string-built SQL from user input, or introducing raw
HTML injection are not permitted exceptions.

## Review & enforcement

Reviewed at least annually and on material change to the stack. Enforced through
code review and the automated CI gates. Introducing a security regression that
these controls exist to prevent is a policy violation and is remediated before
release.

## SOC 2 mapping

Supports **CC8.1** (secure change/development) and **CC7.1** (detecting and
managing security-relevant configuration and vulnerabilities in the SDLC).
Cross-references: `docs/compliance/policies/02-change-management-policy.md`,
`docs/compliance/policies/15-vulnerability-management-policy.md`,
`docs/13-security-summary.md`, `docs/16-vendor-security-dd.md`.
