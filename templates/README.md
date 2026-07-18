# templates/ — copy-paste skeletons

Actionable starting points for the patterns in `docs/27-engineering-patterns.md`.
These files are **not compiled** (the dir is outside every tsconfig `include`);
copy one into the right place and fill the `<PLACEHOLDERS>`.

| Adding… | Copy | Into |
|---|---|---|
| A domain table + RLS | `migration.sql` | `supabase/migrations/<UTC>_<name>.sql` |
| A server function | `server-function.md` | `server/<domain>.ts` + wire per the checklist |
| Deterministic logic | `pure-module.ts` + `pure-module.test.ts` | `shared/` or `src/lib/` or `server/`, and `tests/` |
| A read | `query-hook.ts` | append to `src/lib/queries.ts` |
| A page | `page.tsx` | `src/pages/` + register the route in `src/App.tsx` |

Read `docs/27` for the definition-of-done of each. Non-negotiable rules live in
CLAUDE.md; the design system in `docs/26-ui-system.md`.
