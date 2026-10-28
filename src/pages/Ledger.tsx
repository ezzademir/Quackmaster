import { useEffect, useState, useCallback } from 'react';
import { Search, RefreshCw, Shield } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, EmptyState, ListRow, PageHeader } from '../components/ui';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';
import {
  actorDisplayName,
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

const MODULE_OPTIONS = ['procurement', 'production', 'distribution', 'inventory', 'auth', 'users', 'settings', 'waste', 'stock_take'];

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
          <p className="mt-1 text-sm text-gray-500">Only administrators can view the change log.</p>
        </div>
        <Link to="/" className="text-sm font-medium text-blue-600 hover:text-blue-800">
          Back to Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Change log"
        description="Who changed what in the system — user actions, settings, and module edits (not stock movement math)."
        actions={
          <Button variant="secondary" type="button" onClick={() => void loadRows()}>
            <RefreshCw size={16} /> Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap gap-3">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
          <input
            value={searchInput}
            onChange={(e) => {
              setSearchInput(e.target.value);
              setPage(0);
            }}
            placeholder="Search user, entity, module, action…"
            className="w-72 rounded-lg border border-stone-300 pl-9 pr-4 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </div>
        <select
          value={filterOperation}
          onChange={(e) => {
            setFilterOperation(e.target.value);
            setPage(0);
          }}
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none"
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
          className="rounded-lg border border-stone-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>

      {rows.length === 0 ? (
        <div className="panel py-2">
          <EmptyState title="No ledger rows found" />
        </div>
      ) : (
        <>
          <div className="ios-group">
            {rows.map((row) => {
              const prof = row.user_id ? profileMap.get(row.user_id) : undefined;
              const name = actorDisplayName(prof, row.user_email);
              const purpose = ledgerPurposeLine(row);
              const valueLines = ledgerChangeBullets(row);
              return (
                <ListRow
                  key={row.id}
                  title={purpose}
                  meta={`${prettyTime(row.created_at)} · ${name} · ${row.operation} · ${row.module}`}
                  body={
                    <div className="space-y-2 text-[13px] text-stone-700">
                      <p className="text-stone-500">
                        {row.entity_type} · {truncateId(row.entity_id, 12)}
                        {row.reference_id ? ` · ref ${truncateId(row.reference_id, 12)}` : ''}
                      </p>
                      <ul className="list-inside list-disc space-y-0.5">
                        {valueLines.map((line, i) => (
                          <li key={i}>{line}</li>
                        ))}
                      </ul>
                      <TechnicalPayload row={row} />
                    </div>
                  }
                />
              );
            })}
          </div>
        </>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-stone-500">
        <p>Showing {rows.length} entries per page</p>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setPage(Math.max(0, page - 1))}
            disabled={page === 0}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-stone-50 transition-colors"
          >
            Previous
          </button>
          <span className="rounded-lg border border-stone-300 bg-stone-50 px-3 py-1.5 text-sm font-medium">
            Page {page + 1}
          </span>
          <button
            type="button"
            onClick={() => setPage(page + 1)}
            disabled={rows.length < PAGE_SIZE}
            className="rounded-lg border border-stone-300 px-3 py-1.5 text-sm font-medium disabled:opacity-40 hover:bg-stone-50 transition-colors"
          >
            Next
          </button>
        </div>
      </div>
    </div>
  );
}
