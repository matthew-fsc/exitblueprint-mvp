# 14 — Environment Keys: what goes where, and where to get it

Every environment variable the app reads, which host it belongs on, whether it's
required, and how to obtain it. The app is **four runtime pieces**: the
**frontend** (Vercel static build), **Clerk** (identity — login/MFA/orgs,
`docs/30`), **Supabase** (Postgres + RLS + storage), and the **compute service**
(server/http.ts on Render). Keys live on the frontend or the compute service —
never both.

> **Canonical list:** `.env.example` at the repo root is the machine-readable,
> always-current variable reference (it drives local dev and CI). This doc is the
> annotated "where to get it / which host" companion — if the two disagree,
> `.env.example` wins.

> **Golden rule:** only `VITE_`-prefixed variables reach the browser bundle. The
> service-role `DATABASE_URL`, the JWT secret, and every `EB_*` / API key are
> **server-side only** — never set them as `VITE_` vars.

---

## 1. Frontend — Vercel

Set under **Vercel → Project → Settings → Environment Variables**. These are baked
into the bundle at build time, so a change requires a redeploy.

| Variable | Required | Where to get it |
| --- | --- | --- |
| `VITE_SUPABASE_URL` | Yes | Supabase → Project Settings → API → **Project URL**. Auto-bridged from `NEXT_PUBLIC_SUPABASE_URL` / `SUPABASE_URL` by `vite.config.ts` when the Vercel↔Supabase integration is connected — so you may not need to set it by hand. |
| `VITE_SUPABASE_ANON_KEY` | Yes | Supabase → Project Settings → API → **anon / public** key. Auto-bridged from `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_ANON_KEY` / `*_PUBLISHABLE_KEY`. |
| `VITE_FUNCTIONS_URL` | Yes | The **compute-service URL** from step 2 below (e.g. `https://exitblueprint-functions.onrender.com`). No integration can know this — set it by hand. Leaving it unset in production points function calls at the static frontend and breaks scoring, PDFs, and document upload. |
| `VITE_CLERK_PUBLISHABLE_KEY` | Yes (prod) | Clerk → API Keys → **Publishable key** (`pk_...`). Selects the Clerk identity provider (login/MFA/invites, `docs/30`). **Unset is supported only for the local dev emulator** (local/CI); a hosted deploy without it shows a "not configured" page. |
| `VITE_SENTRY_DSN` | Optional | Sentry → Project → Client Keys (DSN). Frontend error monitoring (`docs/32`). Unset → the Sentry SDK is never loaded. |

The Vercel↔Supabase integration injects Supabase credentials under Next.js/generic
names; `vite.config.ts` bridges the two **public** values into the `VITE_` names.
It never bridges the service-role key or JWT secret.

---

## 2. Compute service — Render (or any container host)

Set under **Render → Blueprint env prompts** (see `render.yaml`) or **Dashboard →
Service → Environment**. All server-side; treat every one as a secret.

### Required

| Variable | Where to get it |
| --- | --- |
| `DATABASE_URL` | Supabase → Project Settings → Database → **Connection string (URI)**. Use the **service-role / session pooler** string (`aws-0-<region>.pooler.supabase.com:5432`). This connection bypasses RLS; per-request queries re-apply RLS as the caller. |
| `CLERK_JWKS_URL` | Clerk → your production instance domain — `https://<clerk-domain>/.well-known/jwks.json` (e.g. `https://clerk.exitblueprint.net/.well-known/jwks.json`). **Verifies production Clerk session tokens** (`docs/30`); not a secret. This is the standard token-verification path. |
| `EB_DOCUMENT_KEY` | **Generate:** `openssl rand -hex 32`. The AES-256-GCM key that encrypts uploaded documents at rest. If unset the service falls back to an insecure dev key and logs a warning — set a real key before storing any client document. |

`SUPABASE_URL` / `FUNCTIONS_JWT_SECRET` (legacy Supabase token verification) remain
**optional** — leave unset on the Clerk stack; set one only for a non-Clerk token
check during rotation.

### Required for identity, billing, provisioning

| Variable | Where to get it |
| --- | --- |
| `CLERK_SECRET_KEY` | Clerk → API Keys → **Secret key** (`sk_...`). Enables Clerk org invitations from the advisor UI (`server/invite.ts`) and automatic firm/advisor provisioning (`scripts/admin.ts`). |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Clerk dashboard → Webhooks → your endpoint → **Signing secret** (`whsec_...`). Enables `POST /webhooks/clerk`, which auto-provisions firms/advisors/owners (`docs/30` §5). Point the Clerk webhook at `https://<compute-host>/webhooks/clerk`. |
| `STRIPE_SECRET_KEY` | Stripe → Developers → API keys → **Secret key** (`sk_...`). Enables checkout + billing-portal sessions (`docs/24`). Unset → billing endpoints reply 503 and the app runs comped. |
| `STRIPE_WEBHOOK_SECRET` | Stripe dashboard → Webhooks → your endpoint → **Signing secret** (`whsec_...`). Signature-verifies `POST /webhooks/stripe` on the raw body. |

### Recommended

| Variable | Where to get it |
| --- | --- |
| `FUNCTIONS_ALLOWED_ORIGIN` | Your Vercel frontend origin, e.g. `https://exitblueprint-mvp.vercel.app` (no trailing slash). Defaults to `*`; tighten in production. |

### Optional

| Variable | Default | Where to get it / when to set |
| --- | --- | --- |
| `EB_SIGNING_KEY` | falls back to `FUNCTIONS_JWT_SECRET` | **Generate:** `openssl rand -hex 32`. HMAC key for short-expiry signed document URLs. |
| `AI_GATEWAY_API_KEY` | — (deterministic composer) | Vercel → **AI Gateway → API Keys**. Routes Claude narrative through the [Vercel AI Gateway](https://vercel.com/docs/ai-gateway) (Anthropic-compatible Messages API). **Preferred over `ANTHROPIC_API_KEY` when both are set.** If the gateway balance is empty the call fails and the service **falls back to the deterministic composer** — reports still generate (labeled rule-based); top up the balance to restore AI prose. Model ids are namespaced server-side (`claude-opus-4-8` → `anthropic/claude-opus-4.8`). |
| `ANTHROPIC_API_KEY` | — (deterministic composer) | [console.anthropic.com](https://console.anthropic.com) → API Keys. Enables real Claude narrative directly against the Anthropic API (used when `AI_GATEWAY_API_KEY` is unset); omit both to use the built-in rule-based composer. |
| `PORT` | `8787` | Render sets this automatically; override only for local runs. |
| `EB_CHROMIUM_PATH` | auto-detected | Path to a Chromium/Chrome binary for PDF rendering. Not needed on the Playwright Docker base image (`server/Dockerfile`). |
| `EB_PARSER` | `manual` | Leave unset. Reserved for `reducto` / `llamaparse` document-extraction adapters (not implemented in the beta). |
| `EB_STORAGE` | `db` | `db` keeps encrypted document bytes in Postgres (`document_blobs`). Set `supabase` to store them in a private Supabase Storage bucket instead — requires `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` (and the bucket from the `20260720000400` migration). Bytes are the same AES-256-GCM envelope either way. |
| `SUPABASE_SERVICE_ROLE_KEY` | — | Supabase → Project Settings → API → **service_role** key. **Required only when `EB_STORAGE=supabase`** (the storage client bypasses storage RLS to read/write the private bucket). Never expose to the browser. |
| `EB_STORAGE_BUCKET` | `documents` | Name of the private Supabase Storage bucket. The `20260720000400` migration creates `documents`; if you change this, create the bucket (private) by hand. |
| `EB_SCANNER` | `noop` | `noop` records uploads as `scan_status='skipped'`. Set `clamav` to scan every upload against a clamd daemon before it is stored — an infected file is rejected, never persisted. A configured-but-unreachable scanner fails the upload closed. |
| `EB_CLAMD_HOST` / `EB_CLAMD_PORT` | `127.0.0.1` / `3310` | clamd address, used when `EB_SCANNER=clamav`. |
| `BILLING_ENFORCED` | off | `true` turns the server-side entitlement gate ON (gated functions require an active/trialing/comped firm). Leave unset during the comped beta; comped firms always pass. |
| `SENTRY_DSN` | — (disabled) | Sentry → Project → Client Keys (DSN). Server error monitoring (`docs/32`). `SENTRY_ENVIRONMENT` and `SENTRY_TRACES_SAMPLE_RATE` are optional refinements. |
| `WEBHOOK_SECRET` | — (503) | **Generate:** `openssl rand -hex 32`. Shared secret for the n8n continuous-evaluation webhooks (`POST /webhooks/scheduled/*`), sent as the `x-webhook-secret` header (`docs/07`). Unset → those endpoints reply 503. |
| `WEBHOOK_RATE_LIMIT` | `60` | Max requests per client IP per window for the two unauthenticated webhook routes (`/webhooks/clerk` and `/webhooks/scheduled/*`, `docs/24` D2). Over the limit → `429` with a `Retry-After` header. Behind Render the limiter keys on the first `X-Forwarded-For` hop. |
| `WEBHOOK_RATE_WINDOW_SEC` | `60` | Rate-limit window length in seconds for the routes above. |
| `API_RATE_LIMIT` | `300` | Max requests per client IP per window for the authenticated function surface (`/functions/v1/*`), checked **before** token verification so a flood of bad/expensive tokens can't burn JWKS-verify CPU or reach the DB pool. Over the limit → `429` with a `Retry-After` header. Raise it for a NAT'd firm where many advisors share one egress IP. |
| `API_RATE_WINDOW_SEC` | `60` | Rate-limit window length in seconds for `/functions/v1/*`. |
| `PLATFORM_SUPERADMIN_IDS` | — (403) | Comma-separated Clerk user ids allowed to load methodology from inside the system (superadmin-gated `seed-methodology`, "Load methodology" on `/health`). |

### Optional — Ledger (QuickBooks / Xero) live connection

The app works without these via manual financial entry; set them only to enable
the real OAuth handshake.

| Variable | Where to get it |
| --- | --- |
| `LEDGER_OAUTH_REDIRECT_URI` | Your app's callback URL, e.g. `https://app.example.com/ledger/callback`. |
| `QUICKBOOKS_CLIENT_ID`, `QUICKBOOKS_CLIENT_SECRET` | [Intuit Developer](https://developer.intuit.com) → your app → Keys. |
| `XERO_CLIENT_ID`, `XERO_CLIENT_SECRET` | [Xero Developer](https://developer.xero.com) → your app → Configuration. |

---

## 3. Local development

`npm run dev:demo` needs **no keys** — a local Postgres plus the dev emulator
(`dev/supabase-dev-server.ts`) provide auth/REST/functions with a fixed dev
password. In the dev stack:

- **MFA** and **Supabase Storage** are bypassed.
- **Document encryption** uses the insecure dev key (fine locally).
- For **PDF export**, run `npx playwright install chromium` once.

To point local dev at a real Supabase project instead, set `VITE_SUPABASE_URL` +
`VITE_SUPABASE_ANON_KEY` (and `VITE_FUNCTIONS_URL` for a real compute service).

---

## Quick matrix

| Variable | Host | Secret | Required |
| --- | --- | --- | --- |
| `VITE_SUPABASE_URL` | Vercel | no (public) | yes |
| `VITE_SUPABASE_ANON_KEY` | Vercel | no (public) | yes |
| `VITE_FUNCTIONS_URL` | Vercel | no | yes |
| `VITE_CLERK_PUBLISHABLE_KEY` | Vercel | no (public) | yes (prod) |
| `VITE_SENTRY_DSN` | Vercel | no | optional |
| `DATABASE_URL` | Compute | **yes** | yes |
| `CLERK_JWKS_URL` | Compute | no | yes (prod) |
| `CLERK_SECRET_KEY` | Compute | **yes** | yes (prod) |
| `CLERK_WEBHOOK_SIGNING_SECRET` | Compute | **yes** | yes (prod) |
| `SUPABASE_URL` / `FUNCTIONS_JWT_SECRET` | Compute | **yes** | optional (legacy) |
| `EB_DOCUMENT_KEY` | Compute | **yes** | yes (prod) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Compute | **yes** | yes (billing) |
| `BILLING_ENFORCED` | Compute | no | optional |
| `FUNCTIONS_ALLOWED_ORIGIN` | Compute | no | recommended |
| `EB_SIGNING_KEY` | Compute | **yes** | optional |
| `AI_GATEWAY_API_KEY` | Compute | **yes** | optional |
| `ANTHROPIC_API_KEY` | Compute | **yes** | optional |
| `SENTRY_DSN` / `WEBHOOK_SECRET` / `PLATFORM_SUPERADMIN_IDS` | Compute | mixed | optional |
| `WEBHOOK_RATE_LIMIT` / `WEBHOOK_RATE_WINDOW_SEC` | Compute | no | optional |
| `API_RATE_LIMIT` / `API_RATE_WINDOW_SEC` | Compute | no | optional |
| `PORT`, `EB_CHROMIUM_PATH`, `EB_PARSER`, `EB_STORAGE`, `EB_SCANNER`, `EB_CLAMD_*` | Compute | no | optional |
| `SUPABASE_SERVICE_ROLE_KEY` | Compute | **yes** | if `EB_STORAGE=supabase` |
| `LEDGER_OAUTH_REDIRECT_URI` | Compute | no | optional |
| `QUICKBOOKS_* / XERO_*` | Compute | **yes** | optional |

Canonical variable list: **`.env.example`** (repo root).
Live deployment walkthrough: **docs/29-exitblueprint-net-golive.md** (Clerk auth: **docs/30**).
Security posture for each control: **docs/13-security-summary.md**.
