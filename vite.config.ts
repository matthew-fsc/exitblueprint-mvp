import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { supabaseDevServer } from './dev/supabase-dev-server';

// The Supabase↔Vercel integration injects its credentials under Next.js/generic
// names (NEXT_PUBLIC_SUPABASE_URL, SUPABASE_URL, SUPABASE_ANON_KEY, …), but Vite
// only exposes VITE_-prefixed vars to the browser bundle — so without this the
// integration "connects" yet the client sees nothing and login breaks. Bridge
// the two PUBLIC values into the VITE_ names the app reads, so the integration
// works with no hand-added frontend env vars. Only URL + anon/publishable key
// are bridged; the service-role key and JWT secret are secret and never touched.
function bridgeEnv(target: string, ...sources: string[]) {
  if (process.env[target]?.trim()) return;
  const value = sources.map((s) => process.env[s]).find((v) => v?.trim());
  if (value) process.env[target] = value;
}
bridgeEnv('VITE_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_URL', 'SUPABASE_URL');
bridgeEnv(
  'VITE_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
  'SUPABASE_PUBLISHABLE_KEY',
);

export default defineConfig(() => ({
  plugins: [
    react(),
    // Dev-only Supabase emulator against local Postgres; only active when no
    // real Supabase URL is configured. Production builds never include it.
    ...(process.env.VITE_SUPABASE_URL ? [] : [supabaseDevServer()]),
  ],
  // GitHub Codespaces serves the dev server through *.app.github.dev over
  // TLS on 443 — the HMR websocket must connect back through that port.
  ...(process.env.CODESPACES
    ? {
        server: {
          host: true,
          allowedHosts: ['.app.github.dev'],
          hmr: { clientPort: 443 },
        },
      }
    : {}),
}));
