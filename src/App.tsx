import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { describeError } from './lib/errors';
import { notifySessionExpired } from './lib/sessionExpiry';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ThemeToggle } from './lib/theme';
import { isDevStack, invokeFunction } from './lib/supabase';
import { FirmMark, ToastProvider, LoadingState, ErrorState } from './components/ui';
import { UserMenu } from './components/UserMenu';
import { BrandingProvider, useBrand } from './lib/branding';
import { Analytics } from '@vercel/analytics/react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { getMfaState, type MfaState } from './lib/mfa';
import { LegalFooter } from './components/LegalFooter';
import LoginPage from './pages/LoginPage';
import SignUpPage from './pages/SignUpPage';

// Route-level code-splitting (frontend audit / docs/32): every page except the
// login screen (first paint) is loaded on demand, so the initial bundle is the
// shell + login rather than all ~30 route modules. <Suspense> (below) streams a
// page loading state while each chunk downloads.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EngagementPage = lazy(() => import('./pages/EngagementPage'));
const DeltaReportPage = lazy(() => import('./pages/DeltaReportPage'));
const RoadmapPage = lazy(() => import('./pages/RoadmapPage'));
const BuyerLensPage = lazy(() => import('./pages/BuyerLensPage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const PlansPage = lazy(() => import('./pages/PlansPage'));
const ValuationPage = lazy(() => import('./pages/ValuationPage'));
const OwnerHomePage = lazy(() => import('./pages/owner/OwnerHomePage'));
const OwnerPlanPage = lazy(() => import('./pages/owner/OwnerPlanPage'));
const OwnerLearnPage = lazy(() => import('./pages/owner/OwnerLearnPage'));
const OwnerDocumentsPage = lazy(() => import('./pages/owner/OwnerDocumentsPage'));
const LedgerCallbackPage = lazy(() => import('./pages/LedgerCallbackPage'));
const IntakePage = lazy(() => import('./pages/IntakePage'));
const ResultsPage = lazy(() => import('./pages/ResultsPage'));
const WorkbenchPage = lazy(() => import('./pages/WorkbenchPage'));
const ReportPage = lazy(() => import('./pages/ReportPage'));
const CimPage = lazy(() => import('./pages/CimPage'));
const EvidencePage = lazy(() => import('./pages/EvidencePage'));
const ReviewQueuePage = lazy(() => import('./pages/ReviewQueuePage'));
const ReviewDocumentPage = lazy(() => import('./pages/ReviewDocumentPage'));
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
  // A stale/invalid session JWT surfaces as an auth-kind error on any query. No
  // refetch can fix it, so sign the user out here — the route gates then route to
  // /login (capturing where they were so login can return them). This is what
  // makes an expired session recover gracefully instead of the user hitting a
  // dead "Your session expired" card with a retry that re-fails.
  queryCache: new QueryCache({
    onError: (error) => {
      if (describeError(error).kind === 'auth') notifySessionExpired();
    },
  }),
});

// R5: advisor/admin accounts must satisfy MFA (bypassed on the dev stack). An
// un-enrolled or unverified advisor is sent to /settings (which hosts MFA setup)
// before anything else.
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
  // Owners and view-only collaborators both live in the read-only portal.
  if (profile?.role === 'owner' || profile?.role === 'collaborator') return <Navigate to="/portal" replace />;
  // A pure reviewer has no advisor workspace — send them to the review queue.
  if (profile?.role === 'reviewer') return <Navigate to="/review" replace />;
  if (!profile || (profile.role !== 'advisor' && profile.role !== 'admin')) {
    return <ProfileNotReady />;
  }
  if (mfa === 'loading') return <main className="page"><LoadingState variant="page" /></main>;
  // /settings is where MFA is set up, so it must stay reachable during the gate.
  if (mfa !== 'satisfied' && location.pathname !== '/settings') {
    return <Navigate to="/settings" replace />;
  }
  return <>{children}</>;
}

// Staff surfaces (the review queue): advisor, admin, or reviewer.
function RequireStaff({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile?.role === 'owner' || profile?.role === 'collaborator') return <Navigate to="/portal" replace />;
  if (!profile || !['advisor', 'admin', 'reviewer'].includes(profile.role)) {
    return <ProfileNotReady />;
  }
  return <>{children}</>;
}

// The read-only portal is home to both the business owner and any view-only
// external collaborator (CPA, attorney, …) invited to a single engagement.
function RequirePortal({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile && profile.role !== 'owner' && profile.role !== 'collaborator')
    return <Navigate to="/" replace />;
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

// The three Evidence surfaces were merged into one tabbed page (docs/archive/22 F2).
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

// The review queue is where uploaded documents become verified facts, but the
// nav gave no sign work was waiting there. This badge surfaces the pending count
// so the queue reads as an active inbox, not a page you have to remember to open.
function ReviewNavLink() {
  const { data: pending } = useQuery({
    queryKey: ['reviewQueue', 'count'],
    queryFn: async () => {
      const r = await invokeFunction<{ items: unknown[] }>('list-review-queue', {});
      return r.items.length;
    },
    staleTime: 60_000,
    retry: false,
  });
  return (
    <NavLink to="/review" className="app-nav-link">
      Review
      {pending != null && pending > 0 && (
        <span className="nav-count" aria-label={`${pending} awaiting review`}>{pending}</span>
      )}
    </NavLink>
  );
}

// Primary navigation wrapper. On desktop the links render as an inline row (the
// nav below just passes through). On a phone the row would overflow the bar, so
// the links collapse behind a hamburger that drops them as a full-width sheet;
// the sheet closes on navigate, Escape, or a tap on the backdrop. The CSS in the
// "Mobile optimization pass" section switches between the two by viewport width.
function AppNav({ children, ariaLabel }: { children: ReactNode; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const location = useLocation();
  // A tapped link changes the route — close the sheet so it doesn't linger over
  // the page the user just navigated to.
  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);
  return (
    <div className="app-nav-wrap">
      <button
        type="button"
        className="app-nav-toggle"
        aria-label={open ? 'Close menu' : 'Open menu'}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
          {open ? (
            <>
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </>
          ) : (
            <>
              <line x1="3" y1="6" x2="21" y2="6" />
              <line x1="3" y1="12" x2="21" y2="12" />
              <line x1="3" y1="18" x2="21" y2="18" />
            </>
          )}
        </svg>
      </button>
      <nav className={open ? 'app-nav app-nav-open' : 'app-nav'} aria-label={ariaLabel}>
        {children}
      </nav>
      {open && (
        <button
          type="button"
          className="app-nav-backdrop"
          aria-label="Close menu"
          tabIndex={-1}
          onClick={() => setOpen(false)}
        />
      )}
    </div>
  );
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
          <AppNav ariaLabel="Primary">
            <NavLink to="/" end className="app-nav-link">
              Engagements
            </NavLink>
            <ReviewNavLink />
            <NavLink to="/library" className="app-nav-link">
              Library
            </NavLink>
            <NavLink to="/plans" className="app-nav-link">
              Plans
            </NavLink>
            <NavLink to="/settings" className="app-nav-link">
              Settings
            </NavLink>
          </AppNav>
        </div>
        <div className="app-bar-right">
          {isDevStack && <span className="dev-badge">Dev</span>}
          <ThemeToggle />
          <span className="app-bar-divider" aria-hidden />
          {/* The standalone Security page was merged into Settings (MFA lives
              there now), so the account menu carries just Sign out; account &
              security settings are reachable from the Settings nav item. */}
          <UserMenu email={profile?.email} links={[]} onSignOut={signOut} />
        </div>
      </div>
    </header>
  );
}

function Shell({ children }: { children: ReactNode }) {
  return (
    <BrandingProvider>
      <div className="app-shell">
        <AppBar />
        <main className="page">{children}</main>
        <LegalFooter />
      </div>
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
          <AppNav ariaLabel="Primary">
            <NavLink to="/portal" end className="app-nav-link">Home</NavLink>
            <NavLink to="/portal/plan" className="app-nav-link">Your plan</NavLink>
            <NavLink to="/portal/learn" className="app-nav-link">Learn</NavLink>
            <NavLink to="/portal/documents" className="app-nav-link">Documents</NavLink>
          </AppNav>
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
      <div className="app-shell">
        <OwnerAppBar />
        <main className="page">{children}</main>
        <LegalFooter />
      </div>
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
          <Route path="/sign-up" element={<SignUpPage />} />
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
          {/* Clients merged into the Engagements tab (docs/archive/34): old links redirect. */}
          <Route path="/clients" element={<Navigate to="/" replace />} />
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
              tabbed surface (docs/archive/22 F2). The :section param drives the sub-tab. */}
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
            path="/plans"
            element={
              <RequireAdvisor>
                <Shell>
                  <PlansPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          {/* Security page merged into Settings (MFA lives there now; the data-
              protection summary moved to the legal footer). Old links redirect. */}
          <Route path="/security" element={<Navigate to="/settings" replace />} />
          <Route path="/portal" element={<RequirePortal><OwnerShell><OwnerHomePage /></OwnerShell></RequirePortal>} />
          <Route path="/portal/plan" element={<RequirePortal><OwnerShell><OwnerPlanPage /></OwnerShell></RequirePortal>} />
          <Route path="/portal/learn" element={<RequirePortal><OwnerShell><OwnerLearnPage /></OwnerShell></RequirePortal>} />
          <Route path="/portal/documents" element={<RequirePortal><OwnerShell><OwnerDocumentsPage /></OwnerShell></RequirePortal>} />
          {/* Accounting integration (QuickBooks/Xero) is not offered yet — the
              connect surface is hidden and the old route folds back to the portal
              home so any stale link stays harmless. */}
          <Route path="/portal/connect" element={<Navigate to="/portal" replace />} />
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
