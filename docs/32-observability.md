# Observability — error monitoring runbook

Error monitoring for the two deployables: the **React frontend** (Vercel) and the
**Node compute service** `server/http.ts` (Render). This is the code-complete
companion to `docs/24` §C4 (Sentry on frontend + Node service). It is built as a
thin, vendor-neutral seam with a Sentry adapter that is **a no-op until a DSN is
configured** — so dev, CI, and beta are unchanged.

**Design in one line:** the app calls `captureError` / `logRequest` (server) and
`captureError` / `MonitoringErrorBoundary` (frontend); Sentry lives behind those
functions and is never imported elsewhere. No DSN ⇒ everything degrades to
structured console logs.

## Disabled by default

- **Server** (`server/observability.ts`): with no `SENTRY_DSN`, `initObservability()`
  logs `observability: disabled (no SENTRY_DSN)` and selects the console-only sink.
  `captureError`/`captureMessage` still emit one structured JSON line each; Sentry
  is simply never called and never initialized.
- **Frontend** (`src/lib/monitoring.ts`): with no `VITE_SENTRY_DSN`,
  `initMonitoring()` is a no-op. `@sentry/react` is loaded via a **dynamic import**
  only when the DSN is present, so the no-DSN build never pulls the SDK into the
  entry chunk.

Nothing changes for local dev / CI / a deploy that hasn't set the vars.

## What's captured

- **Server:** unhandled errors reported from `server/http.ts`'s catch blocks
  (request handler, function calls, webhook failures) via `captureError(err, ctx)`,
  plus one access-log line per request via `logRequest({ method, path, status, ms })`.
  `ctx` is a small object — `route`, `firmId`, `fn`, ids — and is **scrubbed** before
  it ever reaches the console or Sentry.
- **Frontend:** render-time crashes caught by `MonitoringErrorBoundary`, plus any
  explicit `captureError(err, ctx)` calls.

### Never captured (hard rule, CLAUDE.md)

Tokens, secrets, `Authorization`/cookie headers, JWTs, request/response bodies,
and PII beyond ids. `scrubContext()` (both modules) drops any key matching a
sensitive pattern (`token`, `secret`, `password`, `auth`, `cookie`, `jwt`,
`apikey`, `bearer`, `session`, `email`, `phone`, `body`, `payload`, …), keeps only
scalar values (so a whole object/body can't ride along), and caps string length.
`sendDefaultPii: false` is set on both SDKs so Sentry adds nothing on its own.

## Environment variables

| Var | Where | Meaning |
| --- | --- | --- |
| `SENTRY_DSN` | Render (Node service) | Enables server monitoring. Unset ⇒ disabled. |
| `VITE_SENTRY_DSN` | Vercel (frontend, build-time) | Enables frontend monitoring. Unset ⇒ disabled. |
| `SENTRY_ENVIRONMENT` / `VITE_SENTRY_ENVIRONMENT` | both (optional) | Environment tag (`production`, `staging`, …). Defaults to `NODE_ENV` / `production`. |
| `SENTRY_TRACES_SAMPLE_RATE` / `VITE_SENTRY_TRACES_SAMPLE_RATE` | both (optional) | Performance-trace sample rate `0..1`. Defaults to `0` (errors only). |

`VITE_*` vars are build-time — a Vercel redeploy is required to change them.

## Enable in production

**Render (Node service):** Dashboard → the service → Environment → add `SENTRY_DSN`
(from the Sentry project, "Node" platform). Optionally add `SENTRY_ENVIRONMENT`
and `SENTRY_TRACES_SAMPLE_RATE`. Redeploy. Startup logs
`observability: enabled (sentry, env=…)`.

**Vercel (frontend):** Project → Settings → Environment Variables → add
`VITE_SENTRY_DSN` (from the Sentry project, "React" platform). Optionally add the
`VITE_SENTRY_ENVIRONMENT` / `VITE_SENTRY_TRACES_SAMPLE_RATE` vars. Redeploy so the
build picks them up. The console logs `monitoring: enabled (sentry)`.

To disable, remove the DSN var and redeploy — the seam falls back to console-only
with no code change.
