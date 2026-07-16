import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface Profile {
  id: string;
  user_id: string;
  firm_id: string | null;
  role: 'admin' | 'advisor' | 'reviewer' | 'owner';
  full_name: string | null;
  email: string | null;
  company_id: string | null;
}

interface AuthState {
  session: Session | null;
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [firmName, setFirmName] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session);
      if (!data.session) setLoading(false);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, next) => {
      setSession(next);
      if (!next) {
        setProfile(null);
        setFirmName(null);
        setLoading(false);
      }
    });
    return () => sub.subscription.unsubscribe();
  }, []);

  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { data: prof } = await supabase
        .from('profiles')
        .select('*')
        .eq('user_id', session.user.id)
        .single();
      if (cancelled) return;
      setProfile((prof as Profile) ?? null);
      if (prof?.firm_id) {
        const { data: firm } = await supabase
          .from('firms')
          .select('*')
          .eq('id', prof.firm_id)
          .single();
        if (!cancelled) setFirmName(firm?.name ?? null);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [session]);

  const signOut = async () => {
    await supabase.auth.signOut();
  };

  return (
    <AuthContext.Provider value={{ session, profile, firmName, loading, signOut }}>
      {children}
    </AuthContext.Provider>
  );
}

export const useAuth = () => useContext(AuthContext);
