# Engineering patterns — the canonical way to add each kind of thing

Agent-readable. Read this before adding a feature; copy the matching template from
`templates/`. The repo is intentionally **boring and explicit** (see CLAUDE.md):
patterns are consolidated as *documented templates + checklists*, not clever
abstractions — especially for security-critical code (RLS), where explicit is
auditable. Each pattern below names its template, the files it touches, and its
definition-of-done.

Companion docs: **UI system** → `docs/26-ui-system.md`. **Data model** →
`docs/02-data-model.md`. **Architecture rules** → CLAUDE.md (non-negotiable).

---

## 1. New domain table (schema + RLS)  → `templates/migration.sql`
**Touches:** one new file `supabase/migrations/<UTC-timestamp>_<name>.sql`.
Never edit an applied migration; always add a new one.

Every domain table **carries `firm_id`** and gets the standard firm-scoped RLS.
The firm-scoped block is the same 4 lines every table repeats (grants → enable →
policy); copy it verbatim and swap the table name + role set:

```sql
grant select, insert, update, delete on <table> to authenticated;
grant all on <table> to service_role;
alter table <table> enable row level security;
create policy <name>_firm_all on <table> for all to authenticated
  using (app.user_role() = any (array['advisor']::app_role[]) and firm_id = app.user_firm_id())
  with check (app.user_role() = any (array['advisor']::app_role[]) and firm_id = app.user_firm_id());
```
Role sets by surface: **advisor-only** `array['advisor']`; **staff** (advisor +
reviewer, e.g. verification/logs) `array['advisor','reviewer']`. **Owner** read
policies are bespoke (owners see only completed/derived rows) — never templated;
write them explicitly and add an RLS check (below).

**DoD:** migration applies to a fresh DB (`npm run db:migrate`); a firm-isolation
+ owner-visibility check added to `scripts/rls-test.ts` and `npm run test:rls`
stays green; a one-line entry appended to `docs/06-decisions.md`.

---

## 2. New server function (compute endpoint)  → `templates/server-function.md`
**Touches (in order):**
1. **Handler** — a pure-ish async fn in the domain file (`server/<domain>.ts`),
   signature `(db, firmId, body) => result`. Query pg directly; **never trust a
   `firm_id` from the body** — it's resolved from the caller's profile upstream.
2. **Registry entry** — add one `'<name>': { engine, scope, gated?, handler }`
   entry to `REGISTRY` in `server/registry.ts`, grouped under its **engine** (the
   six-engine model, `docs/28`): `rules` (deterministic facts), `reasoning` (AI
   narrative/assembled docs), `knowledge` (evidence/financials/outcomes),
   `workflow` (engagement lifecycle), `collaboration` (participants/review). Pick
   the **auth scope** that matches how the call is authorized (`firm`,
   `engagement`, `assessment`, `document`, `sellside-*`, `ledger-*`, …) — this is
   the *only* place authorization is declared. Set `gated: true` for a paid action.
3. **Frontend** — call via `invokeFunction<T>('<name>', body)` (`src/lib/supabase.ts`).

That's it — `server/functions.ts` (the gateway) reads the registry; you never edit
it to add a function. `GATED_FNS` (`server/entitlements.ts`) is derived from the
`gated` flags, so there is one source of truth. The router is transport-agnostic
(`functions.ts` is mounted by both the dev emulator and the prod Node service) —
handlers must not touch HTTP.

**DoD:** `tests/functions.test.ts` (or a domain test) exercises the handler and a
foreign-firm 404/deny; `tests/registry.test.ts` stays green (engine/scope/gate
invariants); `npm test` green.

---

## 3. New pure module (deterministic logic)  → `templates/pure-module.ts` + `.test.ts`
The golden pattern — most scoring/derivation logic. A pure function in `shared/`
(shared FE+BE) or `src/lib/` (FE) or `server/` (BE), **no I/O**, with a fixture
unit test. Mirrors `shared/entitlements.ts`, `shared/comparables.ts`,
`shared/alignment.ts`, `src/lib/workstreams.ts`. The server/UI layer fetches rows
and hands them to the pure fn; the fn is trivially testable and never hits a DB.

**DoD:** `tests/<name>.test.ts` covers the branches; `npm test` green. No LLM ever
computes a score (rule 1); AI is narrative-only (rule 2).

---

## 4. New read (query hook)  → `templates/query-hook.ts`
Add a `qk.<name>()` key and a `useX()` react-query hook in `src/lib/queries.ts`.
Reads go **directly through `supabase` under RLS** (not a function) using the
`unwrap`/`selectOne` helpers. Writes that must stay server-authoritative go
through a server function instead.

**DoD:** hook returns typed data; RLS keeps it firm-scoped (no `firm_id` filter
needed in the query — RLS does it).

---

## 5. New page  → `templates/page.tsx`
`PageHeader` (breadcrumb/title/subtitle/actions) → `EngagementNav` if it's an
engagement sub-page → content in `SectionCard`s. Use the design system
(`docs/26`): tokens for spacing/type, `.eyebrow` labels, `Card`/`SectionCard`/
`StatBlock`/`DataTable`/`Collapsible`/`EmptyState`, and `lib/format.ts`
(`fmtCurrency`/`humanizeKey`/`formatFieldValue`) — never raw snake_case, raw
integers, or hand-rolled tables. Register the route in `src/App.tsx` under the
right guard (`RequireAdvisor`/`RequireStaff`/`RequireOwner`).

**Async actions** (generate/save/finalize): use the shared `useAsyncAction` hook
(`src/lib/useAsyncAction.ts`) — `const { busy, run } = useAsyncAction()` — instead
of re-writing the `setBusy(true) … try/catch/toast … setBusy(false)` block that
~10 pages had copied. See the hook's doc comment.

**DoD:** builds; driven live in a browser (see `verify`/`run` skills); no console
errors.

---

## Open consolidation candidates (proposals, not yet done)
Tracked here so they're not lost; each is a deliberate change to confirm first:
- **RLS helper vs. template.** The firm-scoped block repeats 38×. Kept as an
  explicit **template** (above) on purpose — a `plpgsql` helper would hide
  security policy behind dynamic SQL and cost auditability. Revisit only if the
  count keeps climbing.
- **Declarative function registry.** ✅ **Done** (2026-07-20). `server/registry.ts`
  is now the `{ name: { engine, scope, gated?, handler } }` table; adding a
  function is one entry (see pattern §2). `functions.ts` is the scope-driven
  gateway that reads it, and it also encodes the six-engine model (`docs/28`) as a
  first-class tag on every endpoint. The security-critical authorization stays
  **explicit** — each scope is one auditable procedure in `authorize()`, a closed
  `AuthScope` union with an exhaustiveness check, not dynamic dispatch.
- **`useAsyncAction` adoption.** Hook exists + documented; pages adopt it
  incrementally as they're next touched (avoid a 10-file churn PR).
