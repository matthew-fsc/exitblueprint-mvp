# 14 — Environment Keys: what goes where, and where to get it

Every environment variable the app reads, which host it belongs on, whether it's
required, and how to obtain it. The app is **three runtime pieces** (see
docs/12): the **frontend** (Vercel static build), **Supabase** (database + auth +
storage), and the **compute service** (server/http.ts on Render/Railway/Fly). Keys
live on the frontend or the compute service — never both.

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
| `SUPABASE_URL` **or** `FUNCTIONS_JWT_SECRET` | Token verification — set **at least one** (both is fine mid-rotation). `SUPABASE_URL` (the project URL, e.g. `https://<ref>.supabase.co`) verifies asymmetric/JWKS-signed tokens. `FUNCTIONS_JWT_SECRET` is the legacy HS256 shared secret from Supabase → Project Settings → API → **JWT Secret**. |
| `EB_DOCUMENT_KEY` | **Generate:** `openssl rand -hex 32`. The AES-256-GCM key that encrypts uploaded documents at rest. If unset the service falls back to an insecure dev key and logs a warning — set a real key before storing any client document. |

### Recommended

| Variable | Where to get it |
| --- | --- |
| `FUNCTIONS_ALLOWED_ORIGIN` | Your Vercel frontend origin, e.g. `https://exitblueprint-mvp.vercel.app` (no trailing slash). Defaults to `*`; tighten in production. |

### Optional

| Variable | Default | Where to get it / when to set |
| --- | --- | --- |
| `EB_SIGNING_KEY` | falls back to `FUNCTIONS_JWT_SECRET` | **Generate:** `openssl rand -hex 32`. HMAC key for short-expiry signed document URLs. |
| `ANTHROPIC_API_KEY` | — (deterministic composer) | [console.anthropic.com](https://console.anthropic.com) → API Keys. Enables real Claude narrative in reports; omit to use the built-in rule-based composer. |
| `PORT` | `8787` | Render sets this automatically; override only for local runs. |
| `EB_CHROMIUM_PATH` | auto-detected | Path to a Chromium/Chrome binary for PDF rendering. Not needed on the Playwright Docker base image (`server/Dockerfile`). |
| `EB_PARSER` | `manual` | Leave unset. Reserved for `reducto` / `llamaparse` document-extraction adapters (not implemented in the beta). |
| `EB_STORAGE` | `db` | Leave unset. Reserved for the object-storage backend (R5 follow-up). |

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
| `DATABASE_URL` | Compute | **yes** | yes |
| `SUPABASE_URL` / `FUNCTIONS_JWT_SECRET` | Compute | **yes** | one of |
| `EB_DOCUMENT_KEY` | Compute | **yes** | yes (prod) |
| `FUNCTIONS_ALLOWED_ORIGIN` | Compute | no | recommended |
| `EB_SIGNING_KEY` | Compute | **yes** | optional |
| `ANTHROPIC_API_KEY` | Compute | **yes** | optional |
| `PORT`, `EB_CHROMIUM_PATH`, `EB_PARSER`, `EB_STORAGE` | Compute | no | optional |
| `LEDGER_OAUTH_REDIRECT_URI` | Compute | no | optional |
| `QUICKBOOKS_* / XERO_*` | Compute | **yes** | optional |

Deploy order and the full walkthrough: **docs/12-vercel-supabase-setup.md**.
Security posture for each control: **docs/13-security-summary.md**.
