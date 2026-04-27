import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';

interface LedgerEntry {
  id: string;
  user_email: string;
  action: string;
  entity_type: string;
  entity_id: string;
  module: string;
  operation: 'insert' | 'update' | 'delete' | 'event';
  reference_id: string | null;
  before_data: Record<string, unknown> | null;
  after_data: Record<string, unknown> | null;
  delta_data: Record<string, unknown> | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

const OP_COLORS: Record<string, string> = {
  insert: 'bg-emerald-100 text-emerald-700',
  update: 'bg-blue-100 text-blue-700',
  delete: 'bg-red-100 text-red-700',
  event: 'bg-amber-100 text-amber-700',
};

function prettyTime(iso: string) {
  const d = new Date(iso);
  return d.toLocaleString('en-MY', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function Ledger() {
  const { isAdmin, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [search, setSearch] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterModule, setFilterModule] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const loadRows = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('data_ledger')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filterOperation) query = query.eq('operation', filterOperation);
    if (filterModule) query = query.eq('module', filterModule);
    if (filterEntity) query = query.eq('entity_type', filterEntity);
    if (search) {
      query = query.or(
        `user_email.ilike.%${search}%,entity_id.ilike.%${search}%,reference_id.ilike.%${search}%`
      );
    }

    const { data } = await query;
    setRows((data as LedgerEntry[]) ?? []);
    setLoading(false);
  }, [filterEntity, filterModule, filterOperation, page, search]);

  useEffect(() => {
    if (!authLoading && isAdmin) loadRows();
    if (!authLoading && !isAdmin) setLoading(false);
  }, [authLoading, isAdmin, loadRows]);

  useEffect(() => {
    if (!isAdmin) return;
    const t = setTimeout(() => loadRows(), 300);
    return () => clearTimeout(t);
  }, [search, isAdmin, loadRows]);

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
          <p className="mt-1 text-sm text-gray-500">Only administrators can view the data ledger.</p>
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
          <h1 className="text-2xl font-bold text-gray-900">Data Ledger</h1>
          <p className="mt-1 text-sm text-gray-500">
            Single source of truth for data mutations and business events
          </p>
        </div>
        <button
          onClick={loadRows}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(0);
            }}
            placeholder="Search user, entity, reference…"
            className="w-72 rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterOperation}
          onChange={(e) => {
            setFilterOperation(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All operations</option>
          {['insert', 'update', 'delete', 'event'].map((op) => (
            <option key={op} value={op}>
              {op}
            </option>
          ))}
        </select>
        <select
          value={filterModule}
          onChange={(e) => {
            setFilterModule(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All modules</option>
          {['auth', 'users', 'settings', 'inventory', 'procurement', 'production', 'distribution', 'activity'].map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <input
          value={filterEntity}
          onChange={(e) => {
            setFilterEntity(e.target.value);
            setPage(0);
          }}
          placeholder="Entity type (e.g. hub_inventory)"
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Time</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Operation</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Module</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Entity</th>
              <th className="hidden md:table-cell px-4 py-3 text-left font-semibold text-gray-700">Reference</th>
              <th className="hidden lg:table-cell px-4 py-3 text-left font-semibold text-gray-700">Delta</th>
              <th className="hidden xl:table-cell px-4 py-3 text-left font-semibold text-gray-700">User</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-gray-400">
                  No ledger rows found
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.id} className="hover:bg-gray-50 transition-colors">
                  <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{prettyTime(row.created_at)}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${OP_COLORS[row.operation] ?? 'bg-gray-100 text-gray-700'}`}>
                      {row.operation}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-xs font-medium text-gray-700">{row.module}</td>
                  <td className="px-4 py-3">
                    <div className="text-xs font-semibold text-gray-900">{row.entity_type}</div>
                    <div className="text-xs text-gray-400">{row.entity_id}</div>
                  </td>
                  <td className="hidden md:table-cell px-4 py-3 text-xs text-gray-500">{row.reference_id || '—'}</td>
                  <td className="hidden lg:table-cell px-4 py-3 max-w-xs">
                    <span className="block truncate font-mono text-xs text-gray-500">
                      {row.delta_data ? JSON.stringify(row.delta_data) : '—'}
                    </span>
                  </td>
                  <td className="hidden xl:table-cell px-4 py-3 text-xs text-gray-500">{row.user_email || '—'}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      <div className="flex items-center justify-between text-sm text-gray-500">
        <p>Showing {rows.length} entries</p>
        <div className="flex gap-2">
          <button
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            Previous
          </button>
          <span className="rounded-lg border border-gray-300 bg-gray-50 px-3 py-1.5 text-sm font-medium">
            Page {page + 1}
          </span>
          <button
            onClick={() => setPage(page + 1)}
            disabled={rows.length < PAGE_SIZE}
            className="rounded-lg border border-gray-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-gray-50 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
