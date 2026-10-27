import { useState } from 'react';
import { Modal } from './Modal';
import { AccessEditor } from './AccessEditor';
import { supabase } from '../utils/supabase';
import { MIN_PASSWORD_LENGTH } from '../utils/passwordRules';
import {
  featuresForPages,
  presetAccess,
  type FeatureKey,
  type GrantablePageKey,
} from '../utils/accessCatalog';
import type { Outlet } from '../types';

interface AddUserModalProps {
  isOpen: boolean;
  outlets: Outlet[];
  onClose: () => void;
  onCreated: () => void;
}

export function AddUserModal({ isOpen, outlets, onClose, onCreated }: AddUserModalProps) {
  const staffPreset = presetAccess('staff');
  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'staff' | 'supervisor'>('staff');
  const [outletId, setOutletId] = useState('');
  const [pages, setPages] = useState<GrantablePageKey[]>(staffPreset.pages);
  const [features, setFeatures] = useState<FeatureKey[]>(staffPreset.features);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  function applyPreset(nextRole: 'staff' | 'supervisor') {
    const preset = presetAccess(nextRole);
    setRole(nextRole);
    setPages(preset.pages);
    setFeatures(preset.features);
    if (nextRole !== 'supervisor') setOutletId('');
  }

  function reset() {
    const preset = presetAccess('staff');
    setEmail('');
    setFullName('');
    setPassword('');
    setRole('staff');
    setOutletId('');
    setPages(preset.pages);
    setFeatures(preset.features);
    setMessage('');
    setSaving(false);
  }

  function close() {
    if (saving) return;
    reset();
    onClose();
  }

  async function handleCreate() {
    const trimmedEmail = email.trim().toLowerCase();
    const trimmedName = fullName.trim();
    if (!trimmedEmail || !trimmedEmail.includes('@')) {
      setMessage('Enter a valid email address.');
      return;
    }
    if (!trimmedName) {
      setMessage('Enter a display name.');
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setMessage(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (role === 'supervisor' && !outletId) {
      setMessage('Supervisors need an assigned outlet.');
      return;
    }

    setSaving(true);
    setMessage('');
    try {
      const granted = featuresForPages(features, pages);
      const { data, error } = await supabase.functions.invoke<{
        error?: string;
        success?: boolean;
        userId?: string;
      }>('admin_create_user', {
        body: {
          email: trimmedEmail,
          fullName: trimmedName,
          password,
          role,
          assignedOutletId: role === 'supervisor' ? outletId : null,
          pages,
          features: granted,
        },
      });
      if (error) {
        setMessage(error.message);
        return;
      }
      if (data?.error || !data?.success) {
        setMessage(data?.error ?? 'Could not create the user.');
        return;
      }
      reset();
      onCreated();
      onClose();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="Add user" isOpen={isOpen} onClose={close} size="lg">
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          Creates an account with a temporary password. The user must choose a new password the first time they sign in.
          Users, Change log, and Settings stay available only to admins.
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium uppercase text-gray-500">Email</span>
            <input
              type="email"
              autoComplete="off"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium uppercase text-gray-500">Display name</span>
            <input
              type="text"
              value={fullName}
              onChange={(event) => setFullName(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
          <label className="block text-sm sm:col-span-2">
            <span className="mb-1 block text-xs font-medium uppercase text-gray-500">Temporary password</span>
            <input
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </label>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => applyPreset('staff')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              role === 'staff' ? 'bg-slate-900 text-white' : 'border border-gray-200 text-gray-700'
            }`}
          >
            Staff preset
          </button>
          <button
            type="button"
            onClick={() => applyPreset('supervisor')}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${
              role === 'supervisor' ? 'bg-slate-900 text-white' : 'border border-gray-200 text-gray-700'
            }`}
          >
            Outlet supervisor
          </button>
        </div>
        {role === 'supervisor' && (
          <label className="block text-sm">
            <span className="mb-1 block text-xs font-medium uppercase text-gray-500">Outlet</span>
            <select
              value={outletId}
              onChange={(event) => setOutletId(event.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">Select outlet…</option>
              {outlets.map((outlet) => (
                <option key={outlet.id} value={outlet.id}>
                  {outlet.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <AccessEditor
          pages={pages}
          features={features}
          onChange={(next) => {
            setPages(next.pages);
            setFeatures(next.features);
          }}
          disabled={saving}
        />
        {message && (
          <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700" role="alert">
            {message}
          </div>
        )}
        <div className="flex gap-3">
          <button
            type="button"
            onClick={close}
            disabled={saving}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={saving}
            className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
          >
            {saving ? 'Creating…' : 'Create user'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
