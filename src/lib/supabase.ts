import { createClient } from '@supabase/supabase-js';

// With a real Supabase project, set VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY.
// Without them (local dev), supabase-js talks to the same-origin dev emulator
// (dev/supabase-dev-server.ts) backed by local Postgres with real RLS.
const url = (import.meta.env.VITE_SUPABASE_URL as string | undefined) || window.location.origin;
const anonKey = (import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined) || 'dev-anon-key';

export const supabase = createClient(url, anonKey);

export const isDevStack = !import.meta.env.VITE_SUPABASE_URL;
