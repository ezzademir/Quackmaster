import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import type { Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../utils/supabase';
import { MIN_PASSWORD_LENGTH } from '../utils/passwordRules';

export function ResetPassword() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [phase, setPhase] = useState<'checking' | 'ready' | 'invalid'>('checking');

  useEffect(() => {
    let cancelled = false;

    function considerSession(session: Session | null, source: string) {
      if (cancelled) return;
      if (session?.user) {
        setPhase('ready');
        return;
      }
      if (source === 'timeout') {
        setPhase('invalid');
      }
    }

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        considerSession(session, event);
      }
    });

    void supabase.auth.getSession().then(({ data: { session } }) => {
      considerSession(session, 'getSession');
    });

    const t = window.setTimeout(() => {
      if (cancelled) return;
      void supabase.auth.getSession().then(({ data: { session } }) => {
        if (session?.user) {
          setPhase('ready');
        } else {
          setPhase((p) => (p === 'ready' ? 'ready' : 'invalid'));
        }
      });
    }, 2500);

    return () => {
      cancelled = true;
      subscription.unsubscribe();
      window.clearTimeout(t);
    };
  }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    if (!isSupabaseConfigured) {
      setError('Supabase is not configured.');
      return;
    }
    if (password !== confirm) {
      setError('Passwords do not match');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters`);
      return;
    }
    setLoading(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) {
        setError(updErr.message);
        return;
      }
      const uid = session?.user?.id;
      if (uid) {
        await supabase.from('profiles').update({ password_reset_required: false }).eq('id', uid);
      }
      await supabase.auth.signOut();
      navigate('/login', { replace: true, state: { resetSuccess: true } });
    } finally {
      setLoading(false);
    }
  }

  if (phase === 'checking') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="text-center text-sm text-gray-600">Verifying reset link…</div>
      </div>
    );
  }

  if (phase === 'invalid') {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
        <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm text-center">
          <p className="text-sm text-gray-700 mb-4">
            This reset link is invalid or expired. Request a new one from your administrator or use forgot password if
            available.
          </p>
          <Link to="/login" className="text-sm font-medium text-blue-600 hover:text-blue-800">
            Back to sign in
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <img
          src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`}
          alt="Quackmaster"
          className="mx-auto mb-6 h-16 w-16"
        />
        <h1 className="text-xl font-bold text-gray-900 text-center mb-1">Set new password</h1>
        <p className="text-sm text-gray-600 text-center mb-6">Enter a new password for your account.</p>

        {error && (
          <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">New password</label>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <div>
            <label className="mb-1.5 block text-sm font-medium text-gray-700">Confirm password</label>
            <input
              type="password"
              autoComplete="new-password"
              required
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
            />
          </div>
          <button
            type="submit"
            disabled={loading || !isSupabaseConfigured}
            className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
          >
            {loading ? 'Saving…' : 'Update password'}
          </button>
        </form>

        <Link to="/login" className="mt-4 block text-center text-sm text-blue-600 hover:text-blue-800">
          Back to sign in
        </Link>
      </div>
    </div>
  );
}
