import { createContext, useContext, useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';
import { supabase } from './supabase';

interface Profile {
  id: string;
  full_name: string;
  role: 'admin' | 'staff' | 'pending';
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

const SESSION_INIT_TIMEOUT_MS = 15000;

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);

  async function fetchProfile(userId: string) {
    const { data, error } = await supabase
      .from('profiles')
      .select('id, full_name, role')
      .eq('id', userId)
      .maybeSingle();
    if (error) {
      console.error('Profile fetch error:', error);
      setProfile(null);
    } else {
      setProfile(data as Profile | null);
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
    let timedOut = false;
    const timer = window.setTimeout(() => {
      timedOut = true;
      if (!mounted) return;
      console.warn(
        '[Quackmaster] Auth session check timed out. Verify Supabase URL/key, network, or try disabling browser extensions that inject into pages.'
      );
      setSession(null);
      setProfile(null);
      setProfileLoading(false);
      setLoading(false);
    }, SESSION_INIT_TIMEOUT_MS);

    async function loadProfileForUser(userId: string) {
      setProfileLoading(true);
      try {
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
        if (!mounted || timedOut) return;

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
        if (mounted && !timedOut) {
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
    } = supabase.auth.onAuthStateChange(async (_event, session) => {
      setSession(session);
      setLoading(false);
      try {
        if (session?.user) {
          setProfileLoading(true);
          await fetchProfile(session.user.id);
        } else {
          setProfile(null);
        }
      } catch (e) {
        console.error('Profile load failed:', e);
        setProfile(null);
      } finally {
        setProfileLoading(false);
      }
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
