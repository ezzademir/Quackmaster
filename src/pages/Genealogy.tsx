import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { supabase } from '../utils/supabase';
import { StockViewToggle } from '../components/StockViewToggle';
import { PageHeader } from '../components/ui';
import { filterByStockView, type StockView } from '../utils/stockView';
import { skuForDisplay } from '../utils/lotLabel';
import {
  ancestorIds,
  attachAliases,
  aggregateLotLocations,
  childrenByParent,
  collectAliasesByLotId,
  escapeIlike,
  lotMatchesQuery,
  lotsMatchingQuery,
  mapInventoryLotRow,
  mergeLots,
  missingParentIds,
  remainingOnHand,
  resolveUniqueLotId,
  rootLots,
  treeKeepIds,
  type LotLocation,
  type OutletInvQtyRow,
  type TraceLot,
} from '../utils/lotTrace';

const LOT_SELECT = `
  id,
  product_batch_label,
  expiry_date,
  manufactured_at,
  parent_lot_id,
  purchase_order_item_id,
  production_run_id,
  created_at,
  production_run:production_run_id ( run_number, recipe:recipe_id ( default_product_batch ) )
`;

function nestedOutletName(raw: unknown): string | null {
  if (raw == null) return null;
  const obj = (Array.isArray(raw) ? raw[0] : raw) as { name?: string | null } | undefined;
  const n = obj?.name != null ? String(obj.name).trim() : '';
  return n || null;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—';
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (dateOnly) return `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleDateString();
}

function matchSubtree(id: string, keep: Set<string>, childrenOf: Map<string, TraceLot[]>): boolean {
  if (keep.has(id)) return true;
  for (const c of childrenOf.get(id) ?? []) {
    if (matchSubtree(c.id, keep, childrenOf)) return true;
  }
  return false;
}

export function Genealogy() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [lots, setLots] = useState<TraceLot[]>([]);
  const [locationsByLot, setLocationsByLot] = useState<Map<string, LotLocation[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState(() => searchParams.get('q') ?? '');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [stockView, setStockView] = useState<StockView>('in_stock');
  const [suggestOpen, setSuggestOpen] = useState(false);
  const lotsRef = useRef<TraceLot[]>([]);
  lotsRef.current = lots;

  const applyAliasesAndLocations = useCallback((nextLots: TraceLot[], hub: OutletInvQtyRow[], outlet: OutletInvQtyRow[]) => {
    const aliases = collectAliasesByLotId([...hub, ...outlet]);
    const withAliases = attachAliases(nextLots, aliases);
    setLots(withAliases);
    setLocationsByLot(aggregateLotLocations(hub, outlet));
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [{ data: lotRows }, { data: hubRows }, { data: outletRows }] = await Promise.all([
        supabase
          .from('inventory_lots')
          .select(LOT_SELECT)
          .order('created_at', { ascending: false })
          .limit(500),
        supabase
          .from('hub_inventory')
          .select('lot_id, product_batch, quantity_on_hand, reserved_quantity, available_quantity')
          .not('lot_id', 'is', null),
        supabase
          .from('outlet_inventory')
          .select(
            'lot_id, outlet_id, product_batch, quantity_on_hand, reserved_quantity, available_quantity, outlet:outlet_id(name)'
          )
          .not('lot_id', 'is', null),
      ]);
      if (cancelled) return;

      let mapped = ((lotRows ?? []) as Record<string, unknown>[]).map(mapInventoryLotRow);
      const missing = missingParentIds(mapped);
      if (missing.length > 0) {
        const { data: parents } = await supabase.from('inventory_lots').select(LOT_SELECT).in('id', missing);
        if (cancelled) return;
        mapped = mergeLots(mapped, ((parents ?? []) as Record<string, unknown>[]).map(mapInventoryLotRow));
      }

      const hub = (hubRows ?? []) as OutletInvQtyRow[];
      const outlet = ((outletRows ?? []) as Array<OutletInvQtyRow & { outlet?: unknown }>).map((row) => ({
        ...row,
        outlet_name: nestedOutletName(row.outlet),
      }));
      applyAliasesAndLocations(mapped, hub, outlet);
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [applyAliasesAndLocations]);

  useEffect(() => {
    const needle = q.trim();
    if (!needle) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      void (async () => {
        const pattern = `%${escapeIlike(needle)}%`;
        const [{ data: extraLots }, { data: hubAlias }, { data: outletAlias }] = await Promise.all([
          supabase.from('inventory_lots').select(LOT_SELECT).ilike('product_batch_label', pattern).limit(50),
          supabase
            .from('hub_inventory')
            .select('lot_id, product_batch')
            .ilike('product_batch', pattern)
            .not('lot_id', 'is', null)
            .limit(50),
          supabase
            .from('outlet_inventory')
            .select('lot_id, product_batch')
            .ilike('product_batch', pattern)
            .not('lot_id', 'is', null)
            .limit(50),
        ]);
        if (cancelled) return;

        let incoming = ((extraLots ?? []) as Record<string, unknown>[]).map(mapInventoryLotRow);
        const aliasRows = [
          ...((hubAlias ?? []) as Array<{ lot_id?: string | null; product_batch?: string | null }>),
          ...((outletAlias ?? []) as Array<{ lot_id?: string | null; product_batch?: string | null }>),
        ];
        const have = new Set([...lotsRef.current.map((l) => l.id), ...incoming.map((l) => l.id)]);
        const unknown = Array.from(
          new Set(aliasRows.map((r) => (r.lot_id ? String(r.lot_id) : '')).filter((id) => id && !have.has(id)))
        );
        if (unknown.length > 0) {
          const { data: byId } = await supabase.from('inventory_lots').select(LOT_SELECT).in('id', unknown);
          if (cancelled) return;
          incoming = mergeLots(incoming, ((byId ?? []) as Record<string, unknown>[]).map(mapInventoryLotRow));
        }
        const mergedPreview = mergeLots(lotsRef.current, incoming);
        const parents = missingParentIds(mergedPreview);
        if (parents.length > 0) {
          const { data: parentRows } = await supabase.from('inventory_lots').select(LOT_SELECT).in('id', parents);
          if (cancelled) return;
          incoming = mergeLots(incoming, ((parentRows ?? []) as Record<string, unknown>[]).map(mapInventoryLotRow));
        }
        const aliasMap = collectAliasesByLotId(aliasRows);
        setLots((prev) => attachAliases(mergeLots(prev, incoming), aliasMap));
      })();
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [q]);

  useEffect(() => {
    const unique = resolveUniqueLotId(lots, q);
    if (unique) setSelectedId(unique);
  }, [q, lots]);

  const childrenOf = useMemo(() => childrenByParent(lots), [lots]);
  const roots = useMemo(() => rootLots(lots), [lots]);

  const suggestions = useMemo(() => {
    const matches = lotsMatchingQuery(lots, q);
    return [...matches]
      .sort((a, b) => {
        const ra = remainingOnHand(locationsByLot.get(a.id) ?? []);
        const rb = remainingOnHand(locationsByLot.get(b.id) ?? []);
        if (rb !== ra) return rb - ra;
        return a.product_batch_label.localeCompare(b.product_batch_label);
      })
      .slice(0, 8);
  }, [lots, q, locationsByLot]);

  const filteredRoots = useMemo(() => {
    const needle = q.trim();
    if (!needle) return roots;
    const matchIds = new Set(lots.filter((l) => lotMatchesQuery(l, needle)).map((l) => l.id));
    const keep = treeKeepIds(lots, matchIds, childrenOf);
    return roots.filter((r) => keep.has(r.id) || matchSubtree(r.id, keep, childrenOf));
  }, [q, roots, lots, childrenOf]);

  useEffect(() => {
    if (!selectedId) return;
    setExpanded((prev) => {
      const n = new Set(prev);
      n.add(selectedId);
      for (const id of ancestorIds(selectedId, lots)) n.add(id);
      return n;
    });
  }, [selectedId, lots]);

  function chooseLot(lot: TraceLot) {
    setSelectedId(lot.id);
    setQ(lot.product_batch_label);
    setSearchParams({ q: lot.product_batch_label }, { replace: true });
    setSuggestOpen(false);
  }

  function toggle(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function renderNode(lot: TraceLot, depth: number): React.ReactNode {
    const kids = childrenOf.get(lot.id) ?? [];
    const open = expanded.has(lot.id);
    const selected = selectedId === lot.id;
    const remaining = remainingOnHand(locationsByLot.get(lot.id) ?? []);
    return (
      <div key={lot.id} className="select-none">
        <button
          type="button"
          onClick={() => {
            setSelectedId(lot.id);
            if (kids.length) toggle(lot.id);
          }}
          className={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-gray-50 ${
            selected ? 'bg-teal-50 ring-1 ring-teal-200' : ''
          }`}
          style={{ paddingLeft: 8 + depth * 16 }}
        >
          {kids.length > 0 ? (
            open ? (
              <ChevronDown size={14} className="text-gray-400" />
            ) : (
              <ChevronRight size={14} className="text-gray-400" />
            )
          ) : (
            <span className="inline-block w-3.5" />
          )}
          <span className="min-w-0 flex-1 truncate font-medium text-gray-900">{lot.product_batch_label}</span>
          <span className="shrink-0 text-xs tabular-nums text-gray-500">{remaining}</span>
        </button>
        {open && kids.map((c) => renderNode(c, depth + 1))}
      </div>
    );
  }

  if (loading) {
    return <div className="text-sm text-stone-500">Loading lots…</div>;
  }

  const selected = lots.find((l) => l.id === selectedId) ?? null;
  const parent = selected?.parent_lot_id ? lots.find((l) => l.id === selected.parent_lot_id) : null;
  const allLocations = selected ? (locationsByLot.get(selected.id) ?? []) : [];
  const visibleLocations = filterByStockView(allLocations, stockView, (r) => r.onHand);
  const remaining = remainingOnHand(allLocations);
  const sku = selected
    ? skuForDisplay(selected.product_batch_label, selected.aliases[0] ?? null, selected.recipeSku)
    : null;
  const skuListHint =
    q.trim() && resolveUniqueLotId(lots, q) == null && suggestions.length > 1
      ? `${suggestions.length} lots match — pick one.`
      : null;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Lot traceability"
        description="Search an ink lot, leftover BATCH code, or SKU. The tree is genealogy; the table is where that lot still sits."
      />

      <div className="relative max-w-lg">
        <input
          type="search"
          placeholder="Lot, BATCH code, or SKU…"
          value={q}
          onChange={(e) => {
            const next = e.target.value;
            setQ(next);
            setSuggestOpen(true);
            const trimmed = next.trim();
            if (trimmed) setSearchParams({ q: trimmed }, { replace: true });
            else setSearchParams({}, { replace: true });
          }}
          onFocus={() => setSuggestOpen(true)}
          onBlur={() => {
            window.setTimeout(() => setSuggestOpen(false), 180);
          }}
          className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm"
        />
        {skuListHint ? <p className="mt-1 text-xs text-amber-800">{skuListHint}</p> : null}
        {suggestOpen && q.trim() && suggestions.length > 0 ? (
          <ul className="absolute z-20 mt-1 max-h-72 w-full overflow-auto rounded-lg border border-gray-200 bg-white py-1 shadow-lg">
            {suggestions.map((lot) => {
              const rem = remainingOnHand(locationsByLot.get(lot.id) ?? []);
              const hint = skuForDisplay(lot.product_batch_label, lot.aliases[0] ?? null, lot.recipeSku);
              return (
                <li key={lot.id}>
                  <button
                    type="button"
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => chooseLot(lot)}
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-teal-50"
                  >
                    <span className="min-w-0">
                      <span className="block truncate font-mono font-medium text-gray-900">{lot.product_batch_label}</span>
                      {hint ? <span className="block truncate text-xs text-gray-500">SKU {hint}</span> : null}
                    </span>
                    <span className="shrink-0 tabular-nums text-xs text-gray-600">{rem} on hand</span>
                  </button>
                </li>
              );
            })}
          </ul>
        ) : null}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-800">Lot tree</h2>
          <p className="mb-2 text-xs text-gray-500">Parent ingredient lot and finished-goods children. Qty is remaining on hand.</p>
          <div className="max-h-[32rem] overflow-y-auto">
            {filteredRoots.length === 0 ? (
              <p className="py-8 text-center text-sm text-gray-400">
                {q.trim() ? 'No lots match that search.' : 'No lots recorded yet.'}
              </p>
            ) : (
              filteredRoots.map((r) => renderNode(r, 0))
            )}
          </div>
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-4 shadow-sm">
          <h2 className="mb-2 text-sm font-semibold text-gray-800">Lot detail</h2>
          {!selected ? (
            <p className="text-sm text-gray-400">Search or select a lot in the tree.</p>
          ) : (
            <div className="space-y-4">
              <dl className="space-y-2 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Lot</dt>
                  <dd className="font-mono font-medium text-gray-900">{selected.product_batch_label}</dd>
                </div>
                {sku ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500">SKU</dt>
                    <dd className="text-gray-900">{sku}</dd>
                  </div>
                ) : null}
                {selected.aliases.length > 0 ? (
                  <div className="flex justify-between gap-4">
                    <dt className="text-gray-500">Also stored as</dt>
                    <dd className="font-mono text-xs text-gray-600">{selected.aliases.join(', ')}</dd>
                  </div>
                ) : null}
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Expiry</dt>
                  <dd>{formatDate(selected.expiry_date)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Manufactured</dt>
                  <dd>{formatDate(selected.manufactured_at)}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Parent lot</dt>
                  <dd className="font-mono text-xs text-gray-800">
                    {parent?.product_batch_label ?? (selected.parent_lot_id ? selected.parent_lot_id.slice(0, 8) : '—')}
                  </dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-gray-500">Production run</dt>
                  <dd>{selected.runNumber ?? selected.production_run_id?.slice(0, 8) ?? '—'}</dd>
                </div>
                <div className="flex justify-between gap-4 border-t pt-2">
                  <dt className="text-gray-500">Remaining</dt>
                  <dd className="tabular-nums font-semibold text-gray-900">{remaining}</dd>
                </div>
              </dl>

              <div>
                <div className="mb-2 flex flex-wrap items-start justify-between gap-3">
                  <h3 className="text-sm font-semibold text-gray-800">Where it sits</h3>
                  <StockViewToggle value={stockView} onChange={setStockView} />
                </div>
                {visibleLocations.length === 0 ? (
                  <p className="text-sm text-gray-400">
                    {allLocations.length > 0 && stockView === 'in_stock'
                      ? 'No in-stock locations. Switch to All lots for empty / audit.'
                      : 'No hub or outlet rows linked to this lot.'}
                  </p>
                ) : (
                  <div className="overflow-x-auto rounded-lg border border-gray-200">
                    <table className="w-full text-sm">
                      <thead className="border-b bg-gray-50 text-left">
                        <tr>
                          <th className="px-3 py-2 font-medium text-gray-700">Location</th>
                          <th className="px-3 py-2 text-right font-medium text-gray-700">On hand</th>
                          <th className="px-3 py-2 text-right font-medium text-gray-700">Reserved</th>
                          <th className="px-3 py-2 text-right font-medium text-gray-700">Available</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {visibleLocations.map((row) => (
                          <tr key={row.key}>
                            <td className="px-3 py-2 text-gray-900">
                              {row.name}
                              <span className="ml-1 text-xs text-gray-400">{row.kind === 'hub' ? 'hub' : 'outlet'}</span>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-medium">{row.onHand}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-600">{row.reserved}</td>
                            <td className="px-3 py-2 text-right tabular-nums text-gray-800">{row.available}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
