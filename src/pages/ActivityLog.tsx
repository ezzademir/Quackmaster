import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Shield } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import { Link } from 'react-router-dom';
import {
  actorDisplayName,
  actorSubtitle,
  fetchActorProfilesMap,
  prettyJson,
  summarizeActivityDetails,
  type ActorProfile,
} from '../utils/auditDisplay';

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
  inventory_adjustment: 'Inventory adjustment',
};

function friendlyEntityType(type: string): string {
  return ENTITY_LABELS[type] ?? type.replace(/_/g, ' ');
}

function timeAgo(iso: string) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(iso).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' });
}

function RawDetails({ details }: { details: Record<string, unknown> }) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-blue-600 hover:text-blue-800">
        Raw JSON
      </summary>
      <pre className="mt-2 max-h-52 overflow-auto rounded border border-gray-100 bg-gray-50 p-2 font-mono text-[11px] leading-snug text-gray-700">
        {prettyJson(details)}
      </pre>
    </details>
  );
}

export function ActivityLog() {
  const { isAdmin, loading: authLoading } = useAuth();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, ActorProfile>>(new Map());
  const [loading, setLoading] = useState(true);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterAction, setFilterAction] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('activity_logs')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filterAction) query = query.eq('action', filterAction);
    if (filterEntity) query = query.eq('entity_type', filterEntity);
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim();
      query = query.or(
        `user_email.ilike.%${q}%,entity_label.ilike.%${q}%,entity_id.ilike.%${q}%,action.ilike.%${q}%,entity_type.ilike.%${q}%`
      );
    }

    const { data } = await query;
    const list = (data as LogEntry[]) ?? [];
    const pmap = await fetchActorProfilesMap(
      supabase,
      list.map((l) => l.user_id)
    );
    setProfileMap(pmap);
    setLogs(list);
    setLoading(false);
  }, [page, filterAction, filterEntity, debouncedSearch]);

  useEffect(() => {
    if (!authLoading && isAdmin) void loadLogs();
    if (!authLoading && !isAdmin) setLoading(false);
  }, [authLoading, isAdmin, loadLogs]);

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
            Who did what, on which record, with stated reasons and values — admins only
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadLogs()}
          className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
        >
          <RefreshCw size={16} /> Refresh
        </button>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(0);
            }}
            placeholder="Search user, record, action…"
            className="w-72 rounded-lg border border-gray-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterAction}
          onChange={(e) => {
            setFilterAction(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All actions</option>
          {['created', 'updated', 'deleted', 'received', 'dispatched', 'completed', 'cancelled'].map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select
          value={filterEntity}
          onChange={(e) => {
            setFilterEntity(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
        >
          <option value="">All entity types</option>
          {Object.entries(ENTITY_LABELS).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full text-sm">
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Time</th>
              <th className="min-w-[9rem] px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Who</th>
              <th className="px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Action</th>
              <th className="hidden sm:table-cell px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Record</th>
              <th className="min-w-[14rem] px-4 md:px-5 py-3 text-left font-semibold text-gray-700">Context & values</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {logs.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 md:px-5 py-12 text-center text-gray-400 text-xs sm:text-sm">
                  No activity logs found
                </td>
              </tr>
            ) : (
              logs.map((log) => {
                const prof = log.user_id ? profileMap.get(log.user_id) : undefined;
                const displayName = actorDisplayName(prof, log.user_email);
                const subtitle = actorSubtitle(prof, log.user_email);
                const { headline, bullets } = summarizeActivityDetails(
                  log.action,
                  log.entity_type,
                  log.entity_label,
                  log.entity_id,
                  log.details
                );

                return (
                  <tr key={log.id} className="align-top hover:bg-gray-50 transition-colors">
                    <td className="whitespace-nowrap px-4 md:px-5 py-3 text-gray-400 text-xs">
                      <span title={new Date(log.created_at).toLocaleString()}>{timeAgo(log.created_at)}</span>
                    </td>
                    <td className="px-4 md:px-5 py-3">
                      <div className="font-medium text-gray-900 text-xs sm:text-sm">{displayName}</div>
                      {subtitle ? (
                        <div className="text-xs text-gray-500">{subtitle}</div>
                      ) : null}
                      {!log.user_id && !log.user_email?.trim() ? (
                        <div className="mt-0.5 text-xs text-amber-700">No signed-in user on this row</div>
                      ) : null}
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
                    <td className="hidden sm:table-cell px-4 md:px-5 py-3 text-xs text-gray-700">
                      <div className="font-medium text-gray-900">{friendlyEntityType(log.entity_type)}</div>
                      <div className="font-mono text-[11px] text-gray-400">{log.entity_id || '—'}</div>
                    </td>
                    <td className="max-w-xl px-4 md:px-5 py-3">
                      <div className="font-medium text-gray-900">{headline}</div>
                      <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-gray-600">
                        {bullets.map((b, i) => (
                          <li key={i}>{b}</li>
                        ))}
                      </ul>
                      {log.details && Object.keys(log.details).length > 0 ? (
                        <RawDetails details={log.details} />
                      ) : null}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <p>Showing {logs.length} entries per page</p>
        <div className="flex gap-2">
          <button
            type="button"
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
            type="button"
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
