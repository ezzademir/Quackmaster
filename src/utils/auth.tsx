import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

export interface Profile {
  id: string;
  full_name: string;
  role: 'admin' | 'staff' | 'pending';
  password_reset_required?: boolean | null;
}

interface AuthContextValue {
  session: Session | null;
  user: User | null;
  profile: Profile | null;
  isAdmin: boolean;
  /** Session bootstrap (getSession) — ends quickly once storage/network responds */
  loading: boolean;
  /** Profile row fetch after session exists — does not block login screen when logged out */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  refetchProfile: () => Promise<void>;
  /** Call after sign-in/sign-up so context matches Supabase before navigating to protected routes */
  syncAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  session: null,
  user: null,
  profile: null,
  isAdmin: false,
  loading: true,
  profileLoading: false,
  signOut: async () => {},
  refetchProfile: async () => {},
  syncAuth: async () => {},
});

const SESSION_INIT_TIMEOUT_MS = 30000;

/** Yield so Supabase Auth can finish _recoverAndRefresh / locks before REST runs (avoids stale stalls). */
function defer(ms = 100): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  const PROFILE_FETCH_MS = 20000;

  async function fetchProfile(userId: string): Promise<void> {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const query = supabase
        .from('profiles')
        .select('id, full_name, role, password_reset_required')
        .eq('id', userId)
        .maybeSingle();

      const outcome = await Promise.race([
        query.then((r) => ({ ok: true as const, r })),
        new Promise<{ ok: false }>((resolve) => {
          window.setTimeout(() => resolve({ ok: false }), PROFILE_FETCH_MS);
        }),
      ]);

      if (outcome.ok) {
        const { data, error } = outcome.r;
        if (error) {
          console.error('Profile fetch error:', error);
          setProfile(null);
        } else {
          const row = data as Profile | null;
          setProfile(
            row
              ? {
                  ...row,
                  password_reset_required: Boolean(row.password_reset_required),
                }
              : null
          );
        }
        return;
      }

      if (attempt === 1) {
        console.warn('[Quackmaster] Profile fetch slow; retrying after auth settles…');
        await defer(400);
        continue;
      }

      console.error(
        'Profile fetch timed out — check Supabase URL, RLS on `profiles`, extensions blocking REST, or network.'
      );
      setProfile(null);
    }
  }

  /** Keeps React auth state in sync with the Supabase client (avoids navigating before session exists in context). */
  async function syncAuth() {
    const {
      data: { session: next },
      error,
    } = await supabase.auth.getSession();
    if (error) {
      console.error('syncAuth getSession error:', error);
    }
    setSession(next ?? null);
    setLoading(false);
    if (next?.user) {
      setProfileLoading(true);
      try {
        await defer(80);
        await fetchProfile(next.user.id);
      } catch (e) {
        console.error('Profile load failed:', e);
        setProfile(null);
      } finally {
        setProfileLoading(false);
      }
    } else {
      setProfile(null);
      setProfileLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    const timer = window.setTimeout(() => {
      if (!mounted) return;
      console.warn(
        '[Quackmaster] Auth bootstrap is taking unusually long. If the app works, you can ignore this. Otherwise check Supabase URL/key, network, or Safari storage / extensions.'
      );
      setLoading(false);
      setProfileLoading(false);
    }, SESSION_INIT_TIMEOUT_MS);

    async function loadProfileForUser(userId: string) {
      setProfileLoading(true);
      try {
        await defer(80);
        if (!mounted) return;
        await fetchProfile(userId);
      } catch (e) {
        console.error('Profile load failed:', e);
        setProfile(null);
      } finally {
        if (mounted) setProfileLoading(false);
      }
    }

    async function init() {
      try {
        const {
          data: { session },
        } = await supabase.auth.getSession();
        window.clearTimeout(timer);
        if (!mounted) return;

        setSession(session);
        setLoading(false);

        if (session?.user) {
          await loadProfileForUser(session.user.id);
        } else {
          setProfile(null);
          setProfileLoading(false);
        }
      } catch (e) {
        window.clearTimeout(timer);
        console.error('Auth init failed:', e);
        if (mounted) {
          setSession(null);
          setProfile(null);
          setProfileLoading(false);
          setLoading(false);
        }
      }
    }

    void init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      window.clearTimeout(timer);
      setSession(nextSession);
      setLoading(false);

      if (!nextSession?.user) {
        setProfile(null);
        setProfileLoading(false);
        return;
      }

      // Important: keep this listener synchronous — async work deadlocks some auth refresh paths.
      setProfileLoading(true);
      const uid = nextSession.user.id;
      void (async () => {
        await defer(120);
        if (!mounted) return;
        try {
          await fetchProfile(uid);
        } catch (e) {
          console.error('Profile load failed:', e);
          setProfile(null);
        } finally {
          if (mounted) setProfileLoading(false);
        }
      })();
    });

    return () => {
      mounted = false;
      window.clearTimeout(timer);
      subscription.unsubscribe();
    };
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
  }

  async function refetchProfile() {
    if (session?.user) {
      await defer(0);
      await fetchProfile(session.user.id);
    }
  }

  return (
    <AuthContext.Provider value={{
      session,
      user: session?.user ?? null,
      profile,
      isAdmin: profile?.role?.toLowerCase?.()?.trim() === 'admin',
      loading,
      profileLoading,
      signOut,
      refetchProfile,
      syncAuth,
    }}>
      {children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  return useContext(AuthContext);
}
