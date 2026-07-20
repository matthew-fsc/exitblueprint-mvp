import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ThemeToggle } from './lib/theme';
import { isDevStack } from './lib/supabase';
import { FirmMark, ToastProvider, LoadingState, ErrorState } from './components/ui';
import { BrandingProvider, useBrand } from './lib/branding';
import { Analytics } from '@vercel/analytics/react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { getMfaState, type MfaState } from './lib/mfa';
import { LegalFooter } from './components/LegalFooter';
import LoginPage from './pages/LoginPage';

// Route-level code-splitting (frontend audit / docs/32): every page except the
// login screen (first paint) is loaded on demand, so the initial bundle is the
// shell + login rather than all ~30 route modules. <Suspense> (below) streams a
// page loading state while each chunk downloads.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const ClientsPage = lazy(() => import('./pages/ClientsPage'));
const EngagementPage = lazy(() => import('./pages/EngagementPage'));
const DeltaReportPage = lazy(() => import('./pages/DeltaReportPage'));
const RoadmapPage = lazy(() => import('./pages/RoadmapPage'));
const BuyerLensPage = lazy(() => import('./pages/BuyerLensPage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const ValuationPage = lazy(() => import('./pages/ValuationPage'));
const OwnerHomePage = lazy(() => import('./pages/owner/OwnerHomePage'));
const OwnerPlanPage = lazy(() => import('./pages/owner/OwnerPlanPage'));
const OwnerLearnPage = lazy(() => import('./pages/owner/OwnerLearnPage'));
const OwnerDocumentsPage = lazy(() => import('./pages/owner/OwnerDocumentsPage'));
const OwnerConnectPage = lazy(() => import('./pages/owner/OwnerConnectPage'));
const LedgerCallbackPage = lazy(() => import('./pages/LedgerCallbackPage'));
const IntakePage = lazy(() => import('./pages/IntakePage'));
const ResultsPage = lazy(() => import('./pages/ResultsPage'));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage'));
const ReportPage = lazy(() => import('./pages/ReportPage'));
const CimPage = lazy(() => import('./pages/CimPage'));
const EvidencePage = lazy(() => import('./pages/EvidencePage'));
const ReviewQueuePage = lazy(() => import('./pages/ReviewQueuePage'));
const ReviewDocumentPage = lazy(() => import('./pages/ReviewDocumentPage'));
const SecurityPage = lazy(() => import('./pages/SecurityPage'));
const SettingsPage = lazy(() => import('./pages/SettingsPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const HealthPage = lazy(() => import('./pages/HealthPage'));
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const ComponentsPage = lazy(() => import('./pages/ComponentsPage'));
const TermsPage = lazy(() => import('./pages/legal/TermsPage'));
const PrivacyPage = lazy(() => import('./pages/legal/PrivacyPage'));
const DpaPage = lazy(() => import('./pages/legal/DpaPage'));
const SubprocessorsPage = lazy(() => import('./pages/legal/SubprocessorsPage'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

// R5: advisor/admin accounts must satisfy MFA (bypassed on the dev stack). An
// un-enrolled or unverified advisor is sent to /security before anything else.
function useMfaGate(session: unknown): MfaState | 'loading' {
  const [state, setState] = useState<MfaState | 'loading'>('loading');
  useEffect(() => {
    let alive = true;
    getMfaState()
      .then((s) => alive && setState(s))
      .catch(() => alive && setState('satisfied'));
    return () => {
      alive = false;
    };
  }, [session]);
  return state;
}

// Shown when a signed-in user has no usable profile yet. Provisioning is
// automatic (the Clerk webhook writes the profile just after sign-in) but
// eventually-consistent, so this is usually a brief timing gap right after a
// first sign-in — offer a refresh rather than a dead end, and never tell an end
// user to run a CLI.
function ProfileNotReady() {
  return (
    <main className="page">
      <ErrorState
        variant="page"
        title="Your account isn’t set up yet"
        message="If you just signed in, give it a moment — provisioning finishes a beat after your first sign-in. If this keeps happening, contact your administrator."
        onRetry={() => window.location.reload()}
        retryLabel="Refresh"
      />
    </main>
  );
}

function RequireAdvisor({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  const mfa = useMfaGate(session);
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile?.role === 'owner') return <Navigate to="/portal" replace />;
  // A pure reviewer has no advisor workspace — send them to the review queue.
  if (profile?.role === 'reviewer') return <Navigate to="/review" replace />;
  if (!profile || (profile.role !== 'advisor' && profile.role !== 'admin')) {
    return <ProfileNotReady />;
  }
  if (mfa === 'loading') return <main className="page"><LoadingState variant="page" /></main>;
  // /security is where MFA is set up, so it must stay reachable during the gate.
  if (mfa !== 'satisfied' && location.pathname !== '/security') {
    return <Navigate to="/security" replace />;
  }
  return <>{children}</>;
}

// Staff surfaces (the review queue): advisor, admin, or reviewer.
function RequireStaff({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile?.role === 'owner') return <Navigate to="/portal" replace />;
  if (!profile || !['advisor', 'admin', 'reviewer'].includes(profile.role)) {
    return <ProfileNotReady />;
  }
  return <>{children}</>;
}

function RequireOwner({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile && profile.role !== 'owner') return <Navigate to="/" replace />;
  return <>{children}</>;
}

// Any signed-in user (advisor or owner) — used by the ledger OAuth callback,
// which either role can reach when returning from the provider.
function RequireAuth({ children }: { children: ReactNode }) {
  const { session, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  return <>{children}</>;
}

// The three Evidence surfaces were merged into one tabbed page (docs/22 F2).
// Old per-surface routes redirect into the corresponding sub-tab so existing
// links keep working.
function RedirectToEvidence({ section }: { section: string }) {
  const { engagementId } = useParams();
  return <Navigate to={`/engagement/${engagementId}/evidence/${section}`} replace />;
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
            <NavLink to="/review" className="app-nav-link">
              Review
            </NavLink>
            <NavLink to="/library" className="app-nav-link">
              Library
            </NavLink>
            <NavLink to="/security" className="app-nav-link">
              Security
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
      <LegalFooter />
    </BrandingProvider>
  );
}

function OwnerAppBar() {
  const { firmName, profile, signOut } = useAuth();
  const { brand } = useBrand();
  return (
    <header className="app-bar">
      <div className="app-bar-inner">
        <div className="app-bar-left">
          <FirmMark brand={brand} fallbackName={firmName} />
          <span className="app-bar-divider" aria-hidden />
          <nav className="app-nav" aria-label="Primary">
            <NavLink to="/portal" end className="app-nav-link">Home</NavLink>
            <NavLink to="/portal/plan" className="app-nav-link">Your plan</NavLink>
            <NavLink to="/portal/learn" className="app-nav-link">Learn</NavLink>
            <NavLink to="/portal/documents" className="app-nav-link">Documents</NavLink>
            <NavLink to="/portal/connect" className="app-nav-link">Connect</NavLink>
          </nav>
        </div>
        <div className="app-bar-right">
          {isDevStack && <span className="dev-badge">Dev</span>}
          <ThemeToggle />
          <span className="app-bar-divider" aria-hidden />
          <div className="user-chip">
            <span className="user-avatar" aria-hidden>{userInitials(profile?.email)}</span>
            <span className="user-email" title={profile?.email ?? undefined}>{profile?.email}</span>
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

function OwnerShell({ children }: { children: ReactNode }) {
  return (
    <BrandingProvider>
      <OwnerAppBar />
      <main className="page">{children}</main>
      <LegalFooter />
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
              <SpeedInsights />
              <Suspense fallback={<main className="page"><LoadingState variant="page" /></main>}>
              <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/health" element={<main className="page"><HealthPage /></main>} />
          {/* Public legal/trust pages (draft, pending counsel) — render their own
              page shell, no auth. Above the catch-all so they aren't swallowed. */}
          <Route path="/legal/terms" element={<TermsPage />} />
          <Route path="/legal/privacy" element={<PrivacyPage />} />
          <Route path="/legal/dpa" element={<DpaPage />} />
          <Route path="/legal/subprocessors" element={<SubprocessorsPage />} />
          {/* Dev-only scaffolding — never routed in a production build. */}
          {import.meta.env.DEV && (
            <>
              <Route path="/dev/verify" element={<main className="page"><VerifyPage /></main>} />
              <Route path="/dev/components" element={<main className="page"><ComponentsPage /></main>} />
            </>
          )}
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
            path="/engagement/:engagementId/buyer-lens"
            element={
              <RequireAdvisor>
                <Shell>
                  <BuyerLensPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId/valuation"
            element={
              <RequireAdvisor>
                <Shell>
                  <ValuationPage />
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
          {/* Evidence: Data room · Documents · Verification merged into one
              tabbed surface (docs/22 F2). The :section param drives the sub-tab. */}
          <Route
            path="/engagement/:engagementId/evidence"
            element={
              <RequireAdvisor>
                <Shell>
                  <EvidencePage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId/evidence/:section"
            element={
              <RequireAdvisor>
                <Shell>
                  <EvidencePage />
                </Shell>
              </RequireAdvisor>
            }
          />
          {/* Redirects: the three surfaces used to be their own routes. Keep old
              links (bookmarks, prior sessions) working by folding them in. */}
          <Route path="/engagement/:engagementId/data-room" element={<RedirectToEvidence section="data-room" />} />
          <Route path="/engagement/:engagementId/documents" element={<RedirectToEvidence section="documents" />} />
          <Route path="/engagement/:engagementId/verification" element={<RedirectToEvidence section="verification" />} />
          <Route
            path="/review"
            element={
              <RequireStaff>
                <Shell>
                  <ReviewQueuePage />
                </Shell>
              </RequireStaff>
            }
          />
          <Route
            path="/review/:documentId"
            element={
              <RequireStaff>
                <Shell>
                  <ReviewDocumentPage />
                </Shell>
              </RequireStaff>
            }
          />
          <Route
            path="/library"
            element={
              <RequireAdvisor>
                <Shell>
                  <LibraryPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/security"
            element={
              <RequireAdvisor>
                <Shell>
                  <SecurityPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route path="/portal" element={<RequireOwner><OwnerShell><OwnerHomePage /></OwnerShell></RequireOwner>} />
          <Route path="/portal/plan" element={<RequireOwner><OwnerShell><OwnerPlanPage /></OwnerShell></RequireOwner>} />
          <Route path="/portal/learn" element={<RequireOwner><OwnerShell><OwnerLearnPage /></OwnerShell></RequireOwner>} />
          <Route path="/portal/documents" element={<RequireOwner><OwnerShell><OwnerDocumentsPage /></OwnerShell></RequireOwner>} />
          <Route path="/portal/connect" element={<RequireOwner><OwnerShell><OwnerConnectPage /></OwnerShell></RequireOwner>} />
          <Route path="/ledger/callback" element={<RequireAuth><LedgerCallbackPage /></RequireAuth>} />
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
            path="/assessment/:assessmentId/cim"
            element={
              <RequireAdvisor>
                <Shell>
                  <CimPage />
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
          <Route
            path="/settings/billing"
            element={
              <RequireAdvisor>
                <Shell>
                  <BillingPage />
                </Shell>
              </RequireAdvisor>
            }
          />
            <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
              </Suspense>
            </AuthProvider>
          </BrowserRouter>
        </ToastProvider>
      </QueryClientProvider>
      <Analytics />
    </ThemeProvider>
  );
}
