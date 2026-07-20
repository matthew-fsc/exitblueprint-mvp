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
import { initMonitoring, MonitoringErrorBoundary } from './lib/monitoring';
import { ErrorState } from './components/ui';
import './styles.css';

// Error monitoring (src/lib/monitoring.ts). No-op until VITE_SENTRY_DSN is set,
// so local dev / CI ship no SDK; when set, unhandled render errors are captured.
initMonitoring();

// Clerk is the standard identity provider (docs/30). When its publishable key is
// unset (local dev / CI only), the tree renders without ClerkProvider and auth
// uses the local dev emulator instead.
const app = <App />;

// Top-level boundary: a render crash (or a failed lazy chunk) shows a recover
// action and is reported to monitoring, instead of a blank #root.
const errorFallback = (
  <main className="page">
    <ErrorState
      variant="page"
      title="Something went wrong"
      message="An unexpected error occurred. Reloading usually fixes it; if it keeps happening, contact support."
      onRetry={() => window.location.reload()}
      retryLabel="Reload"
    />
  </main>
);

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <MonitoringErrorBoundary fallback={errorFallback}>
      {isClerkStack ? (
        <ClerkProvider publishableKey={clerkPublishableKey!} afterSignOutUrl="/login">
          {app}
        </ClerkProvider>
      ) : (
        app
      )}
    </MonitoringErrorBoundary>
  </React.StrictMode>,
);
