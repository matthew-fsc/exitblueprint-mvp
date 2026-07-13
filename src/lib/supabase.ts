import { createClient } from '@supabase/supabase-js';

// With a real Supabase project, set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.
// Without them (local dev), supabase-js talks to the same-origin dev emulator
// (dev/supabase-dev-server.ts) backed by local Postgres with real RLS.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || window.location.origin;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'dev-anon-key';

// The compute layer (/functions/v1/*) is served by our own Node service in
// production (docs/10-production-readiness.md) — a separate deployable from the
// Supabase project that handles auth + REST. VITE_FUNCTIONS_URL points at it;
// unset (dev), functions are same-origin, i.e. the dev emulator. Auth and REST
// always go through the supabase client above; only functions are redirected.
const functionsUrl = (import.meta.env.VITE_FUNCTIONS_URL as string | undefined) || url;

export const supabase = createClient(url, anonKey);

export const isDevStack = !import.meta.env.VITE_SUPABASE_URL;

async function functionEndpoint(name: string): Promise<{ endpoint: string; token: string }> {
  const { data } = await supabase.auth.getSession();
  return { endpoint: `${functionsUrl}/functions/v1/${name}`, token: data.session?.access_token ?? anonKey };
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
  return res.blob();
}
