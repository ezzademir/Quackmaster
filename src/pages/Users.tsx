import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { Modal } from '../components/Modal';
import { AlertCircle, Check, X, Clock, RotateCw, CheckCircle } from 'lucide-react';
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
}

export function Users() {
  const { isAdmin } = useAuth();
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [pendingUsers, setPendingUsers] = useState<PendingUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUser, setSelectedUser] = useState<UserRecord | null>(null);
  const [resetModalOpen, setResetModalOpen] = useState(false);
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState('');
  const [activeTab, setActiveTab] = useState<'approved' | 'pending'>('approved');

  useEffect(() => {
    if (!isAdmin) return;
    loadUsers();
  }, [isAdmin]);

  async function loadUsers() {
    setLoading(true);
    try {
      // Load approved users
      const { data: profilesData, error: profilesError } = await supabase
        .from('profiles')
        .select('id, full_name, role, last_login, password_reset_required, created_at')
        .neq('role', 'pending')
        .order('created_at', { ascending: false });

      if (profilesError) throw profilesError;

      // Get emails from pending_registrations for approved users
      const { data: approvedRegistrations } = await supabase
        .from('pending_registrations')
        .select('user_id, email')
        .eq('status', 'approved');

      let emailMap: { [key: string]: string } = {};
      if (approvedRegistrations) {
        approvedRegistrations.forEach((reg) => {
          emailMap[reg.user_id] = reg.email;
        });
      }

      // Get emails from edge function for any remaining users
      let edgeFunctionEmails: { [key: string]: string } = {};
      try {
        const apiUrl = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/get_user_emails`;
        const token = (await supabase.auth.getSession()).data.session?.access_token;

        const response = await fetch(apiUrl, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        });

        if (response.ok) {
          const emailData = await response.json();
          edgeFunctionEmails = emailData.emails || {};
        }
      } catch (err) {
        console.warn('Could not fetch user emails from edge function:', err);
      }

      const usersWithEmail = (profilesData || []).map((p) => ({
        ...p,
        email: emailMap[p.id] || edgeFunctionEmails[p.id] || 'Unknown',
      })) as UserRecord[];

      setUsers(usersWithEmail);

      // Load pending registrations
      const { data: pendingData, error: pendingError } = await supabase
        .from('pending_registrations')
        .select('user_id, email, full_name, status, requested_at, created_at')
        .eq('status', 'pending')
        .order('requested_at', { ascending: false });

      if (pendingError) throw pendingError;

      const pendingWithStatus = (pendingData || []).map((p) => ({
        id: p.user_id,
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
    } catch (error) {
      console.error('Error loading users:', error);
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

          {/* Tabs */}
          <div className="mb-6 flex gap-4 border-b border-gray-200">
            <button
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
              onClick={() => setActiveTab('pending')}
              className={`px-4 py-3 font-medium transition-colors ${
                activeTab === 'pending'
                  ? 'border-b-2 border-blue-600 text-blue-600'
                  : 'text-gray-600 hover:text-gray-900'
              }`}
            >
              Pending Approvals ({pendingUsers.length})
            </button>
          </div>

          {/* Table Container */}
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
            {activeTab === 'approved' ? (
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
                            <button
                              onClick={() => {
                                setSelectedUser(user);
                                setResetModalOpen(true);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1.5 bg-amber-50 text-amber-600 rounded-lg hover:bg-amber-100 transition-colors text-xs font-medium"
                            >
                              <RotateCw size={12} />
                              <span className="hidden sm:inline">Reset</span>
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            ) : pendingUsers.length === 0 ? (
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
                            onClick={() => handleApproveUser(user.id)}
                            className="inline-flex items-center gap-2 px-3 py-1.5 bg-green-50 text-green-600 rounded-lg hover:bg-green-100 transition-colors text-sm font-medium"
                          >
                            <Check size={14} />
                            Approve
                          </button>
                          <button
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
