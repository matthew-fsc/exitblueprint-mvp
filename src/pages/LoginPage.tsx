import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { isDevStack, supabase } from '../lib/supabase';
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

  return (
    <main className="login-page">
      <div className="login-topline">
        <ThemeToggle />
      </div>
      <form className="login-card" onSubmit={submit}>
        <h1>Exit Blueprint</h1>
        <p className="login-subtitle">Advisor workspace</p>
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
