import { useEffect, useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { SignIn } from '@clerk/react';
import { isClerkStack, isDevStack, requiresClerkConfig, supabase } from '../lib/supabase';
import { BrandWordmark, ErrorState } from '../components/ui';
import { ThemeToggle } from '../lib/theme';
import { useClerkAppearance } from '../lib/clerkAppearance';
import { clearSignoutReason, peekSignoutReason } from '../lib/sessionExpiry';

export default function LoginPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();

  // Where to send the user after sign-in: the protected URL they were bounced
  // from (the route gates stash it in location.state.from), else the app root.
  const from = (location.state as { from?: { pathname?: string; search?: string } } | null)?.from;
  const returnTo = from?.pathname ? `${from.pathname}${from.search ?? ''}` : '/';

  // Why they're here (inactivity vs. expired session). Peek (a pure read) during
  // render so StrictMode's double-invoke is harmless, then clear it in an effect
  // once shown. The effect's cleanup cancels a not-yet-fired clear, so StrictMode
  // mounting/unmounting/remounting doesn't wipe the value before the real mount
  // reads it. A later refresh of /login finds it already cleared — no stale notice.
  const [signoutReason] = useState(peekSignoutReason);
  useEffect(() => {
    const id = setTimeout(clearSignoutReason, 0);
    return () => clearTimeout(id);
  }, []);

  const appearance = useClerkAppearance();

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
    navigate(returnTo);
  };

  const notice = signoutReason && (
    <div className="login-notice" role="status">
      {signoutReason === 'idle'
        ? 'You were signed out after a period of inactivity. Sign in to pick up where you left off.'
        : 'Your session expired. Sign in again to continue.'}
    </div>
  );

  // Under Clerk (the production standard), sign-in / sign-up / reset / MFA are all
  // handled by Clerk's hosted component; the route gates redirect to the app once
  // a session exists.
  if (isClerkStack) {
    return (
      <main className="login-page">
        <div className="login-topline">
          <ThemeToggle />
        </div>
        {notice}
        <SignIn routing="hash" signUpUrl="/sign-up" forceRedirectUrl={returnTo} appearance={appearance} />
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
          <BrandWordmark size="lg" />
          <p className="login-subtitle">Authentication is not configured</p>
          <p className="form-error">
            This deployment must use Clerk. Set <code>VITE_CLERK_PUBLISHABLE_KEY</code> (frontend) and{' '}
            <code>CLERK_JWKS_URL</code> (compute service), then redeploy. See docs/30.
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
      {notice}
      <form className="login-card" onSubmit={submit}>
        <BrandWordmark size="lg" />
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
        {error && <ErrorState variant="inline" error={error} />}
        <button type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        {isDevStack && (
          <p className="login-devnote">
            Local dev stack. Sign in with any provisioned email (scripts/admin.ts) and password
            &lsquo;demo&rsquo;.
          </p>
        )}
      </form>
    </main>
  );
}
