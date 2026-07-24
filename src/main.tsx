import React from 'react';
import ReactDOM from 'react-dom/client';
// Self-hosted variable fonts (bundled at build time — no runtime network
// dependency, so the app stays offline/CI-safe while actually rendering in the
// typeface it was designed around instead of a system fallback). The brand type
// system (matches exitblueprint.net): Schibsted Grotesk for headings + scores,
// Figtree for all body/UI, Spline Sans Mono for data (figures, codes, ids).
import '@fontsource-variable/schibsted-grotesk/wght.css';
import '@fontsource-variable/figtree/wght.css';
import '@fontsource-variable/spline-sans-mono/wght.css';
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
        <ClerkProvider
          publishableKey={clerkPublishableKey!}
          afterSignOutUrl="/login"
          signInUrl="/login"
          signUpUrl="/sign-up"
        >
          {app}
        </ClerkProvider>
      ) : (
        app
      )}
    </MonitoringErrorBoundary>
  </React.StrictMode>,
);
