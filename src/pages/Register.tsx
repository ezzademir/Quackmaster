import { useState } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { writeLedgerEntry } from '../utils/ledger';

export function Register() {
  const [form, setForm] = useState({
    full_name: '',
    email: '',
    password: '',
    confirm: '',
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [submitted, setSubmitted] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (form.password !== form.confirm) {
      setError('Passwords do not match');
      return;
    }
    if (form.password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }
    setLoading(true);

    const { data, error: signUpErr } = await supabase.auth.signUp({
      email: form.email,
      password: form.password,
      options: {
        data: { full_name: form.full_name, role: 'pending' },
      },
    });

    if (signUpErr) {
      setError(signUpErr.message);
      setLoading(false);
      return;
    }

    // Create profile with pending role
    if (data.user) {
      const { error: profileError } = await supabase.from('profiles').upsert({
        id: data.user.id,
        full_name: form.full_name,
        role: 'pending',
      });
      if (!profileError) {
        await writeLedgerEntry({
          action: 'created',
          entityType: 'profile',
          entityId: data.user.id,
          module: 'auth',
          operation: 'event',
          afterData: { full_name: form.full_name, role: 'pending' },
          metadata: { source: 'register' },
        });
      }

      if (profileError) {
        console.error('Profile creation error:', profileError);
      }

      // Create pending registration entry
      const { error: regError } = await supabase.from('pending_registrations').insert({
        user_id: data.user.id,
        email: form.email,
        full_name: form.full_name,
        status: 'pending',
        requested_at: new Date().toISOString(),
      });
      if (!regError) {
        await writeLedgerEntry({
          action: 'created',
          entityType: 'pending_registration',
          entityId: data.user.id,
          module: 'auth',
          operation: 'insert',
          afterData: { email: form.email, full_name: form.full_name, status: 'pending' },
          referenceId: data.user.id,
        });
      }

      if (regError) {
        console.error('Pending registration error:', regError);
        // Don't fail registration if pending_registrations insert fails
        // The profile was created, user can proceed to pending approval page
      }
    }

    setLoading(false);

    setSubmitted(true);
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4 py-10">
      <div className="w-full max-w-sm">
        {/* Brand */}
        <div className="mb-8 text-center">
          <img src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`} alt="Quackmaster" className="mx-auto mb-4 h-16 w-16" />
          <h1 className="text-2xl font-bold text-gray-900">Create Account</h1>
          <p className="mt-1 text-sm text-gray-500">Join Quackmaster ERP</p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-8 shadow-sm">
          {submitted ? (
            <div className="space-y-4">
              <div className="rounded-lg bg-green-50 px-4 py-3 text-sm text-green-700">
                <p className="font-medium mb-1">Registration submitted!</p>
                <p>Your account is pending admin approval. You'll receive an email once your request is reviewed.</p>
              </div>
              <Link to="/login" className="block text-center text-sm font-medium text-blue-600 hover:text-blue-800">
                Return to login
              </Link>
            </div>
          ) : (
            <>
              {error && (
                <div className="mb-5 rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Full Name</label>
              <input
                type="text"
                required
                value={form.full_name}
                onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Email address</label>
              <input
                type="email"
                autoComplete="email"
                required
                value={form.email}
                onChange={(e) => setForm({ ...form, email: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Password</label>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={form.password}
                onChange={(e) => setForm({ ...form, password: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <div>
              <label className="mb-1.5 block text-sm font-medium text-gray-700">Confirm Password</label>
              <input
                type="password"
                autoComplete="new-password"
                required
                value={form.confirm}
                onChange={(e) => setForm({ ...form, confirm: e.target.value })}
                className="w-full rounded-lg border border-gray-300 px-3 py-2.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-60 transition-colors"
            >
              {loading ? 'Creating account…' : 'Create Account'}
            </button>
          </form>

              <p className="mt-5 text-center text-sm text-gray-500">
                Already have an account?{' '}
                <Link to="/login" className="font-medium text-blue-600 hover:text-blue-800">
                  Sign in
                </Link>
              </p>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
