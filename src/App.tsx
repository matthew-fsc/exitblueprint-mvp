import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ThemeToggle } from './lib/theme';
import { isDevStack } from './lib/supabase';
import { FirmMark, ToastProvider } from './components/ui';
import { BrandingProvider, useBrand } from './lib/branding';
import LoginPage from './pages/LoginPage';
import ClientsPage from './pages/ClientsPage';
import EngagementPage from './pages/EngagementPage';
import IntakePage from './pages/IntakePage';
import ResultsPage from './pages/ResultsPage';
import WorkbenchPage from './pages/WorkbenchPage';
import ReportPage from './pages/ReportPage';
import SettingsPage from './pages/SettingsPage';
import HealthPage from './pages/HealthPage';
import VerifyPage from './pages/VerifyPage';
import ComponentsPage from './pages/ComponentsPage';
import type { ReactNode } from 'react';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function RequireAdvisor({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="muted page">Loading…</p>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!profile || (profile.role !== 'advisor' && profile.role !== 'admin')) {
    return (
      <main className="page">
        <p className="form-error">
          This account has no advisor profile. Provision one with scripts/admin.ts.
        </p>
      </main>
    );
  }
  return <>{children}</>;
}

function ShellHeader() {
  const { firmName, profile, signOut } = useAuth();
  const { brand } = useBrand();
  return (
    <header className="page-header shell-header">
      <div>
        <FirmMark brand={brand} fallbackName={firmName} />
        <p className="subtitle">Exit readiness workspace</p>
      </div>
      <nav className="shell-nav">
        <Link to="/">Clients</Link>
        <Link to="/settings">Settings</Link>
        <span className="shell-user">
          {profile?.email}
          {isDevStack && <span className="dev-badge">dev stack</span>}
        </span>
        <button className="linkish" onClick={signOut}>
          Sign out
        </button>
        <ThemeToggle />
      </nav>
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <BrandingProvider>
      <main className="page">
        <ShellHeader />
        {children}
      </main>
    </BrandingProvider>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <ToastProvider>
          <BrowserRouter>
            <AuthProvider>
              <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/health" element={<main className="page"><HealthPage /></main>} />
          <Route path="/dev/verify" element={<main className="page"><VerifyPage /></main>} />
          <Route path="/dev/components" element={<main className="page"><ComponentsPage /></main>} />
          <Route
            path="/"
            element={
              <RequireAdvisor>
                <Shell>
                  <ClientsPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId"
            element={
              <RequireAdvisor>
                <Shell>
                  <EngagementPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/assessment/:assessmentId/intake"
            element={
              <RequireAdvisor>
                <Shell>
                  <IntakePage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/assessment/:assessmentId/results"
            element={
              <RequireAdvisor>
                <Shell>
                  <ResultsPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/assessment/:assessmentId/workbench"
            element={
              <RequireAdvisor>
                <Shell>
                  <WorkbenchPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/assessment/:assessmentId/report"
            element={
              <RequireAdvisor>
                <Shell>
                  <ReportPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAdvisor>
                <Shell>
                  <SettingsPage />
                </Shell>
              </RequireAdvisor>
            }
          />
            <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
