import { createClient } from '@supabase/supabase-js';

// With a real Supabase project, set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.
// Without them (local dev), supabase-js talks to the same-origin dev emulator
// (dev/supabase-dev-server.ts) backed by local Postgres with real RLS.
//
// Trim the values: a stray newline/space pasted into a host's env-var UI (e.g.
// Vercel) rides along into the request URL and the `apikey` header, and WebKit
// then throws "The string did not match the expected pattern" when building the
// request — a confusing failure that surfaces only at login. Trimming is safe:
// neither a URL nor a Supabase key ever has meaningful leading/trailing space.
const env = (v: string | undefined) => v?.trim() || undefined;
const url = env(import.meta.env.VITE_SUPABASE_URL as string | undefined) || window.location.origin;
const anonKey = env(import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'dev-anon-key';

// The compute layer (/functions/v1/*) is served by our own Node service in
// production (docs/10-production-readiness.md) — a separate deployable from the
// Supabase project that handles auth + REST. VITE_FUNCTIONS_URL points at it;
// unset (dev), functions are same-origin, i.e. the dev emulator. Auth and REST
// always go through the supabase client above; only functions are redirected.
const functionsUrl = env(import.meta.env.VITE_FUNCTIONS_URL as string | undefined) || url;

// Clerk is the STANDARD identity provider (docs/30). A publishable key is present
// in every hosted deployment; login, MFA, and invites go through Clerk. Unset →
// the local dev emulator only (dev/supabase-dev-server.ts), for local dev + CI.
// The hosted Supabase-Auth password login was removed when Clerk became standard.
export const clerkPublishableKey = env(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined);
export const isClerkStack = !!clerkPublishableKey;

// Pluggable access-token source. Under Clerk, ClerkAuthProvider registers a
// getter returning Clerk's session JWT — trusted by Supabase (third-party auth)
// and verified by our compute service via Clerk's JWKS. Otherwise we read the
// Supabase session token. One helper feeds both supabase-js and /functions/*.
let clerkTokenGetter: (() => Promise<string | null>) | null = null;
export function registerClerkToken(getter: (() => Promise<string | null>) | null): void {
  clerkTokenGetter = getter;
}
async function currentAccessToken(): Promise<string | null> {
  if (clerkTokenGetter) return clerkTokenGetter();
  const { data } = await supabase.auth.getSession();
  return data.session?.access_token ?? null;
}

// Under Clerk, hand supabase-js our token source (third-party auth) so REST +
// RLS see the Clerk subject; without it, supabase-js manages its own session.
export const supabase = createClient(url, anonKey, isClerkStack ? { accessToken: () => currentAccessToken() } : undefined);

// The only supported non-Clerk configuration is the local dev emulator (no
// VITE_SUPABASE_URL, no Clerk key). A hosted deployment (VITE_SUPABASE_URL set)
// without Clerk is unsupported since the Supabase-Auth login was removed — surface
// it as a misconfiguration rather than silently offering password login.
export const isDevStack = !env(import.meta.env.VITE_SUPABASE_URL as string | undefined) && !isClerkStack;
export const requiresClerkConfig = !isClerkStack && !isDevStack;

async function functionEndpoint(name: string): Promise<{ endpoint: string; token: string }> {
  const token = (await currentAccessToken()) ?? anonKey;
  return { endpoint: `${functionsUrl}/functions/v1/${name}`, token };
}

// The GET route that serves a source document for a short-expiry signed token
// (R5). Usable directly as an <iframe>/<img> src — no session header needed.
export function documentDownloadUrl(documentId: string, token: string): string {
  return `${functionsUrl}/documents/download?doc=${encodeURIComponent(documentId)}&token=${encodeURIComponent(token)}`;
}

// POST to a function and return its JSON, surfacing the server's real error
// message (not a generic "non-2xx status code") so users see the actual reason.
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { endpoint, token } = await functionEndpoint(name);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? `request failed (${res.status})`);
  }
  return res.json() as Promise<T>;
}

// Calls a function that returns a binary body (e.g. a rendered PDF) and returns
// the Blob, going direct with the session token against the functions endpoint.
export async function invokeFunctionBlob(name: string, body: Record<string, unknown>): Promise<Blob> {
  const { endpoint, token } = await functionEndpoint(name);
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, apikey: anonKey, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.message ?? `request failed (${res.status})`);
  }
  // Guard against a 200 that isn't the binary we asked for. If VITE_FUNCTIONS_URL
  // points at the static frontend (or a proxy/CORS error page), the request 404s
  // to the SPA rewrite and comes back as index.html with a 200 — downloading that
  // as a ".pdf" yields a broken file and no error. Surface the real reason instead.
  const type = res.headers.get('content-type') ?? '';
  if (!/application\/(pdf|octet-stream)/i.test(type)) {
    const text = await res.text().catch(() => '');
    const looksHtml = /^\s*</.test(text) || /text\/html/i.test(type);
    throw new Error(
      looksHtml
        ? 'The compute service did not return a file. Check that VITE_FUNCTIONS_URL points at the functions service, not the frontend.'
        : (() => {
            try {
              return (JSON.parse(text) as { message?: string })?.message ?? `unexpected response (${type || 'no content-type'})`;
            } catch {
              return `unexpected response (${type || 'no content-type'})`;
            }
          })(),
    );
  }
  return res.blob();
}
