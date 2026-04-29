import { BarChart3, Users, ShoppingBag, Star, Shield, RefreshCw, Check, X } from 'lucide-react';
import { useAuth } from '../utils/auth';
import { useState, useEffect } from 'react';
import { supabase } from '../utils/supabase';
import type { PendingRegistration } from '../types';
import { Modal } from '../components/Modal';
import { writeLedgerEntry } from '../utils/ledger';
import { fetchQCAuditCriteria, saveQCAuditCriteria } from '../utils/qcSettings';

export function Settings() {
  const { refetchProfile, isAdmin } = useAuth();
  const [refreshing, setRefreshing] = useState(false);
  const [pendingUsers, setPendingUsers] = useState<PendingRegistration[]>([]);
  const [loadingApprovals, setLoadingApprovals] = useState(false);
  const [rejectionModal, setRejectionModal] = useState<{ user: PendingRegistration | null; open: boolean }>({ user: null, open: false });
  const [rejectionReason, setRejectionReason] = useState('');
  const [qcMin, setQcMin] = useState('85');
  const [qcMax, setQcMax] = useState('110');
  const [qcVariance, setQcVariance] = useState('5');
  const [qcLoading, setQcLoading] = useState(false);
  const [qcSaving, setQcSaving] = useState(false);
  const [qcNotice, setQcNotice] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);

  const handleRefresh = async () => {
    setRefreshing(true);
    await refetchProfile();
    setRefreshing(false);
  };

  useEffect(() => {
    if (isAdmin) {
      fetchPendingUsers();
    }
  }, [isAdmin]);

  useEffect(() => {
    if (!isAdmin) return;
    let cancelled = false;
    setQcLoading(true);
    setQcNotice(null);
    fetchQCAuditCriteria()
      .then((c) => {
        if (cancelled) return;
        setQcMin(String(c.minYieldPercentage));
        setQcMax(String(c.maxYieldPercentage));
        setQcVariance(String(c.allowableVariance));
      })
      .finally(() => {
        if (!cancelled) setQcLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isAdmin]);

  async function fetchPendingUsers() {
    setLoadingApprovals(true);
    const { data } = await supabase
      .from('pending_registrations')
      .select('*')
      .eq('status', 'pending')
      .order('requested_at', { ascending: false });
    setPendingUsers((data || []) as PendingRegistration[]);
    setLoadingApprovals(false);
  }

  async function approveUser(userId: string) {
    const { error: profileErr } = await supabase
      .from('profiles')
      .update({ role: 'staff' })
      .eq('id', userId);

    if (!profileErr) {
      await supabase
        .from('pending_registrations')
        .update({ status: 'approved', reviewed_at: new Date().toISOString() })
        .eq('user_id', userId);
      await writeLedgerEntry({
        action: 'approved',
        entityType: 'pending_registration',
        entityId: userId,
        module: 'settings',
        operation: 'update',
        afterData: { status: 'approved', role: 'staff' },
      });
      fetchPendingUsers();
    }
  }

  async function saveQCSettings() {
    const min = parseFloat(qcMin);
    const max = parseFloat(qcMax);
    const variance = parseFloat(qcVariance);
    setQcNotice(null);

    if (!Number.isFinite(min) || !Number.isFinite(max) || !Number.isFinite(variance)) {
      setQcNotice({ tone: 'err', text: 'Enter valid numbers for all fields.' });
      return;
    }
    if (min < 0 || max > 200 || variance < 0 || variance > 100) {
      setQcNotice({ tone: 'err', text: 'Min/max yield must be 0–200; allowable variance 0–100.' });
      return;
    }
    if (min >= max) {
      setQcNotice({ tone: 'err', text: 'Minimum yield must be less than maximum yield.' });
      return;
    }

    setQcSaving(true);
    try {
      const { error } = await saveQCAuditCriteria({
        minYieldPercentage: min,
        maxYieldPercentage: max,
        allowableVariance: variance,
      });
      if (error) {
        setQcNotice({ tone: 'err', text: error.message });
        return;
      }
      await writeLedgerEntry({
        action: 'updated',
        entityType: 'qc_audit_settings',
        entityId: '1',
        module: 'settings',
        operation: 'update',
        afterData: {
          min_yield_percentage: min,
          max_yield_percentage: max,
          allowable_variance: variance,
        },
      });
      setQcNotice({ tone: 'ok', text: 'QC audit parameters saved. They apply to new production completions.' });
    } finally {
      setQcSaving(false);
    }
  }

  async function rejectUser(userId: string, reason: string) {
    await supabase
      .from('pending_registrations')
      .update({ status: 'rejected', rejection_reason: reason, reviewed_at: new Date().toISOString() })
      .eq('user_id', userId);
    await writeLedgerEntry({
      action: 'rejected',
      entityType: 'pending_registration',
      entityId: userId,
      module: 'settings',
      operation: 'update',
      afterData: { status: 'rejected', rejection_reason: reason || null },
    });
    setRejectionModal({ user: null, open: false });
    setRejectionReason('');
    fetchPendingUsers();
  }

  return (
    <div className="space-y-8">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Settings</h1>
          <p className="mt-1 text-sm text-gray-500">System configuration and future module management</p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 rounded-lg bg-gray-600 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors disabled:opacity-50"
        >
          <RefreshCw size={16} className={refreshing ? 'animate-spin' : ''} />
          Refresh Profile
        </button>
      </div>

      {isAdmin && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-6">
          <h2 className="mb-4 font-semibold text-gray-900 flex items-center gap-2">
            <Users size={20} className="text-amber-600" />
            Pending User Approvals
          </h2>
          {loadingApprovals ? (
            <p className="text-sm text-gray-600">Loading...</p>
          ) : pendingUsers.length === 0 ? (
            <p className="text-sm text-gray-600">No pending registrations</p>
          ) : (
            <div className="space-y-3">
              {pendingUsers.map((user) => (
                <div key={user.id} className="flex items-center justify-between rounded-lg bg-white p-4">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{user.full_name}</p>
                    <p className="text-xs text-gray-500">{user.email}</p>
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => approveUser(user.user_id)}
                      className="flex items-center gap-1 rounded-lg bg-green-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-green-700 transition-colors"
                    >
                      <Check size={14} />
                      Approve
                    </button>
                    <button
                      onClick={() => setRejectionModal({ user, open: true })}
                      className="flex items-center gap-1 rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 transition-colors"
                    >
                      <X size={14} />
                      Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {isAdmin && (
        <div className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-6 shadow-sm">
          <h2 className="mb-1 font-semibold text-gray-900 flex items-center gap-2">
            <Shield size={20} className="text-indigo-600" />
            QC audit parameters
          </h2>
          <p className="mb-5 text-sm text-gray-600">
            Thresholds used when completing production runs: yields outside min/max are rejected; deviation from the recipe target yield beyond allowable variance triggers a warning (staff may need admin approval).
          </p>

          {qcNotice && (
            <div
              className={`mb-4 rounded-lg border px-3 py-2 text-sm ${
                qcNotice.tone === 'ok'
                  ? 'border-green-200 bg-green-50 text-green-900'
                  : 'border-red-200 bg-red-50 text-red-900'
              }`}
              role="status"
            >
              {qcNotice.text}
            </div>
          )}

          {qcLoading ? (
            <p className="text-sm text-gray-500">Loading QC settings…</p>
          ) : (
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Minimum yield (%)</label>
                <input
                  type="number"
                  min={0}
                  max={200}
                  step={0.1}
                  value={qcMin}
                  onChange={(e) => setQcMin(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-500">Below this is rejected</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Maximum yield (%)</label>
                <input
                  type="number"
                  min={0}
                  max={200}
                  step={0.1}
                  value={qcMax}
                  onChange={(e) => setQcMax(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-500">Above this is rejected</p>
              </div>
              <div>
                <label className="mb-1 block text-sm font-medium text-gray-700">Allowable variance from target (%)</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={qcVariance}
                  onChange={(e) => setQcVariance(e.target.value)}
                  className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
                <p className="mt-1 text-xs text-gray-500">Beyond recipe target yield triggers warning</p>
              </div>
            </div>
          )}

          {!qcLoading && (
            <div className="mt-5 flex flex-wrap gap-3">
              <button
                type="button"
                onClick={saveQCSettings}
                disabled={qcSaving}
                className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-60 transition-colors"
              >
                {qcSaving ? 'Saving…' : 'Save QC parameters'}
              </button>
            </div>
          )}
        </div>
      )}

      <div className="grid gap-6 lg:grid-cols-3">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-6">
          {/* Company Info */}
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 font-semibold text-gray-900">Company Information</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              {[
                { label: 'Company Name', value: 'Quackmaster Sdn Bhd', disabled: true },
                { label: 'Hub Location', value: 'Quackmaster HQ', disabled: false },
                { label: 'Currency', value: 'MYR', disabled: false },
                { label: 'Timezone', value: 'Asia/Kuala_Lumpur', disabled: false },
              ].map((f) => (
                <div key={f.label}>
                  <label className="mb-1 block text-sm font-medium text-gray-700">{f.label}</label>
                  <input defaultValue={f.value} disabled={f.disabled}
                    className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
                </div>
              ))}
            </div>
            <div className="mt-5 flex justify-end">
              <button className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors">
                Save Changes
              </button>
            </div>
          </div>

          {/* System Preferences */}
          <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
            <h2 className="mb-5 font-semibold text-gray-900">System Preferences</h2>
            <div className="space-y-4">
              {[
                { label: 'Enable low stock alerts', sub: 'Get notified when materials fall below reorder level', checked: true },
                { label: 'Track yield metrics', sub: 'Record and analyse production yield per run', checked: true },
                { label: 'Require PO approval', sub: 'Purchase orders must be reviewed before ordering', checked: false },
                { label: 'Auto-update hub inventory on PO receipt', sub: 'Automatically add received quantities to stock', checked: true },
                { label: 'Auto-deduct stock on production completion', sub: 'Reduce raw material stock when a run is completed', checked: true },
              ].map((pref) => (
                <div key={pref.label} className="flex items-start justify-between gap-4 border-b border-gray-50 pb-4 last:border-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-gray-900">{pref.label}</p>
                    <p className="text-xs text-gray-500">{pref.sub}</p>
                  </div>
                  <label className="relative inline-flex flex-shrink-0 cursor-pointer items-center mt-0.5">
                    <input type="checkbox" className="sr-only peer" defaultChecked={pref.checked} />
                    <div className="h-5 w-9 rounded-full bg-gray-200 peer-checked:bg-blue-600 transition-colors peer-focus:ring-2 peer-focus:ring-blue-300" />
                    <div className="absolute left-0.5 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
                  </label>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right column: Future modules */}
        <div className="space-y-4">
          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-4 font-semibold text-gray-900">Upcoming Modules</h2>
            <div className="space-y-3">
              {[
                { icon: BarChart3, label: 'Financial Management', desc: 'P&L, cash flow, invoicing', color: 'bg-blue-50 text-blue-600' },
                { icon: Users, label: 'Human Resources', desc: 'Staff, payroll, attendance', color: 'bg-amber-50 text-amber-600' },
                { icon: ShoppingBag, label: 'Sales & CRM', desc: 'Orders, customers, pipeline', color: 'bg-emerald-50 text-emerald-600' },
                { icon: Star, label: 'Quality Control', desc: 'QC checklists, compliance', color: 'bg-teal-50 text-teal-600' },
                { icon: Shield, label: 'Audit & Compliance', desc: 'Logs, approvals, reports', color: 'bg-rose-50 text-rose-600' },
              ].map((mod) => {
                const Icon = mod.icon;
                return (
                  <div key={mod.label} className="flex items-start gap-3 rounded-lg border border-dashed border-gray-200 p-3">
                    <div className={`flex-shrink-0 rounded-lg p-2 ${mod.color}`}><Icon size={16} /></div>
                    <div>
                      <p className="text-sm font-medium text-gray-700">{mod.label}</p>
                      <p className="text-xs text-gray-400">{mod.desc}</p>
                    </div>
                    <span className="ml-auto flex-shrink-0 rounded-full bg-gray-100 px-2 py-0.5 text-[10px] font-medium text-gray-500">Soon</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
            <h2 className="mb-2 font-semibold text-gray-900">System Info</h2>
            <div className="space-y-2 text-xs text-gray-500">
              <div className="flex justify-between"><span>Version</span><span className="font-medium text-gray-700">1.0.0</span></div>
              <div className="flex justify-between"><span>Database</span><span className="font-medium text-gray-700">Supabase</span></div>
              <div className="flex justify-between"><span>Last Migration</span><span className="font-medium text-gray-700">2026-04-23</span></div>
            </div>
          </div>
        </div>
      </div>

      <Modal isOpen={rejectionModal.open} title="Reject Registration" onClose={() => setRejectionModal({ ...rejectionModal, open: false })}>
        <div className="space-y-4">
          <div>
            <p className="text-sm text-gray-600">Rejecting <span className="font-medium">{rejectionModal.user?.full_name}</span></p>
          </div>
          <div>
            <label className="mb-2 block text-sm font-medium text-gray-700">Reason for rejection</label>
            <textarea
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="Optional reason to include in notification…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
              rows={3}
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setRejectionModal({ ...rejectionModal, open: false })}
              className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={() => rejectionModal.user && rejectUser(rejectionModal.user.user_id, rejectionReason)}
              className="rounded-lg bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700 transition-colors"
            >
              Reject Registration
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
