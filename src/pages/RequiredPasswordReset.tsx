import { useState } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { supabase, isSupabaseConfigured } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { MIN_PASSWORD_LENGTH } from '../utils/passwordRules';
import { LogOut } from 'lucide-react';

export function RequiredPasswordReset() {
  const { profile, signOut, refetchProfile, syncAuth } = useAuth();
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  if (!profile?.password_reset_required) {
    return <Navigate to="/" replace />;
  }

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
      const { error: updErr } = await supabase.auth.updateUser({ password });
      if (updErr) {
        setError(updErr.message);
        return;
      }
      const { error: profileErr } = await supabase
        .from('profiles')
        .update({ password_reset_required: false })
        .eq('id', profile.id);
      if (profileErr) {
        setError(profileErr.message);
        return;
      }
      await refetchProfile();
      await syncAuth();
      navigate('/', { replace: true });
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    await signOut();
    navigate('/login', { replace: true });
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
        <img
          src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`}
          alt="Quackmaster"
          className="mx-auto mb-6 h-16 w-16"
        />
        <h1 className="text-xl font-bold text-gray-900 text-center mb-1">New password required</h1>
        <p className="text-sm text-gray-600 text-center mb-6">
          An administrator required a password change for your account. Choose a new password to continue.
        </p>

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
            {loading ? 'Saving…' : 'Continue'}
          </button>
        </form>

        <button
          type="button"
          onClick={() => void handleSignOut()}
          className="mt-4 w-full flex items-center justify-center gap-2 rounded-lg border border-gray-200 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <LogOut size={16} />
          Sign out
        </button>
      </div>
    </div>
  );
}
