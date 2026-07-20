import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { SignIn } from '@clerk/react';
import { isClerkStack, isDevStack, requiresClerkConfig, supabase } from '../lib/supabase';
import { ThemeToggle } from '../lib/theme';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setError(error.message);
      return;
    }
    navigate('/');
  };

  // Under Clerk (the production standard), sign-in / sign-up / reset / MFA are all
  // handled by Clerk's hosted component; the route gates redirect to the app once
  // a session exists.
  if (isClerkStack) {
    return (
      <main className="login-page">
        <div className="login-topline">
          <ThemeToggle />
        </div>
        <SignIn routing="hash" />
      </main>
    );
  }

  // A hosted deployment without Clerk is unsupported: the Supabase-Auth password
  // login was removed when Clerk became the standard. Say so plainly instead of
  // rendering a login form that can't work.
  if (requiresClerkConfig) {
    return (
      <main className="login-page">
        <div className="login-topline">
          <ThemeToggle />
        </div>
        <div className="login-card">
          <h1>Exit Blueprint</h1>
          <p className="login-subtitle">Authentication is not configured</p>
          <p className="form-error">
            This deployment must use Clerk. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> (frontend) and{' '}
            <code>CLERK_JWKS_URL</code> (compute service), then redeploy — see docs/30.
          </p>
        </div>
      </main>
    );
  }

  // Local dev emulator: the only remaining password path (dev password 'demo').
  return (
    <main className="login-page">
      <div className="login-topline">
        <ThemeToggle />
      </div>
      <form className="login-card" onSubmit={submit}>
        <h1>Exit Blueprint</h1>
        <p className="login-subtitle">Sign in to your exit-readiness workspace</p>
        <label>
          Email
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </label>
        {error && <p className="form-error">{error}</p>}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {isDevStack && (
          <p className="login-devnote">
            Local dev stack — sign in with any provisioned email (scripts/admin.ts) and password
            &lsquo;demo&rsquo;.
          </p>
        )}
      </form>
    </main>
  );
}
