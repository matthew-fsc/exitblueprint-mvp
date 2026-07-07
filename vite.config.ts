import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { supabaseDevServer } from './dev/supabase-dev-server';

export default defineConfig(() => ({
  plugins: [
    react(),
    // Dev-only Supabase emulator against local Postgres; only active when no
    // real Supabase URL is configured. Production builds never include it.
    ...(process.env.VITE_SUPABASE_URL ? [] : [supabaseDevServer()]),
  ],
  // GitHub Codespaces serves the dev server through *.app.github.dev.
  ...(process.env.CODESPACES
    ? { server: { host: true, allowedHosts: ['.app.github.dev'] } }
    : {}),
}));
