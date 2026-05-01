import { useState, useEffect, useMemo } from 'react';
import { supabase, isSupabaseConfigured } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { Modal } from '../components/Modal';
import {
  AlertCircle,
  Check,
  X,
  Clock,
  RotateCw,
  CheckCircle,
  Shield,
  Mail,
  KeyRound,
  Copy,
  Search,
  PanelRightClose,
} from 'lucide-react';
import { writeLedgerEntry } from '../utils/ledger';
import { getPasswordRecoveryRedirectUrl, MIN_PASSWORD_LENGTH } from '../utils/passwordRules';

interface UserRecord {
  id: string;
  email: string;
  full_name: string;
  role: string;
  last_login: string | null;
  password_reset_required: boolean;
  created_at: string;
}

interface PendingUser extends UserRecord {
  status: string;
  requested_at: string;
  registration_id?: string;
}

interface RejectedRegistrationRow extends PendingUser {
  rejection_reason?: string | null;
  reviewed_at?: string | null;
}

type DrawerState =
  | { open: false }
  | { open: true; tab: 'approved'; user: UserRecord }
  | { open: true; tab: 'pending'; user: PendingUser }
  | { open: true; tab: 'rejected'; row: RejectedRegistrationRow };

export function Users() {
  const { isAdmin, user: authUser } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [rejectedUsers, setRejectedUsers] = useState<RejectedRegistrationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'approved' | 'pending' | 'rejected'>('approved');
  const [loadError, setLoadError] = useState('');
  const [busyRoleUserId, setBusyRoleUserId] = useState<string | null>(null);
  const [roleNotice, setRoleNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [drawer, setDrawer] = useState<DrawerState>({ open: false });
  const [nameDraft, setNameDraft] = useState('');
  const [nameSaving, setNameSaving] = useState(false);

  const [sendEmailModalOpen, setSendEmailModalOpen] = useState(false);
  const [sendEmailTarget, setSendEmailTarget] = useState<UserRecord | null>(null);
  const [sendEmailLoading, setSendEmailLoading] = useState(false);
  const [sendEmailMessage, setSendEmailMessage] = useState('');

  const [tempPassModalOpen, setTempPassModalOpen] = useState(false);
  const [tempPassUser, setTempPassUser] = useState<UserRecord | null>(null);
  const [tempPassNew, setTempPassNew] = useState('');
  const [tempPassConfirm, setTempPassConfirm] = useState('');
  const [tempPassLoading, setTempPassLoading] = useState(false);
  const [tempPassMessage, setTempPassMessage] = useState('');

  const q = searchQuery.trim().toLowerCase();
  const filteredUsers = useMemo(
    () =>
      users.filter(
        (u) =>
          !q ||
          u.email.toLowerCase().includes(q) ||
          (u.full_name || '').toLowerCase().includes(q)
      ),
    [users, q]
  );
  const filteredPending = useMemo(
    () =>
      pendingUsers.filter(
        (u) =>
          !q ||
          u.email.toLowerCase().includes(q) ||
          (u.full_name || '').toLowerCase().includes(q)
      ),
    [pendingUsers, q]
  );
  const filteredRejected = useMemo(
    () =>
      rejectedUsers.filter(
        (r) =>
          !q ||
          r.email.toLowerCase().includes(q) ||
          (r.full_name || '').toLowerCase().includes(q)
      ),
    [rejectedUsers, q]
  );

  useEffect(() => {
    if (!isAdmin) {
      setLoading(false);
      return;
    }
    loadUsers();
  }, [isAdmin]);

  async function loadUsers() {
    setLoading(true);
    setLoadError('');
    try {
      type RpcPayload = {
        error?: string;
        message?: string;
        approved?: Array<{
          id: string;
          full_name: string;
          role: string;
          last_login: string | null;
          password_reset_required: boolean;
          created_at: string;
          email: string;
        }>;
        pending?: Array<{
          id: string;
          registration_id?: string;
          email: string;
          full_name: string;
          status: string;
          requested_at: string;
          created_at: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
        }>;
        approved_registrations?: unknown;
        rejected_registrations?: Array<{
          id: string;
          registration_id?: string;
          email: string;
          full_name: string;
          status: string;
          requested_at: string;
          created_at: string;
          reviewed_at?: string | null;
          reviewed_by?: string | null;
          rejection_reason?: string | null;
        }>;
      };

      const { data: rpcData, error: rpcError } = await supabase.rpc('get_users_management_data');

      if (rpcError) {
        setLoadError(`${rpcError.message}${rpcError.code ? ` (${rpcError.code})` : ''}`);
        throw rpcError;
      }

      const payload = rpcData as RpcPayload | null;
      if (!payload || typeof payload !== 'object') {
        setLoadError('Invalid response from server');
        throw new Error('Invalid RPC payload');
      }

      if (payload.error === 'forbidden') {
        setLoadError(payload.message ?? 'Only admins can access user management');
        setUsers([]);
        setPendingUsers([]);
        setRejectedUsers([]);
        return;
      }

      const approvedRows = payload.approved ?? [];
      const pendingRows = payload.pending ?? [];
      const rejectedRows = payload.rejected_registrations ?? [];

      const usersWithEmail = approvedRows.map((p) => ({
        id: p.id,
        full_name: p.full_name,
        role: p.role,
        last_login: p.last_login,
        password_reset_required: p.password_reset_required,
        created_at: p.created_at,
        email: (p.email && p.email.trim() !== '' ? p.email : null) || 'Unknown',
      })) as UserRecord[];

      setUsers(usersWithEmail);

      const pendingWithStatus = pendingRows.map((p) => ({
        id: p.id,
        registration_id: p.registration_id,
        email: p.email,
        full_name: p.full_name,
        role: 'pending',
        last_login: null,
        password_reset_required: false,
        created_at: p.created_at,
        status: p.status,
        requested_at: p.requested_at,
      })) as PendingUser[];

      setPendingUsers(pendingWithStatus);

      const rejectedMapped = rejectedRows.map((r) => ({
        id: r.id,
        registration_id: r.registration_id,
        email: r.email,
        full_name: r.full_name,
        role: 'pending',
        last_login: null,
        password_reset_required: false,
        created_at: r.created_at,
        status: r.status,
        requested_at: r.requested_at,
        reviewed_at: r.reviewed_at ?? null,
        rejection_reason: r.rejection_reason ?? null,
      })) as RejectedRegistrationRow[];

      setRejectedUsers(rejectedMapped);
    } catch (error: unknown) {
      console.error('Error loading users:', error);
      setLoadError((prev) => {
        if (prev) return prev;
        const pg =
          error && typeof error === 'object'
            ? (error as { message?: string; code?: string })
            : undefined;
        if (pg?.message) return pg.code ? `${pg.message} (${pg.code})` : pg.message;
        return 'Failed to load users';
      });
    } finally {
      setLoading(false);
    }
  }

  async function handleForcePasswordReset() {
    if (!selectedUser) return;

    setResetLoading(true);
    setResetMessage('');

    try {
      const { error } = await supabase
        .from('profiles')
        .update({ password_reset_required: true })
        .eq('id', selectedUser.id);

      if (error) {
        setResetMessage(`Error: ${error.message}`);
        return;
      }

      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: selectedUser.id,
        module: 'users',
        operation: 'event',
        metadata: { password_reset_required: true, source: 'admin_require_password_change' },
      });

      setResetMessage(
        'User must choose a new password on next sign-in before accessing the app.'
      );
      await loadUsers();

      setTimeout(() => {
        setResetModalOpen(false);
        setSelectedUser(null);
        setResetMessage('');
      }, 2000);
    } catch (error) {
      setResetMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    } finally {
      setResetLoading(false);
    }
  }

  async function handleApproveUser(userId: string) {
    try {
      const reviewerId = (await supabase.auth.getUser()).data.user?.id;

      const { error: updateError } = await supabase.from('profiles').update({ role: 'staff' }).eq('id', userId);

      if (updateError) throw updateError;

      const { error } = await supabase
        .from('pending_registrations')
        .update({
          status: 'approved',
          reviewed_by: reviewerId,
          reviewed_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) {
        await supabase.from('profiles').update({ role: 'pending' }).eq('id', userId);
        throw error;
      }

      await writeLedgerEntry({
        action: 'approved',
        entityType: 'pending_registration',
        entityId: userId,
        module: 'users',
        operation: 'update',
        afterData: { status: 'approved', role: 'staff' },
      });

      await loadUsers();
      setDrawer({ open: false });
    } catch (error) {
      console.error('Error approving user:', error);
    }
  }

  async function handleSetRegisteredAdminRole(target: UserRecord, makeAdmin: boolean) {
    if (!authUser?.id || target.id === authUser.id) return;

    setBusyRoleUserId(target.id);
    setRoleNotice(null);

    try {
      const { data, error } = await supabase.rpc('set_registered_user_admin_role', {
        p_target_user_id: target.id,
        p_make_admin: makeAdmin,
      });

      if (error) throw error;

      const payload = data as {
        success?: boolean;
        error?: string;
        message?: string;
        role?: string;
      };

      if (!payload?.success) {
        setRoleNotice({
          tone: 'err',
          text: payload?.message ?? 'Could not update role',
        });
        return;
      }

      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: target.id,
        module: 'users',
        operation: 'event',
        metadata: {
          role_change: true,
          new_role: payload.role ?? (makeAdmin ? 'admin' : 'staff'),
        },
      });

      setRoleNotice({
        tone: 'ok',
        text: makeAdmin ? 'User promoted to admin.' : 'Admin access removed (staff).',
      });
      await loadUsers();
      if (drawer.open && drawer.tab === 'approved' && drawer.user.id === target.id) {
        const nextRole = payload.role ?? (makeAdmin ? 'admin' : 'staff');
        setDrawer({ open: true, tab: 'approved', user: { ...drawer.user, role: nextRole } });
      }
    } catch (error: unknown) {
      console.error('Error updating role:', error);
      const msg =
        error && typeof error === 'object' && 'message' in error
          ? String((error as { message: string }).message)
          : 'Failed to update role';
      setRoleNotice({ tone: 'err', text: msg });
    } finally {
      setBusyRoleUserId(null);
    }
  }

  async function handleRejectUser(userId: string) {
    try {
      const { error } = await supabase
        .from('pending_registrations')
        .update({
          status: 'rejected',
          reviewed_by: (await supabase.auth.getUser()).data.user?.id,
          reviewed_at: new Date().toISOString(),
        })
        .eq('user_id', userId);

      if (error) throw error;

      await writeLedgerEntry({
        action: 'rejected',
        entityType: 'pending_registration',
        entityId: userId,
        module: 'users',
        operation: 'update',
        afterData: { status: 'rejected' },
      });

      await loadUsers();
      setDrawer({ open: false });
    } catch (error) {
      console.error('Error rejecting user:', error);
    }
  }

  async function handleSaveDisplayName(userId: string) {
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setRoleNotice({ tone: 'err', text: 'Display name cannot be empty.' });
      return;
    }
    setNameSaving(true);
    setRoleNotice(null);
    try {
      const { error } = await supabase.from('profiles').update({ full_name: trimmed }).eq('id', userId);
      if (error) throw error;
      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: userId,
        module: 'users',
        operation: 'event',
        metadata: { source: 'admin_display_name', field: 'full_name' },
      });
      setRoleNotice({ tone: 'ok', text: 'Display name saved.' });
      await loadUsers();
      if (drawer.open && drawer.tab === 'approved' && drawer.user.id === userId) {
        setDrawer({ open: true, tab: 'approved', user: { ...drawer.user, full_name: trimmed } });
      }
    } catch (e: unknown) {
      const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message: string }).message) : 'Save failed';
      setRoleNotice({ tone: 'err', text: msg });
    } finally {
      setNameSaving(false);
    }
  }

  async function handleConfirmSendResetEmail() {
    const email = sendEmailTarget?.email;
    if (!email || email === 'Unknown') {
      setSendEmailMessage('Error: No email address available for this user.');
      return;
    }
    if (!isSupabaseConfigured) {
      setSendEmailMessage('Error: Supabase is not configured.');
      return;
    }
    setSendEmailLoading(true);
    setSendEmailMessage('');
    try {
      const redirectTo = getPasswordRecoveryRedirectUrl();
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
      if (error) {
        setSendEmailMessage(`Error: ${error.message}`);
        return;
      }
      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: sendEmailTarget!.id,
        module: 'users',
        operation: 'event',
        metadata: { source: 'admin_send_password_reset_email' },
      });
      setSendEmailMessage(
        `Reset instructions were sent to ${email} (if the account exists). Add this redirect URL in Supabase Auth settings: ${redirectTo}`
      );
      setTimeout(() => {
        setSendEmailModalOpen(false);
        setSendEmailTarget(null);
        setSendEmailMessage('');
      }, 3200);
    } finally {
      setSendEmailLoading(false);
    }
  }

  async function handleConfirmTempPassword() {
    if (!tempPassUser) return;
    if (tempPassNew !== tempPassConfirm) {
      setTempPassMessage('Error: Passwords do not match.');
      return;
    }
    if (tempPassNew.length < MIN_PASSWORD_LENGTH) {
      setTempPassMessage(`Error: Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    setTempPassLoading(true);
    setTempPassMessage('');
    try {
      const { data, error } = await supabase.functions.invoke<{ error?: string; success?: boolean }>(
        'admin_set_user_password',
        {
          body: { userId: tempPassUser.id, newPassword: tempPassNew },
        }
      );
      if (error) {
        setTempPassMessage(`Error: ${error.message}`);
        return;
      }
      const body = data as { error?: string; success?: boolean } | null;
      if (body?.error) {
        setTempPassMessage(`Error: ${body.error}`);
        return;
      }
      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: tempPassUser.id,
        module: 'users',
        operation: 'event',
        metadata: { source: 'admin_set_temporary_password' },
      });
      setTempPassMessage('Temporary password saved. User must sign in and complete password change.');
      setTempPassNew('');
      setTempPassConfirm('');
      await loadUsers();
      setTimeout(() => {
        setTempPassModalOpen(false);
        setTempPassUser(null);
        setTempPassMessage('');
      }, 2200);
    } finally {
      setTempPassLoading(false);
    }
  }

  function copyToClipboard(text: string) {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  function statusCell(user: UserRecord) {
    if (user.password_reset_required) {
      return (
        <div className="flex items-center gap-1">
          <AlertCircle size={14} className="text-amber-600" />
          <span className="text-amber-600 font-medium">Reset required</span>
        </div>
      );
    }
    if (user.last_login) {
      return (
        <div className="flex items-center gap-1">
          <CheckCircle size={14} className="text-green-600" />
          <span className="text-green-600 font-medium">Active</span>
        </div>
      );
    }
    return (
      <div className="flex items-center gap-1">
        <Clock size={14} className="text-gray-400" />
        <span className="text-gray-600">Never</span>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-gray-500">Loading users...</div>
      </div>
    );
  }

  const drawerApproved = drawer.open && drawer.tab === 'approved' ? drawer.user : null;

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className={`max-w-6xl mx-auto transition-[margin] ${drawer.open ? 'mr-[min(28rem,92vw)]' : ''}`}>
        <div className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">User Management</h1>
            <p className="mt-2 text-gray-600">
              Approve registrations, roles, and passwords. See{' '}
              <span className="font-medium text-gray-800">docs/AUTH_REDIRECTS.md</span> for recovery URL setup.
            </p>
          </div>
          <div className="relative max-w-md w-full">
            <Search
              size={18}
              className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-400"
            />
            <input
              type="search"
              placeholder="Search email or name…"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full rounded-lg border border-gray-300 py-2.5 pl-10 pr-3 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              aria-label="Search users"
            />
          </div>
        </div>

        {loadError && (
          <div className="mb-6 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            <p className="font-medium">Could not load users</p>
            <p className="mt-1">{loadError}</p>
            <button
              type="button"
              onClick={() => loadUsers()}
              className="mt-2 font-medium text-red-900 underline hover:no-underline"
            >
              Retry
            </button>
          </div>
        )}

        {roleNotice && (
          <div
            className={`mb-6 rounded-lg border px-4 py-3 text-sm ${
              roleNotice.tone === 'ok'
                ? 'border-green-200 bg-green-50 text-green-900'
                : 'border-red-200 bg-red-50 text-red-900'
            }`}
            role="status"
          >
            {roleNotice.text}
          </div>
        )}

        <div className="mb-6 flex flex-wrap gap-4 border-b border-gray-200">
          <button
            type="button"
            onClick={() => setActiveTab('approved')}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === 'approved'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Registered ({filteredUsers.length}
            {q ? ` of ${users.length}` : ''})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('pending')}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === 'pending'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Pending ({filteredPending.length}
            {q ? ` of ${pendingUsers.length}` : ''})
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('rejected')}
            className={`px-4 py-3 font-medium transition-colors ${
              activeTab === 'rejected'
                ? 'border-b-2 border-blue-600 text-blue-600'
                : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            Rejected ({filteredRejected.length}
            {q ? ` of ${rejectedUsers.length}` : ''})
          </button>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
          {activeTab === 'approved' &&
            (filteredUsers.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No registered users match your search</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Email
                      </th>
                      <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Name
                      </th>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Role
                      </th>
                      <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Status
                      </th>
                      <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Login
                      </th>
                      <th className="px-4 md:px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredUsers.map((user) => (
                      <tr key={user.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.email}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">
                          {user.full_name || 'N/A'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-xs sm:text-sm">
                          <span
                            className={`px-2 py-1 rounded-full text-xs font-medium ${
                              user.role === 'admin'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}
                          >
                            {user.role}
                          </span>
                        </td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4 text-xs">{statusCell(user)}</td>
                        <td className="hidden lg:table-cell px-4 md:px-6 py-4 text-xs text-gray-600">
                          {user.last_login ? new Date(user.last_login).toLocaleDateString() : 'N/A'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => {
                              setNameDraft(user.full_name ?? '');
                              setDrawer({ open: true, tab: 'approved', user });
                            }}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-blue-50 text-blue-700 rounded-lg hover:bg-blue-100 transition-colors text-xs font-medium"
                          >
                            Manage
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {activeTab === 'pending' &&
            (filteredPending.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No pending approvals match your search</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Email
                      </th>
                      <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Name
                      </th>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Requested
                      </th>
                      <th className="px-4 md:px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredPending.map((user) => (
                      <tr key={user.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.email}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">
                          {user.full_name || 'N/A'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-600">
                          {new Date(user.requested_at).toLocaleDateString()}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-right">
                          <div className="flex flex-wrap justify-end gap-2">
                            <button
                              type="button"
                              onClick={() => setDrawer({ open: true, tab: 'pending', user })}
                              className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-50 text-gray-800 rounded-lg hover:bg-gray-100 transition-colors text-xs font-medium"
                            >
                              Details
                            </button>
                            <button
                              type="button"
                              onClick={() => handleApproveUser(user.id)}
                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-600 rounded-lg hover:bg-green-100 transition-colors text-sm font-medium"
                            >
                              <Check size={14} />
                              Approve
                            </button>
                            <button
                              type="button"
                              onClick={() => handleRejectUser(user.id)}
                              className="inline-flex items-center gap-2 px-3 py-1.5 bg-red-50 text-red-600 rounded-lg hover:bg-red-100 transition-colors text-sm font-medium"
                            >
                              <X size={14} />
                              Reject
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}

          {activeTab === 'rejected' &&
            (filteredRejected.length === 0 ? (
              <div className="p-8 text-center text-gray-500">No rejected registrations match your search</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 border-b border-gray-200">
                    <tr>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Email
                      </th>
                      <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Name
                      </th>
                      <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Reason
                      </th>
                      <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">
                        Reviewed
                      </th>
                      <th className="px-4 md:px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRejected.map((row) => (
                      <tr
                        key={`${row.registration_id ?? row.id}-rej`}
                        className="border-b border-gray-200 hover:bg-gray-50 transition-colors"
                      >
                        <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{row.email}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">
                          {row.full_name || 'N/A'}
                        </td>
                        <td
                          className="hidden lg:table-cell px-4 md:px-6 py-4 text-xs text-gray-600 max-w-xs truncate"
                          title={row.rejection_reason ?? ''}
                        >
                          {row.rejection_reason || '—'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-xs text-gray-600">
                          {row.reviewed_at ? new Date(row.reviewed_at).toLocaleDateString() : '—'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-right">
                          <button
                            type="button"
                            onClick={() => setDrawer({ open: true, tab: 'rejected', row })}
                            className="inline-flex items-center gap-1 px-3 py-1.5 bg-gray-50 text-gray-800 rounded-lg hover:bg-gray-100 transition-colors text-xs font-medium"
                          >
                            Details
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
        </div>
      </div>

      {/* Detail drawer */}
      {drawer.open && (
        <>
          <button
            type="button"
            aria-label="Close panel"
            className="fixed inset-0 z-40 bg-black/30 md:bg-black/20"
            onClick={() => setDrawer({ open: false })}
          />
          <aside className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-gray-200 bg-white shadow-xl">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-3">
              <h2 className="text-lg font-semibold text-gray-900">User details</h2>
              <button
                type="button"
                onClick={() => setDrawer({ open: false })}
                className="rounded-lg p-2 text-gray-500 hover:bg-gray-100"
              >
                <PanelRightClose size={20} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-4 text-sm">
              {drawer.tab === 'approved' && drawerApproved && (
                <div className="space-y-5">
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Email</p>
                    <p className="mt-1 text-gray-900">{drawerApproved.email}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">User ID</p>
                    <div className="mt-1 flex items-center gap-2">
                      <code className="break-all text-xs text-gray-700">{drawerApproved.id}</code>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(drawerApproved.id)}
                        className="rounded p-1 text-gray-500 hover:bg-gray-100"
                        title="Copy"
                      >
                        <Copy size={16} />
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="text-xs font-medium uppercase text-gray-500">Display name</label>
                    <input
                      type="text"
                      value={nameDraft}
                      onChange={(e) => setNameDraft(e.target.value)}
                      className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
                    />
                    <button
                      type="button"
                      disabled={nameSaving}
                      onClick={() => void handleSaveDisplayName(drawerApproved.id)}
                      className="mt-2 rounded-lg bg-gray-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-gray-800 disabled:opacity-50"
                    >
                      {nameSaving ? 'Saving…' : 'Save name'}
                    </button>
                  </div>
                  <div>{statusCell(drawerApproved)}</div>
                  <div className="space-y-2 border-t border-gray-100 pt-4">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Password</p>
                    <button
                      type="button"
                      onClick={() => {
                        setSendEmailTarget(drawerApproved);
                        setSendEmailModalOpen(true);
                      }}
                      disabled={drawerApproved.email === 'Unknown'}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50 disabled:opacity-50"
                    >
                      <Mail size={16} />
                      Send password reset email
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setTempPassUser(drawerApproved);
                        setTempPassNew('');
                        setTempPassConfirm('');
                        setTempPassMessage('');
                        setTempPassModalOpen(true);
                      }}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-800 hover:bg-gray-50"
                    >
                      <KeyRound size={16} />
                      Set temporary password
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedUser(drawerApproved);
                        setResetModalOpen(true);
                      }}
                      className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-200 bg-amber-50 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                    >
                      <RotateCw size={16} />
                      Require new password on next sign-in
                    </button>
                  </div>
                  <div className="border-t border-gray-100 pt-4 space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">Role</p>
                    {authUser?.id !== drawerApproved.id && drawerApproved.role === 'staff' && (
                      <button
                        type="button"
                        disabled={busyRoleUserId === drawerApproved.id}
                        onClick={() => handleSetRegisteredAdminRole(drawerApproved, true)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg bg-purple-50 py-2 text-sm font-medium text-purple-700 hover:bg-purple-100 disabled:opacity-50"
                      >
                        <Shield size={16} />
                        Make admin
                      </button>
                    )}
                    {authUser?.id !== drawerApproved.id && drawerApproved.role === 'admin' && (
                      <button
                        type="button"
                        disabled={busyRoleUserId === drawerApproved.id}
                        onClick={() => handleSetRegisteredAdminRole(drawerApproved, false)}
                        className="flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                      >
                        Remove admin access
                      </button>
                    )}
                  </div>
                </div>
              )}

              {drawer.open && drawer.tab === 'pending' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Email</p>
                    <p className="mt-1 text-gray-900">{drawer.user.email}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Name</p>
                    <p className="mt-1 text-gray-900">{drawer.user.full_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Requested</p>
                    <p className="mt-1 text-gray-700">
                      {new Date(drawer.user.requested_at).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2 pt-2">
                    <button
                      type="button"
                      onClick={() => handleApproveUser(drawer.user.id)}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white hover:bg-green-700"
                    >
                      <Check size={16} />
                      Approve
                    </button>
                    <button
                      type="button"
                      onClick={() => handleRejectUser(drawer.user.id)}
                      className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
                    >
                      <X size={16} />
                      Reject
                    </button>
                  </div>
                </div>
              )}

              {drawer.open && drawer.tab === 'rejected' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Email</p>
                    <p className="mt-1 text-gray-900">{drawer.row.email}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Name</p>
                    <p className="mt-1 text-gray-900">{drawer.row.full_name || '—'}</p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Reviewed</p>
                    <p className="mt-1 text-gray-700">
                      {drawer.row.reviewed_at
                        ? new Date(drawer.row.reviewed_at).toLocaleString()
                        : '—'}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs font-medium uppercase text-gray-500">Reason</p>
                    <p className="mt-1 text-gray-700 whitespace-pre-wrap">
                      {drawer.row.rejection_reason || '—'}
                    </p>
                  </div>
                </div>
              )}
            </div>
          </aside>
        </>
      )}

      <Modal
        title="Require password change"
        isOpen={resetModalOpen}
        onClose={() => !resetLoading && setResetModalOpen(false)}
      >
        <div className="w-full max-w-sm">
          <p className="text-gray-600 mb-6">
            {selectedUser &&
              `Require ${selectedUser.email} to choose a new password before using the app? They can still sign in with their current password once, then must update it.`}
          </p>

          {resetMessage && (
            <div
              className={`mb-6 p-4 rounded-lg ${
                resetMessage.includes('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-700'
              }`}
            >
              {resetMessage}
            </div>
          )}

          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => setResetModalOpen(false)}
              disabled={resetLoading}
              className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleForcePasswordReset()}
              disabled={resetLoading}
              className="flex-1 px-4 py-2.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium disabled:opacity-50"
            >
              {resetLoading ? 'Processing…' : 'Confirm'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        title="Send password reset email"
        isOpen={sendEmailModalOpen}
        onClose={() => !sendEmailLoading && setSendEmailModalOpen(false)}
      >
        <div className="w-full max-w-md space-y-4">
          <p className="text-sm text-gray-600">
            Supabase will email <strong>{sendEmailTarget?.email}</strong> a link to set a new password. Ensure{' '}
            <code className="rounded bg-gray-100 px-1 text-xs">{getPasswordRecoveryRedirectUrl()}</code> is allowed in
            Dashboard → Authentication → URL configuration.
          </p>
          {sendEmailMessage && (
            <div
              className={`rounded-lg p-3 text-sm ${
                sendEmailMessage.startsWith('Error')
                  ? 'bg-red-50 text-red-700'
                  : 'bg-green-50 text-green-800'
              }`}
            >
              {sendEmailMessage}
            </div>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setSendEmailModalOpen(false);
                setSendEmailTarget(null);
                setSendEmailMessage('');
              }}
              disabled={sendEmailLoading}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmSendResetEmail()}
              disabled={sendEmailLoading}
              className="flex-1 rounded-lg bg-blue-600 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {sendEmailLoading ? 'Sending…' : 'Send email'}
            </button>
          </div>
        </div>
      </Modal>

      <Modal
        title="Set temporary password"
        isOpen={tempPassModalOpen}
        onClose={() => !tempPassLoading && setTempPassModalOpen(false)}
      >
        <div className="w-full max-w-md space-y-4">
          <p className="text-sm text-gray-600">
            Sets Auth password for <strong>{tempPassUser?.email}</strong> via secure Edge Function. User will be required
            to pick a new password on next sign-in. Minimum {MIN_PASSWORD_LENGTH} characters.
          </p>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">New password</label>
            <input
              type="password"
              autoComplete="new-password"
              value={tempPassNew}
              onChange={(e) => setTempPassNew(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Confirm</label>
            <input
              type="password"
              autoComplete="new-password"
              value={tempPassConfirm}
              onChange={(e) => setTempPassConfirm(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
            />
          </div>
          {tempPassMessage && (
            <div
              className={`rounded-lg p-3 text-sm ${
                tempPassMessage.startsWith('Error') ? 'bg-red-50 text-red-700' : 'bg-green-50 text-green-800'
              }`}
            >
              {tempPassMessage}
            </div>
          )}
          <div className="flex gap-3">
            <button
              type="button"
              onClick={() => {
                setTempPassModalOpen(false);
                setTempPassUser(null);
                setTempPassMessage('');
              }}
              disabled={tempPassLoading}
              className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleConfirmTempPassword()}
              disabled={tempPassLoading}
              className="flex-1 rounded-lg bg-gray-900 py-2.5 text-sm font-semibold text-white hover:bg-gray-800 disabled:opacity-50"
            >
              {tempPassLoading ? 'Saving…' : 'Set password'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
