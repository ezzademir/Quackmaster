import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Shield } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { Link } from 'react-router-dom';

interface LogEntry {
  id: string;
  user_id: string | null;
  user_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  entity_label: string;
  details: Record<string, unknown> | null;
  created_at: string;
}

const ACTION_COLORS: Record<string, string> = {
  created: 'bg-emerald-100 text-emerald-700',
  updated: 'bg-blue-100 text-blue-700',
  deleted: 'bg-red-100 text-red-700',
  received: 'bg-teal-100 text-teal-700',
  dispatched: 'bg-amber-100 text-amber-700',
  completed: 'bg-emerald-100 text-emerald-700',
  cancelled: 'bg-red-100 text-red-700',
};

const ENTITY_LABELS: Record<string, string> = {
  supplier: 'Supplier',
  raw_material: 'Raw Material',
  recipe: 'Recipe',
  purchase_order: 'Purchase Order',
  production_run: 'Production Run',
  outlet: 'Outlet',
  supply_order: 'Supply Order',
  inventory_adjustment: 'Inventory',
};

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
}

export function ActivityLog() {
  const { isAdmin, loading: authLoading } = useAuth();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const loadLogs = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filterAction) query = query.eq('action', filterAction);
    if (filterEntity) query = query.eq('entity_type', filterEntity);
    if (search) query = query.or(`user_email.ilike.%${search}%,entity_label.ilike.%${search}%`);

    const { data } = await query;
    setLogs(data as LogEntry[] ?? []);
    setLoading(false);
  }, [page, filterAction, filterEntity, search]);

  useEffect(() => {
    if (!authLoading && isAdmin) loadLogs();
    if (!authLoading && !isAdmin) setLoading(false);
  }, [authLoading, isAdmin, loadLogs]);

  // Re-run on search change with debounce
  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(() => loadLogs(), 300);
    return () => clearTimeout(t);
  }, [search, isAdmin, loadLogs]);

  if (authLoading || loading) {
    return <div className="flex h-96 items-center justify-center text-gray-400 text-sm">Loading…</div>;
  }

  if (!isAdmin) {
    return (
      <div className="flex h-96 flex-col items-center justify-center gap-4 text-center">
        <div className="rounded-full bg-red-100 p-4 text-red-500">
          <Shield size={32} />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Access Restricted</h2>
          <p className="mt-1 text-sm text-gray-500">Only administrators can view the activity log.</p>
        </div>
        <Link to="/" className="text-sm font-medium text-blue-600 hover:text-blue-800">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Activity Log</h1>
          <p className="mt-1 text-sm text-gray-500">
            Complete audit trail of all user actions — visible to admins only
          </p>
        </div>
        <button
          onClick={loadLogs}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by user or entity…"
            className="w-64 rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterAction}
          onChange={(e) => { setFilterAction(e.target.value); setPage(0); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All actions</option>
          {['created', 'updated', 'deleted', 'received', 'dispatched', 'completed', 'cancelled'].map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filterEntity}
          onChange={(e) => { setFilterEntity(e.target.value); setPage(0); }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All modules</option>
          {Object.entries(ENTITY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>{label}</option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Time</th>
              <th className="hidden sm:table-cell px-4 md:px-5 py-3 text-left font-semibold text-gray-700">User</th>
              <th className="px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Action</th>
              <th className="hidden md:table-cell px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Module</th>
              <th className="px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Entity</th>
              <th className="hidden lg:table-cell px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 md:px-5 py-12 text-center text-gray-400 text-xs sm:text-sm">
                  No activity logs found
                </td>
              </tr>
            ) : (
              logs.map((log) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                  <td className="whitespace-nowrap px-4 md:px-5 py-3 text-gray-400 text-xs">
                    <span title={new Date(log.created_at).toLocaleString()}>
                      {timeAgo(log.created_at)}
                    </span>
                  </td>
                  <td className="hidden sm:table-cell px-4 md:px-5 py-3">
                    <span className="font-medium text-gray-900 text-xs sm:text-sm">{log.user_email || '—'}</span>
                  </td>
                  <td className="px-4 md:px-5 py-3">
                    <span
                      className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${
                        ACTION_COLORS[log.action] ?? 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {log.action}
                    </span>
                  </td>
                  <td className="hidden md:table-cell px-4 md:px-5 py-3 text-gray-600 text-xs">
                    {ENTITY_LABELS[log.entity_type] ?? log.entity_type}
                  </td>
                  <td className="px-4 md:px-5 py-3 font-medium text-gray-900 text-xs sm:text-sm">
                    {log.entity_label || log.entity_id}
                  </td>
                  <td className="hidden lg:table-cell px-4 md:px-5 py-3 text-gray-500 max-w-xs">
                    {log.details ? (
                      <span className="truncate block text-xs font-mono">
                        {JSON.stringify(log.details)}
                      </span>
                    ) : (
                      <span className="text-gray-300">—</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-gray-500">
        <p>Showing {logs.length} entries</p>
        <div className="flex gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            Previous
          </button>
          <span className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium bg-gray-50">
            Page {page + 1}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={logs.length < PAGE_SIZE}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
