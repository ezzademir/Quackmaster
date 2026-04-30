import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { LogOut, Clock, AlertCircle } from 'lucide-react';
import { type ApprovalStatus } from '../utils/approval';
import { writeLedgerEntry } from '../utils/ledger';

export function PendingApproval() {
  const { profile, signOut } = useAuth();
  const navigate = useNavigate();
  const [approval, setApproval] = useState<{
    id: string;
    status: ApprovalStatus;
    requested_at?: string;
    reviewed_at?: string;
    reviewed_by?: string;
    rejection_reason?: string;
  } | null>(null);
  

  useEffect(() => {
    if (!profile) return;

    if (profile.role !== 'pending') {
      navigate('/');
      return;
    }

    fetchApprovalStatus();

    const interval = setInterval(fetchApprovalStatus, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile, navigate]);

  async function fetchApprovalStatus() {
    if (!profile?.id) return;

    const { data } = await supabase
      .from('pending_registrations')
      .select('*')
      .eq('user_id', profile.id)
      .maybeSingle();

    if (data?.status === 'approved') {
      // Log approval to ledger
      await writeLedgerEntry({
        action: 'approved',
        entityType: 'pending_registration',
        entityId: profile.id,
        module: 'admin',
        operation: 'event',
        metadata: {
          user_email: profile.id,
          approved_at: new Date().toISOString(),
        },
      });

      // Refresh session to get updated profile
      await supabase.auth.refreshSession();
      navigate('/');
    } else {
      setApproval(data);
    }
  }

  const handleSignOut = async () => {
    await signOut();
    navigate('/login');
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-gradient-to-br from-blue-50 to-indigo-100 px-4">
      <div className="w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-8 shadow-lg text-center">
        <img src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`} alt="Quackmaster" className="mx-auto mb-6 h-16 w-16" />

        <h1 className="text-2xl font-bold text-gray-900 mb-2">Awaiting Approval</h1>
        <p className="text-sm text-gray-600 mb-6">
          Your account is pending admin review. You'll have full access once approved.
        </p>

        <div className="rounded-lg bg-gray-50 p-4 mb-6 text-left space-y-2">
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Name</span>
            <span className="font-medium text-gray-900">{profile?.full_name}</span>
          </div>
          <div className="flex justify-between text-sm">
            <span className="text-gray-600">Status</span>
            <div className="flex items-center gap-2">
              {approval?.status === 'pending' && (
                <>
                  <Clock size={16} className="text-amber-600 animate-spin" />
                  <span className="inline-block rounded-full bg-amber-100 px-3 py-1 text-xs font-medium text-amber-800">
                    Pending Review
                  </span>
                </>
              )}
              {approval?.status === 'rejected' && (
                <>
                  <AlertCircle size={16} className="text-red-600" />
                  <span className="inline-block rounded-full bg-red-100 px-3 py-1 text-xs font-medium text-red-800">
                    Rejected
                  </span>
                </>
              )}
            </div>
          </div>
          {approval?.requested_at && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Requested</span>
              <span className="text-gray-900">{new Date(approval.requested_at).toLocaleDateString()}</span>
            </div>
          )}
          {approval?.reviewed_at && (
            <div className="flex justify-between text-sm">
              <span className="text-gray-600">Reviewed</span>
              <span className="text-gray-900">{new Date(approval.reviewed_at).toLocaleDateString()}</span>
            </div>
          )}
          {approval?.rejection_reason && (
            <div className="rounded bg-red-50 p-2 text-sm">
              <p className="text-gray-600">Reason:</p>
              <p className="text-red-700 font-medium">{approval.rejection_reason}</p>
            </div>
          )}
        </div>

        <div className="mb-6 rounded-lg bg-blue-50 px-4 py-3 text-left">
          <p className="text-xs text-blue-800">
            <span className="font-medium">Tip:</span> Contact an administrator to expedite your approval.
          </p>
        </div>

        <button
          onClick={handleSignOut}
          className="w-full flex items-center justify-center gap-2 rounded-lg bg-gray-100 px-4 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-200 transition-colors"
        >
          <LogOut size={16} />
          Sign Out
        </button>
      </div>
    </div>
  );
}
