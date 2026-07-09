import { createClient, FunctionsHttpError } from '@supabase/supabase-js';

// With a real Supabase project, set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.
// Without them (local dev), supabase-js talks to the same-origin dev emulator
// (dev/supabase-dev-server.ts) backed by local Postgres with real RLS.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || window.location.origin;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'dev-anon-key';

export const supabase = createClient(url, anonKey);

export const isDevStack = !import.meta.env.VITE_SUPABASE_URL;

// functions.invoke wraps non-2xx responses in a generic "non-2xx status code"
// error; unwrap the server's actual message so users see the real reason.
export async function invokeFunction<T>(name: string, body: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.functions.invoke(name, { body });
  if (!error) return data as T;
  let message = error.message;
  if (error instanceof FunctionsHttpError) {
    const detail = await (error.context as Response).clone().json().catch(() => null);
    if (detail?.message) message = detail.message;
  }
  throw new Error(message);
}
