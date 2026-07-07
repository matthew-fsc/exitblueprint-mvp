import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './lib/auth';
import { isDevStack } from './lib/supabase';
import LoginPage from './pages/LoginPage';
import ClientsPage from './pages/ClientsPage';
import HealthPage from './pages/HealthPage';
import VerifyPage from './pages/VerifyPage';
import type { ReactNode } from 'react';

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

function Shell({ children }: { children: ReactNode }) {
  const { firmName, profile, signOut } = useAuth();
  return (
    <main className="page">
      <header className="page-header shell-header">
        <div>
          <h1>Exit Blueprint</h1>
          <p className="subtitle">{firmName ?? 'Advisor workspace'}</p>
        </div>
        <nav className="shell-nav">
          <Link to="/">Clients</Link>
          <span className="shell-user">
            {profile?.email}
            {isDevStack && <span className="dev-badge">dev stack</span>}
          </span>
          <button className="linkish" onClick={signOut}>
            Sign out
          </button>
        </nav>
      </header>
      {children}
    </main>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/health" element={<main className="page"><HealthPage /></main>} />
          <Route path="/dev/verify" element={<main className="page"><VerifyPage /></main>} />
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
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
