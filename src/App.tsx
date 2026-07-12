import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ThemeToggle } from './lib/theme';
import { isDevStack } from './lib/supabase';
import { FirmMark, ToastProvider } from './components/ui';
import { BrandingProvider, useBrand } from './lib/branding';
import LoginPage from './pages/LoginPage';
import DashboardPage from './pages/DashboardPage';
import ClientsPage from './pages/ClientsPage';
import EngagementPage from './pages/EngagementPage';
import DeltaReportPage from './pages/DeltaReportPage';
import RoadmapPage from './pages/RoadmapPage';
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

function userInitials(email?: string | null): string {
  if (!email) return 'U';
  const local = email.split('@')[0].replace(/[._-]+/g, ' ').trim();
  const parts = local.split(' ').filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return local.slice(0, 2).toUpperCase();
}

function AppBar() {
  const { firmName, profile, signOut } = useAuth();
  const { brand } = useBrand();
  return (
    <header className="app-bar">
      <div className="app-bar-inner">
        <div className="app-bar-left">
          <FirmMark brand={brand} fallbackName={firmName} />
          <span className="app-bar-divider" aria-hidden />
          <nav className="app-nav" aria-label="Primary">
            <NavLink to="/" end className="app-nav-link">
              Portfolio
            </NavLink>
            <NavLink to="/clients" className="app-nav-link">
              Clients
            </NavLink>
            <NavLink to="/settings" className="app-nav-link">
              Settings
            </NavLink>
          </nav>
        </div>
        <div className="app-bar-right">
          {isDevStack && <span className="dev-badge">Dev</span>}
          <ThemeToggle />
          <span className="app-bar-divider" aria-hidden />
          <div className="user-chip">
            <span className="user-avatar" aria-hidden>
              {userInitials(profile?.email)}
            </span>
            <span className="user-email" title={profile?.email ?? undefined}>
              {profile?.email}
            </span>
            <button className="user-signout" onClick={signOut} title="Sign out" aria-label="Sign out">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
                <polyline points="16 17 21 12 16 7" />
                <line x1="21" y1="12" x2="9" y2="12" />
              </svg>
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <BrandingProvider>
      <AppBar />
      <main className="page">{children}</main>
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
                  <DashboardPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/clients"
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
            path="/engagement/:engagementId/roadmap"
            element={
              <RequireAdvisor>
                <Shell>
                  <RoadmapPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId/delta"
            element={
              <RequireAdvisor>
                <Shell>
                  <DeltaReportPage />
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
