import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted variable fonts (bundled at build time — no runtime network
// dependency, so the app stays offline/CI-safe while actually rendering in the
// typeface it was designed around instead of a system fallback). Inter for
// body/UI, Inter Tight for display headings.
import '@fontsource-variable/inter/wght.css';
import '@fontsource-variable/inter-tight/wght.css';
import { ClerkProvider } from '@clerk/react';
import App from './App';
import { clerkPublishableKey, isClerkStack } from './lib/supabase';
import './styles.css';

// Clerk is the identity provider in production (docs/30). When its publishable
// key is unset (local dev / CI / the Supabase-Auth beta), the tree renders
// without ClerkProvider and auth falls back to the Supabase path unchanged.
const app = <App />;

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {isClerkStack ? (
      <ClerkProvider publishableKey={clerkPublishableKey!} afterSignOutUrl="/login">
        {app}
      </ClerkProvider>
    ) : (
      app
    )}
  </React.StrictMode>,
);
