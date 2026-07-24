import { BrowserRouter, NavLink, Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { QueryCache, QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query';
import { describeError } from './lib/errors';
import { notifySessionExpired } from './lib/sessionExpiry';
import { SpeedInsights } from '@vercel/speed-insights/react';
import { AuthProvider, useAuth } from './lib/auth';
import { ThemeProvider, ThemeToggle } from './lib/theme';
import { isDevStack, isClerkStack, invokeFunction } from './lib/supabase';
import { openUserProfile } from './lib/clerkActions';
import { useActiveAssessment } from './lib/queries';
import { FirmMark, ToastProvider, LoadingState, ErrorState } from './components/ui';
import { UserMenu } from './components/UserMenu';
import { BrandingProvider, useBrand } from './lib/branding';
import { Analytics } from '@vercel/analytics/react';
import { lazy, Suspense, useEffect, useState, type ReactNode } from 'react';
import { LegalFooter } from './components/LegalFooter';
import LoginPage from './pages/LoginPage';
import SignUpPage from './pages/SignUpPage';

// Route-level code-splitting (frontend audit / docs/32): every page except the
// login screen (first paint) is loaded on demand, so the initial bundle is the
// shell + login rather than all ~30 route modules. <Suspense> (below) streams a
// page loading state while each chunk downloads.
const DashboardPage = lazy(() => import('./pages/DashboardPage'));
const EngagementPage = lazy(() => import('./pages/EngagementPage'));
const DeliverablesPage = lazy(() => import('./pages/DeliverablesPage'));
const RoadmapPage = lazy(() => import('./pages/RoadmapPage'));
const BuyerLensPage = lazy(() => import('./pages/BuyerLensPage'));
const DiligenceQaPage = lazy(() => import('./pages/DiligenceQaPage'));
const LibraryPage = lazy(() => import('./pages/LibraryPage'));
const BuyersPage = lazy(() => import('./pages/BuyersPage'));
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
const EvidencePage = lazy(() => import('./pages/EvidencePage'));
const ReviewQueuePage = lazy(() => import('./pages/ReviewQueuePage'));
const ReviewDocumentPage = lazy(() => import('./pages/ReviewDocumentPage'));
const OrganizationPage = lazy(() => import('./pages/OrganizationPage'));
const BillingPage = lazy(() => import('./pages/BillingPage'));
const HealthPage = lazy(() => import('./pages/HealthPage'));
const VerifyPage = lazy(() => import('./pages/VerifyPage'));
const ComponentsPage = lazy(() => import('./pages/ComponentsPage'));
// Internal platform-ops console (docs/38/40). A standalone superadmin surface —
// its own chrome, read-only over the service-role analytics rail; the server
// (/internal/metrics, PLATFORM_SUPERADMIN_IDS) enforces the real gate.
const PlatformConsolePage = lazy(() => import('./pages/PlatformConsolePage'));
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
        message="If you just signed in, give it a moment. Provisioning finishes a beat after your first sign-in. If this keeps happening, contact your administrator."
        onRetry={() => window.location.reload()}
        retryLabel="Refresh"
      />
    </main>
  );
}

function RequireAdvisor({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  // Owners and view-only collaborators both live in the read-only portal.
  if (profile?.role === 'owner' || profile?.role === 'collaborator') return <Navigate to="/portal" replace />;
  // A pure reviewer has no advisor workspace — send them to the review queue.
  if (profile?.role === 'reviewer') return <Navigate to="/review" replace />;
  if (!profile || (profile.role !== 'advisor' && profile.role !== 'admin')) {
    return <ProfileNotReady />;
  }
  // R5 (MFA) is enforced by Clerk as a session/org policy now that identity lives
  // there (docs/30) — personal security is managed in the Clerk account modal,
  // not an in-app page — so there's no in-app enrollment gate to run here.
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

// Organization administration (team, branding, directory, engagement ownership):
// admins only. Advisors have firm-scoped data access but these are org controls,
// so a non-admin advisor is sent back to their workspace. RLS enforces the same
// boundary server-side; this guard is the matching UI gate.
function RequireAdmin({ children }: { children: ReactNode }) {
  const { session, profile, loading } = useAuth();
  const location = useLocation();
  if (loading) return <main className="page"><LoadingState variant="page" /></main>;
  if (!session) return <Navigate to="/login" replace state={{ from: location }} />;
  if (profile?.role === 'owner' || profile?.role === 'collaborator') return <Navigate to="/portal" replace />;
  // A non-admin advisor has no org controls — send them back to their workspace.
  if (profile?.role !== 'admin') return <Navigate to="/" replace />;
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

// The owner report, delta report, and CIM used to be their own routes; they are
// now sub-tabs of the one Deliverables studio (src/pages/DeliverablesPage.tsx).
// These keep old links (bookmarks, prior sessions, in-app links) working by
// folding them into the studio deep-linked to the right document and assessment.
function RedirectEngagementDeliverable({ section }: { section: string }) {
  const { engagementId } = useParams();
  return <Navigate to={`/engagement/${engagementId}/deliverables/${section}`} replace />;
}

function RedirectAssessmentDeliverable({ section }: { section: string }) {
  const { assessmentId } = useParams();
  const assessmentQ = useActiveAssessment(assessmentId);
  const engagementId = assessmentQ.data?.engagement_id;
  if (assessmentQ.isLoading) return <LoadingState />;
  if (!engagementId) return <Navigate to="/" replace />;
  return (
    <Navigate
      to={`/engagement/${engagementId}/deliverables/${section}?assessment=${assessmentId}`}
      replace
    />
  );
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
            <NavLink to="/buyers" className="app-nav-link">
              Buyers
            </NavLink>
            {profile?.role === 'admin' && (
              <NavLink to="/organization" className="app-nav-link">
                Organization
              </NavLink>
            )}
          </AppNav>
        </div>
        <div className="app-bar-right">
          {isDevStack && <span className="dev-badge">Dev</span>}
          <ThemeToggle />
          <span className="app-bar-divider" aria-hidden />
          {/* The avatar menu carries the personal + billing concerns that don't
              belong in the daily-workflow nav: Profile opens the Clerk account
              modal (name, password, two-factor), and Billing is the firm plan.
              Organization is a primary nav tab (admins only), not a menu item. */}
          <UserMenu
            email={profile?.email}
            links={[
              ...(isClerkStack ? [{ label: 'Profile', onClick: openUserProfile }] : []),
              { to: '/billing', label: 'Billing' },
            ]}
            onSignOut={signOut}
          />
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
          {/* Public legal/trust pages (beta terms) — render their own page
              shell, no auth. Above the catch-all so they aren't swallowed. */}
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
          {/* Internal platform-ops console — a standalone superadmin surface with
              its own chrome (no advisor Shell / firm branding), read-only over the
              analytics rail. RequireAuth only gates "signed in"; the server's
              PLATFORM_SUPERADMIN_IDS gate is the real authority, and a non-superadmin
              just sees the access card. Not linked from any tenant nav. */}
          <Route
            path="/internal"
            element={
              <RequireAuth>
                <main className="page">
                  <PlatformConsolePage />
                </main>
              </RequireAuth>
            }
          />
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
            path="/engagement/:engagementId/diligence-qa"
            element={
              <RequireAdvisor>
                <Shell>
                  <DiligenceQaPage />
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
          {/* Deliverables studio — the one place client documents are curated
              (owner report · delta report · CIM), consolidated from three routes
              (docs/17 §5). :section selects the sub-tab; ?assessment= deep-links a
              specific assessment. */}
          <Route
            path="/engagement/:engagementId/deliverables"
            element={
              <RequireAdvisor>
                <Shell>
                  <DeliverablesPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId/deliverables/:section"
            element={
              <RequireAdvisor>
                <Shell>
                  <DeliverablesPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/engagement/:engagementId/delta"
            element={<RedirectEngagementDeliverable section="delta" />}
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
          <Route
            path="/buyers"
            element={
              <RequireAdvisor>
                <Shell>
                  <BuyersPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          {/* Playbooks retired: their tasks are Library items, grouped by Plans. */}
          <Route path="/playbooks" element={<Navigate to="/library" replace />} />
          {/* The standalone Network tab was removed — the professional directory
              it showed already lives on the Organization page, so old links fold
              back there rather than 404. */}
          <Route path="/network" element={<Navigate to="/organization" replace />} />
          {/* Personal security (MFA, password) lives in the Clerk account modal,
              reached from the avatar menu's Profile item — there is no in-app
              account page. Old /security and /settings links fold to the
              workspace; the firm plan keeps its own /billing route. */}
          <Route path="/security" element={<Navigate to="/" replace />} />
          <Route path="/settings" element={<Navigate to="/" replace />} />
          <Route path="/settings/billing" element={<Navigate to="/billing" replace />} />
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
          {/* The owner report and CIM moved into the Deliverables studio; keep the
              old per-assessment links working by folding them in (deep-linked to
              the document and the originating assessment). */}
          <Route
            path="/assessment/:assessmentId/report"
            element={<RequireAdvisor><RedirectAssessmentDeliverable section="owner" /></RequireAdvisor>}
          />
          <Route
            path="/assessment/:assessmentId/cim"
            element={<RequireAdvisor><RedirectAssessmentDeliverable section="cim" /></RequireAdvisor>}
          />
          <Route
            path="/billing"
            element={
              <RequireAdvisor>
                <Shell>
                  <BillingPage />
                </Shell>
              </RequireAdvisor>
            }
          />
          <Route
            path="/organization"
            element={
              <RequireAdmin>
                <Shell>
                  <OrganizationPage />
                </Shell>
              </RequireAdmin>
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
