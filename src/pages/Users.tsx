import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { Modal } from '../components/Modal';
import { AlertCircle, Check, X, Clock, RotateCw, CheckCircle, Shield } from 'lucide-react';
import { writeLedgerEntry } from '../utils/ledger';

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
        email:
          (p.email && p.email.trim() !== '' ? p.email : null) || 'Unknown',
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
      // Call the edge function to set password reset flag
      const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/force_password_reset`;
      const token = (await supabase.auth.getSession()).data.session?.access_token;

      const response = await fetch(apiUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ userId: selectedUser.id }),
      });

      if (!response.ok) {
        throw new Error('Failed to force password reset');
      }

      await writeLedgerEntry({
        action: 'updated',
        entityType: 'profile',
        entityId: selectedUser.id,
        module: 'users',
        operation: 'event',
        metadata: { password_reset_required: true, source: 'force_password_reset' },
      });

      setResetMessage('Password reset required flag set. User will be prompted to reset on next login.');
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

      // Update the profile role first. If this fails, do not mark the registration approved.
      const { error: updateError } = await supabase
        .from('profiles')
        .update({ role: 'staff' })
        .eq('id', userId);

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
        // Best-effort rollback to avoid approved status while role remains non-staff.
        await supabase
          .from('profiles')
          .update({ role: 'pending' })
          .eq('id', userId);
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
    } catch (error) {
      console.error('Error rejecting user:', error);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-screen">
        <div className="text-gray-500">Loading users...</div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-6xl mx-auto">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">User Management</h1>
            <p className="mt-2 text-gray-600">Manage registered and pending users</p>
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

          {/* Tabs */}
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
              Registered Users ({users.length})
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
              Pending Approvals ({pendingUsers.length})
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
              Rejected ({rejectedUsers.length})
            </button>
          </div>

          {/* Table Container */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {activeTab === 'approved' && (
              users.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No registered users yet</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Email</th>
                        <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Name</th>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Role</th>
                        <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Status</th>
                        <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Login</th>
                        <th className="px-4 md:px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {users.map((user) => (
                        <tr key={user.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                          <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.email}</td>
                          <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.full_name || 'N/A'}</td>
                          <td className="px-4 md:px-6 py-4 text-xs sm:text-sm">
                            <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                              user.role === 'admin'
                                ? 'bg-purple-100 text-purple-700'
                                : 'bg-blue-100 text-blue-700'
                            }`}>
                              {user.role}
                            </span>
                          </td>
                          <td className="hidden md:table-cell px-4 md:px-6 py-4 text-xs">
                            {user.password_reset_required ? (
                              <div className="flex items-center gap-1">
                                <AlertCircle size={14} className="text-amber-600" />
                                <span className="text-amber-600 font-medium">Reset</span>
                              </div>
                            ) : user.last_login ? (
                              <div className="flex items-center gap-1">
                                <CheckCircle size={14} className="text-green-600" />
                                <span className="text-green-600 font-medium">Active</span>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1">
                                <Clock size={14} className="text-gray-400" />
                                <span className="text-gray-600">Never</span>
                              </div>
                            )}
                          </td>
                          <td className="hidden lg:table-cell px-4 md:px-6 py-4 text-xs text-gray-600">
                            {user.last_login ? new Date(user.last_login).toLocaleDateString() : 'N/A'}
                          </td>
                          <td className="px-4 md:px-6 py-4 text-right">
                            <div className="flex flex-wrap items-center justify-end gap-2">
                              {authUser?.id !== user.id && user.role === 'staff' && (
                                <button
                                  type="button"
                                  disabled={busyRoleUserId === user.id}
                                  onClick={() => handleSetRegisteredAdminRole(user, true)}
                                  className="inline-flex items-center gap-1 px-2 py-1.5 bg-purple-50 text-purple-700 rounded-lg hover:bg-purple-100 transition-colors text-xs font-medium disabled:opacity-50"
                                  title="Grant administrator access"
                                >
                                  <Shield size={12} />
                                  <span className="hidden sm:inline">Make admin</span>
                                </button>
                              )}
                              {authUser?.id !== user.id && user.role === 'admin' && (
                                <button
                                  type="button"
                                  disabled={busyRoleUserId === user.id}
                                  onClick={() => handleSetRegisteredAdminRole(user, false)}
                                  className="inline-flex items-center gap-1 px-2 py-1.5 border border-gray-200 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-xs font-medium disabled:opacity-50"
                                  title="Remove administrator access"
                                >
                                  <span className="hidden sm:inline">Remove admin</span>
                                  <span className="sm:hidden">Demote</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => {
                                  setSelectedUser(user);
                                  setResetModalOpen(true);
                                }}
                                className="inline-flex items-center gap-1 px-2 py-1.5 bg-amber-50 text-amber-600 rounded-lg hover:bg-amber-100 transition-colors text-xs font-medium"
                              >
                                <RotateCw size={12} />
                                <span className="hidden sm:inline">Reset</span>
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {activeTab === 'pending' && (
              pendingUsers.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No pending approvals</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Email</th>
                        <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Name</th>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Requested</th>
                        <th className="px-4 md:px-6 py-3 text-right text-xs font-semibold text-gray-700 uppercase">Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingUsers.map((user) => (
                        <tr key={user.id} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                          <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.email}</td>
                          <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{user.full_name || 'N/A'}</td>
                          <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-600">
                            {new Date(user.requested_at).toLocaleDateString()}
                          </td>
                          <td className="px-4 md:px-6 py-4 text-right flex justify-end gap-2">
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
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}

            {activeTab === 'rejected' && (
              rejectedUsers.length === 0 ? (
                <div className="p-8 text-center text-gray-500">No rejected registrations</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 border-b border-gray-200">
                      <tr>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Email</th>
                        <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Name</th>
                        <th className="hidden lg:table-cell px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Reason</th>
                        <th className="px-4 md:px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase">Reviewed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rejectedUsers.map((row) => (
                        <tr key={`${row.registration_id ?? row.id}-rej`} className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
                          <td className="px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{row.email}</td>
                          <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-xs sm:text-sm text-gray-900">{row.full_name || 'N/A'}</td>
                          <td className="hidden lg:table-cell px-4 md:px-6 py-4 text-xs text-gray-600 max-w-xs truncate" title={row.rejection_reason ?? ''}>
                            {row.rejection_reason || '—'}
                          </td>
                          <td className="px-4 md:px-6 py-4 text-xs text-gray-600">
                            {row.reviewed_at
                              ? new Date(row.reviewed_at).toLocaleDateString()
                              : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
      </div>

      {/* Password Reset Modal */}
      <Modal title="Force Password Reset" isOpen={resetModalOpen} onClose={() => !resetLoading && setResetModalOpen(false)}>
      <div className="w-full max-w-sm">
        <h2 className="text-2xl font-bold text-gray-900 mb-4">Force Password Reset</h2>
        <p className="text-gray-600 mb-6">
          {selectedUser && `Are you sure you want to require ${selectedUser.email} to reset their password on next login?`}
        </p>

        {resetMessage && (
          <div className={`mb-6 p-4 rounded-lg ${
            resetMessage.includes('Error')
              ? 'bg-red-50 text-red-700'
              : 'bg-green-50 text-green-700'
          }`}>
            {resetMessage}
          </div>
        )}

        <div className="flex gap-3">
          <button
            onClick={() => setResetModalOpen(false)}
            disabled={resetLoading}
            className="flex-1 px-4 py-2.5 border border-gray-300 text-gray-700 rounded-lg hover:bg-gray-50 transition-colors font-medium disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            onClick={handleForcePasswordReset}
            disabled={resetLoading}
            className="flex-1 px-4 py-2.5 bg-amber-600 text-white rounded-lg hover:bg-amber-700 transition-colors font-medium disabled:opacity-50"
          >
            {resetLoading ? 'Processing...' : 'Reset Password'}
          </button>
        </div>
      </div>
      </Modal>
    </div>
  );
}
