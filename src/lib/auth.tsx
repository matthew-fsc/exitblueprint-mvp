import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { useAuth as useClerkAuth } from '@clerk/react';
import { isClerkStack, registerClerkToken, supabase } from './supabase';

// Idle-session timeout: sign out after this long with no user activity. A
// vendor-DD control ("automatic shutdown of inactive sessions"). 30 minutes.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export interface Profile {
  id: string;
  user_id: string;
  firm_id: string | null;
  role: 'admin' | 'advisor' | 'reviewer' | 'owner';
  full_name: string | null;
  email: string | null;
  company_id: string | null;
}

// A signed-in subject. Under Clerk this is the Clerk user id; under Supabase Auth
// the Supabase uuid — both live in profiles.user_id (text since the identity
// migration). Consumers only check truthiness + read the id, so one shape serves
// both providers and the rest of the app is identity-provider agnostic.
export interface AuthSession {
  userId: string;
}

interface AuthState {
  session: AuthSession | null;
  profile: Profile | null;
  firmName: string | null;
  loading: boolean;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthState>({
  session: null,
  profile: null,
  firmName: null,
  loading: true,
  signOut: async () => {},
});

// Load the profile + firm-name for a signed-in subject. Shared by both providers;
// the `profiles`/`firms` lookups are identical regardless of who issued the token
// (RLS resolves the caller from the verified JWT subject either way).
function useProfile(userId: string | null): {
  profile: Profile | null;
  firmName: string | null;
  profileLoading: boolean;
} {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [firmName, setFirmName] = useState<string | null>(null);
  const [profileLoading, setProfileLoading] = useState(false);

  useEffect(() => {
    if (!userId) {
      setProfile(null);
      setFirmName(null);
      setProfileLoading(false);
      return;
    }
    let cancelled = false;
    setProfileLoading(true);
    (async () => {
      // Provisioning is eventually-consistent: on first sign-in the Clerk webhook
      // writes the profile a beat later, and the Clerk→supabase token needs a
      // moment to attach (an unauthenticated read returns 0 rows under RLS). So a
      // first miss is not terminal — retry a few times with backoff before giving
      // up, which keeps the "no profile" gate from flashing right after sign-in.
      // No added latency in the normal case: the first attempt has no delay and we
      // stop as soon as a row appears.
      const backoffMs = [0, 500, 1000, 2000, 3500]; // ~7s total across 5 attempts
      let prof: Profile | null = null;
      for (const delay of backoffMs) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        if (cancelled) return;
        // maybeSingle, not single: a 0-row result here is expected (provisioning
        // lag on first sign-in, and the RLS-gated read below returns 0 rows until
        // the Clerk token attaches). single() would 406 on every miss, spraying
        // red "database" errors in the console across the whole retry loop.
        const { data } = await supabase.from('profiles').select('*').eq('user_id', userId).maybeSingle();
        if (cancelled) return;
        if (data) {
          prof = data as Profile;
          break;
        }
      }
      setProfile(prof);
      if (prof?.firm_id) {
        const { data: firm } = await supabase.from('firms').select('*').eq('id', prof.firm_id).maybeSingle();
        if (!cancelled) setFirmName(firm?.name ?? null);
      } else {
        setFirmName(null);
      }
      if (!cancelled) setProfileLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId]);

  return { profile, firmName, profileLoading };
}

// Automatic shutdown of inactive sessions (vendor-DD control): call `onIdle`
// after IDLE_TIMEOUT_MS with no activity. Only armed while signed in.
function useIdleTimeout(active: boolean, onIdle: () => void): void {
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout>;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(onIdle, IDLE_TIMEOUT_MS);
    };
    const events = ['mousedown', 'keydown', 'scroll', 'touchstart', 'visibilitychange'] as const;
    for (const e of events) window.addEventListener(e, reset, { passive: true });
    reset();
    return () => {
      clearTimeout(timer);
      for (const e of events) window.removeEventListener(e, reset);
    };
    // onIdle is stable per provider; deps intentionally limited to `active`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);
}

// ── Dev-emulator auth provider (local dev + CI only) ──────────────────────────
// Session/token come from supabase.auth talking to the local dev emulator
// (dev/supabase-dev-server.ts). Active only when Clerk is not configured — i.e.
// local dev and CI. Production always runs the Clerk provider below; the hosted
// Supabase-Auth login this once served was removed when Clerk became standard.
function DevAuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [authLoading, setAuthLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setAuthLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) setAuthLoading(false);
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  const userId = session?.user.id ?? null;
  const { profile, firmName, profileLoading } = useProfile(userId);

  useEffect(() => {
    if (session && !profileLoading) setAuthLoading(false);
  }, [session, profileLoading]);

  useIdleTimeout(!!session, () => {
    void supabase.auth.signOut();
  });

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider
      value={{ session: userId ? { userId } : null, profile, firmName, loading: authLoading, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// ── Clerk provider (production identity, docs/30) ─────────────────────────────
// Session + JWT come from Clerk; the token is registered as supabase-js's access
// token (third-party auth) and used as the Bearer for /functions/*. The profile
// lookup is unchanged. Only mounted when VITE_CLERK_PUBLISHABLE_KEY is set, so
// its Clerk hooks always run inside <ClerkProvider> (wired in main.tsx).
function ClerkAuthProvider({ children }: { children: ReactNode }) {
  const { isLoaded, isSignedIn, userId, getToken, signOut: clerkSignOut } = useClerkAuth();

  // Hand Clerk's session token to supabase.ts so REST/RLS and /functions/* are
  // authenticated as the Clerk subject. Cleared on unmount.
  useEffect(() => {
    registerClerkToken(() => getToken());
    return () => registerClerkToken(null);
  }, [getToken]);

  const activeUserId = isSignedIn ? (userId ?? null) : null;
  const { profile, firmName, profileLoading } = useProfile(activeUserId);

  useIdleTimeout(!!activeUserId, () => {
    void clerkSignOut();
  });

  const signOut = async () => {
    await clerkSignOut();
  };

  const loading = !isLoaded || (!!activeUserId && profileLoading);

  return (
    <AuthContext.Provider
      value={{
        session: activeUserId ? { userId: activeUserId } : null,
        profile,
        firmName,
        loading,
        signOut,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

// The active provider is fixed at build time by whether Clerk is configured, so
// each provider consistently calls its own hooks (no conditional-hook hazard).
// Clerk in production; the dev emulator locally.
export const AuthProvider = isClerkStack ? ClerkAuthProvider : DevAuthProvider;

export const useAuth = () => useContext(AuthContext);
