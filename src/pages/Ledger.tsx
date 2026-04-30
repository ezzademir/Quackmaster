import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import {
  actorDisplayName,
  actorSubtitle,
  fetchActorProfilesMap,
  ledgerChangeBullets,
  ledgerPurposeLine,
  prettyJson,
  truncateId,
  type ActorProfile,
} from '../utils/auditDisplay';

interface LedgerEntry {
  id: string;
  user_id: string | null;
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

const MODULE_OPTIONS = ['procurement', 'production', 'distribution', 'inventory', 'auth', 'users', 'settings'];

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

function TechnicalPayload({ row }: { row: LedgerEntry }) {
  const payload = {
    action: row.action,
    reference_id: row.reference_id,
    before_data: row.before_data,
    after_data: row.after_data,
    delta_data: row.delta_data,
    metadata: row.metadata,
  };
  return (
    <details className="mt-2">
      <summary className="cursor-pointer select-none text-xs font-medium text-blue-600 hover:text-blue-800">
        Full payload (JSON)
      </summary>
      <pre className="mt-2 max-h-56 overflow-auto rounded border border-gray-100 bg-gray-50 p-2 font-mono text-[11px] leading-snug text-gray-700">
        {prettyJson(payload)}
      </pre>
    </details>
  );
}

export function Ledger() {
  const { isAdmin, loading: authLoading } = useAuth();
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<LedgerEntry[]>([]);
  const [profileMap, setProfileMap] = useState<Map<string, ActorProfile>>(new Map());
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [filterOperation, setFilterOperation] = useState('');
  const [filterModule, setFilterModule] = useState('');
  const [filterEntity, setFilterEntity] = useState('');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput), 300);
    return () => clearTimeout(t);
  }, [searchInput]);

  const loadRows = useCallback(async () => {
    setLoading(true);
    let query = supabase
      .from('data_ledger')
      .select('*')
      .order('created_at', { ascending: false })
      .range(page * PAGE_SIZE, (page + 1) * PAGE_SIZE - 1);

    if (filterOperation) query = query.eq('operation', filterOperation);
    if (filterModule) query = query.eq('module', filterModule);
    if (filterEntity.trim()) query = query.eq('entity_type', filterEntity.trim());
    if (debouncedSearch.trim()) {
      const q = debouncedSearch.trim();
      query = query.or(
        `user_email.ilike.%${q}%,entity_id.ilike.%${q}%,reference_id.ilike.%${q}%,action.ilike.%${q}%,entity_type.ilike.%${q}%,module.ilike.%${q}%`
      );
    }

    const { data } = await query;
    const list = (data as LedgerEntry[]) ?? [];
    const pmap = await fetchActorProfilesMap(
      supabase,
      list.map((r) => r.user_id)
    );
    setProfileMap(pmap);
    setRows(list);
    setLoading(false);
  }, [filterEntity, filterModule, filterOperation, page, debouncedSearch]);

  useEffect(() => {
    if (!authLoading && isAdmin) void loadRows();
    if (!authLoading && !isAdmin) setLoading(false);
  }, [authLoading, isAdmin, loadRows]);

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
            Canonical audit trail: actor, module, labels (metadata), and values before/delta/after
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadRows()}
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
            placeholder="Search user, entity, module, action…"
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
          {MODULE_OPTIONS.map((m) => (
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
              <th className="whitespace-nowrap px-4 py-3 text-left font-semibold text-gray-700">Time</th>
              <th className="min-w-[9rem] px-4 py-3 text-left font-semibold text-gray-700">Who</th>
              <th className="px-4 py-3 text-left font-semibold text-gray-700">Operation</th>
              <th className="hidden md:table-cell px-4 py-3 text-left font-semibold text-gray-700">Scope</th>
              <th className="min-w-[11rem] px-4 py-3 text-left font-semibold text-gray-700">Purpose</th>
              <th className="min-w-[14rem] px-4 py-3 text-left font-semibold text-gray-700">Values</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-12 text-center text-gray-400">
                  No ledger rows found
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const prof = row.user_id ? profileMap.get(row.user_id) : undefined;
                const name = actorDisplayName(prof, row.user_email);
                const sub = actorSubtitle(prof, row.user_email);
                const purpose = ledgerPurposeLine(row);
                const valueLines = ledgerChangeBullets(row);

                return (
                  <tr key={row.id} className="align-top hover:bg-gray-50 transition-colors">
                    <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-500">{prettyTime(row.created_at)}</td>
                    <td className="px-4 py-3">
                      <div className="font-medium text-gray-900">{name}</div>
                      {sub ? <div className="text-xs text-gray-500">{sub}</div> : null}
                      {!row.user_id && !row.user_email?.trim() ? (
                        <div className="mt-0.5 text-xs text-amber-700">No actor recorded</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${
                          OP_COLORS[row.operation] ?? 'bg-gray-100 text-gray-700'
                        }`}
                      >
                        {row.operation}
                      </span>
                      <div className="mt-1 text-xs capitalize text-gray-600">{row.action}</div>
                    </td>
                    <td className="hidden md:table-cell px-4 py-3 text-xs text-gray-700">
                      <div className="font-medium text-gray-900">{row.module}</div>
                      <div>{row.entity_type}</div>
                      <div className="font-mono text-[11px] text-gray-400" title={row.entity_id}>
                        {truncateId(row.entity_id, 12)}
                      </div>
                      {row.reference_id ? (
                        <div className="mt-0.5 text-[11px] text-gray-500">
                          Ref: <span className="font-mono">{truncateId(row.reference_id, 12)}</span>
                        </div>
                      ) : null}
                    </td>
                    <td className="max-w-xs px-4 py-3 text-xs text-gray-800">
                      <p className="font-medium leading-snug">{purpose}</p>
                    </td>
                    <td className="max-w-lg px-4 py-3">
                      <ul className="list-inside list-disc space-y-0.5 text-xs text-gray-700">
                        {valueLines.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                      <TechnicalPayload row={row} />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-gray-500">
        <p>Showing {rows.length} entries per page</p>
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
