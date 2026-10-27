import { Fragment, useEffect, useMemo, useState } from 'react';
import { ChevronRight, Search } from 'lucide-react';
import { EmptyState, PageHeader, Tabs } from '../components/ui';
import { useAuth } from '../utils/auth';
import {
  addSupplierItemToBom,
  deleteBomLine,
  dishCogsFromSnapshot,
  fetchSourcingSuggestions,
  loadCostingSnapshot,
  updateBomLineQuantity,
  type CostingSnapshot,
} from '../utils/costingService';
import type { BomLine, MenuItem, SourcingSuggestion, SubRecipeCost } from '../types';

type CostingTab = 'dishes' | 'preps' | 'sourcing';

function money(value: number | null, digits = 2): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `RM ${value.toFixed(digits)}`;
}

function percent(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(1)}%`;
}

function rate(value: number | null): string {
  if (value == null || !Number.isFinite(value)) return '—';
  return `${(value * 100).toFixed(0)}%`;
}

function CostChip({ percentValue }: { percentValue: number | null }) {
  if (percentValue == null) {
    return <span className="inline-flex rounded-full bg-stone-100 px-2 py-0.5 text-xs font-semibold text-stone-500">No price</span>;
  }
  const tone =
    percentValue < 30
      ? 'bg-emerald-100 text-emerald-800'
      : percentValue <= 35
        ? 'bg-amber-100 text-amber-800'
        : 'bg-red-100 text-red-800';
  return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${tone}`}>{percentValue.toFixed(1)}%</span>;
}

function BomPanel({
  lines,
  entityCode,
  menuItemId,
  subRecipeId,
  choices,
  isAdmin,
  onChanged,
}: {
  lines: { id: string; name: string; quantity: number; unit: string; cost: number | null }[];
  entityCode: string;
  menuItemId?: string;
  subRecipeId?: string;
  choices: CostingSnapshot['supplierChoices'];
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  const [query, setQuery] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [formError, setFormError] = useState('');

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle.length < 2) return [];
    return choices.filter((choice) => choice.name.toLowerCase().includes(needle)).slice(0, 8);
  }, [choices, query]);

  async function addChoice(choice: CostingSnapshot['supplierChoices'][number]) {
    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFormError('Enter a quantity greater than zero.');
      return;
    }
    setBusyId(choice.id);
    setFormError('');
    const { error } = await addSupplierItemToBom({
      entityCode,
      menuItemId,
      subRecipeId,
      supplierItemId: choice.id,
      componentName: choice.name,
      quantity: qty,
      unit: choice.unit,
    });
    setBusyId(null);
    if (error) {
      setFormError(error.message);
      return;
    }
    setQuery('');
    await onChanged();
  }

  async function saveQuantity(lineId: string, next: string) {
    const qty = Number(next);
    if (!Number.isFinite(qty) || qty <= 0) {
      setFormError('Quantity must be greater than zero.');
      return;
    }
    setBusyId(lineId);
    setFormError('');
    const { error } = await updateBomLineQuantity(lineId, qty);
    setBusyId(null);
    if (error) {
      setFormError(error.message);
      return;
    }
    await onChanged();
  }

  async function remove(lineId: string) {
    setBusyId(lineId);
    setFormError('');
    const { error } = await deleteBomLine(lineId);
    setBusyId(null);
    if (error) {
      setFormError(error.message);
      return;
    }
    await onChanged();
  }

  return (
    <div className="bg-stone-50 px-4 py-3">
      {lines.length === 0 ? (
        <EmptyState title="No recipe lines" description="This item has no active bill of materials." />
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-stone-400">
              <th className="py-1 font-medium">Ingredient</th>
              <th className="py-1 font-medium">Qty</th>
              <th className="py-1 text-right font-medium">Live cost</th>
              {isAdmin ? <th className="py-1" /> : null}
            </tr>
          </thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.id} className="border-t border-stone-200">
                <td className="py-2 pr-3 text-stone-800">{line.name}</td>
                <td className="py-2 pr-3 text-stone-600">
                  {isAdmin ? (
                    <input
                      aria-label={`Quantity for ${line.name}`}
                      defaultValue={String(line.quantity)}
                      onBlur={(event) => {
                        if (event.target.value !== String(line.quantity)) void saveQuantity(line.id, event.target.value);
                      }}
                      className="w-24 rounded-md border border-stone-300 px-2 py-1 text-sm"
                      disabled={busyId === line.id}
                    />
                  ) : (
                    line.quantity
                  )}{' '}
                  {line.unit}
                </td>
                <td className="py-2 text-right text-stone-800">{money(line.cost, 4)}</td>
                {isAdmin ? (
                  <td className="py-2 text-right">
                    <button
                      type="button"
                      className="text-xs font-medium text-red-700 hover:underline disabled:opacity-50"
                      disabled={busyId === line.id}
                      onClick={() => void remove(line.id)}
                    >
                      Remove
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {isAdmin ? (
        <div className="mt-3 border-t border-stone-200 pt-3">
          <label className="mb-1 block text-xs font-medium text-stone-500" htmlFor={`add-${menuItemId ?? subRecipeId}`}>
            Add supplier item
          </label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <input
              id={`add-${menuItemId ?? subRecipeId}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search supplier items"
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm"
            />
            <input
              aria-label="Quantity to add"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
              className="w-full rounded-lg border border-stone-300 px-3 py-2 text-sm sm:w-28"
            />
          </div>
          {matches.length > 0 ? (
            <ul className="mt-2 overflow-hidden rounded-lg border border-stone-200 bg-white">
              {matches.map((choice) => (
                <li key={choice.id}>
                  <button
                    type="button"
                    className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-stone-50 disabled:opacity-50"
                    disabled={busyId === choice.id}
                    onClick={() => void addChoice(choice)}
                  >
                    <span>{choice.name}</span>
                    <span className="text-stone-400">{money(choice.unitCost, 4)} / {choice.unit}</span>
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {formError ? <p className="mt-2 text-sm text-red-600">{formError}</p> : null}
    </div>
  );
}

export function Costing() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<CostingTab>('dishes');
  const [search, setSearch] = useState('');
  const [snapshot, setSnapshot] = useState<CostingSnapshot | null>(null);
  const [suggestions, setSuggestions] = useState<SourcingSuggestion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  async function reload() {
    setReloadKey((current) => current + 1);
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      setError('');
      const [book, sourcing] = await Promise.all([loadCostingSnapshot(), fetchSourcingSuggestions()]);
      if (cancelled) return;
      setLoading(false);
      if (book.error || !book.data) {
        setError(book.error?.message ?? 'Could not load the recipe book.');
        return;
      }
      setSnapshot(book.data);
      if (sourcing.error) {
        setError(sourcing.error.message);
        setSuggestions([]);
        return;
      }
      setSuggestions(sourcing.data);
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  const needle = search.trim().toLowerCase();
  const dishes = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.menuItems
      .filter((item) => item.is_active)
      .filter((item) => !needle || item.name.toLowerCase().includes(needle) || (item.category ?? '').toLowerCase().includes(needle))
      .map((item) => ({ item, cost: dishCogsFromSnapshot(item, snapshot) }));
  }, [needle, snapshot]);

  const preps = useMemo(() => {
    if (!snapshot) return [];
    return snapshot.subRecipes.filter(
      (prep) => prep.is_active && (!needle || prep.name.toLowerCase().includes(needle) || prep.entity_code.toLowerCase().includes(needle)),
    );
  }, [needle, snapshot]);

  const sourcingRows = useMemo(
    () => suggestions.filter((row) => !needle || row.material_name.toLowerCase().includes(needle) || (row.preferred_supplier_name ?? '').toLowerCase().includes(needle)),
    [needle, suggestions],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Recipe book"
        description="Live dish cost from current supplier prices. Production runs and lot tracking stay on their own pages."
        filters={
          <label className="relative block w-full sm:w-72">
            <span className="sr-only">Search</span>
            <Search size={16} className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-stone-400" />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search dishes, preps, or vendors"
              className="w-full rounded-lg border border-stone-300 py-2 pl-9 pr-3 text-sm"
            />
          </label>
        }
      />

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'dishes', label: 'Dishes' },
          { id: 'preps', label: 'Sub-recipes' },
          { id: 'sourcing', label: 'Vendor comparison' },
        ]}
      />

      {error ? <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
      {loading ? <p className="text-sm text-stone-500">Loading recipe book…</p> : null}

      {!loading && snapshot && tab === 'dishes' ? (
        <DishTable
          rows={dishes}
          openId={openId}
          onToggle={setOpenId}
          snapshot={snapshot}
          isAdmin={isAdmin}
          onChanged={reload}
        />
      ) : null}

      {!loading && snapshot && tab === 'preps' ? (
        <PrepTable rows={preps} openId={openId} onToggle={setOpenId} snapshot={snapshot} isAdmin={isAdmin} onChanged={reload} />
      ) : null}

      {!loading && tab === 'sourcing' ? <SourcingTable rows={sourcingRows} /> : null}
    </div>
  );
}

function DishTable({
  rows,
  openId,
  onToggle,
  snapshot,
  isAdmin,
  onChanged,
}: {
  rows: { item: MenuItem; cost: ReturnType<typeof dishCogsFromSnapshot> }[];
  openId: string | null;
  onToggle: (id: string | null) => void;
  snapshot: CostingSnapshot;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  if (rows.length === 0) {
    return <EmptyState title="No dishes" description="Active menu items will show here once the catalog has them." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="px-4 py-3 font-medium">Dish</th>
            <th className="px-4 py-3 font-medium">Group</th>
            <th className="px-4 py-3 text-right font-medium">Sell price</th>
            <th className="px-4 py-3 text-right font-medium">Food cost</th>
            <th className="px-4 py-3 font-medium">Cost %</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(({ item, cost }) => {
            const open = openId === item.id;
            return (
              <Fragment key={item.id}>
                <tr className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 font-medium text-stone-900"
                      aria-expanded={open}
                      onClick={() => onToggle(open ? null : item.id)}
                    >
                      <ChevronRight size={16} className={`text-stone-400 transition-transform ${open ? 'rotate-90' : ''}`} />
                      {item.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-stone-500">{item.category}</td>
                  <td className="px-4 py-3 text-right">{money(item.selling_price)}</td>
                  <td className="px-4 py-3 text-right">
                    {money(cost.foodCost)}
                    {cost.incomplete ? <span className="ml-1 text-xs text-amber-700">partial</span> : null}
                  </td>
                  <td className="px-4 py-3">
                    <CostChip percentValue={cost.foodCostPercent} />
                  </td>
                </tr>
                {open ? (
                  <tr className="border-t border-stone-100">
                    <td colSpan={5}>
                      <BomPanel
                        lines={cost.lines}
                        entityCode={item.entity_code}
                        menuItemId={item.id}
                        choices={snapshot.supplierChoices}
                        isAdmin={isAdmin}
                        onChanged={onChanged}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PrepTable({
  rows,
  openId,
  onToggle,
  snapshot,
  isAdmin,
  onChanged,
}: {
  rows: SubRecipeCost[];
  openId: string | null;
  onToggle: (id: string | null) => void;
  snapshot: CostingSnapshot;
  isAdmin: boolean;
  onChanged: () => Promise<void>;
}) {
  if (rows.length === 0) {
    return <EmptyState title="No sub-recipes" description="Prep batches from the recipe book will show here." />;
  }
  return (
    <div className="overflow-hidden rounded-xl border border-stone-200 bg-white">
      <table className="w-full text-sm">
        <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="px-4 py-3 font-medium">Prep</th>
            <th className="px-4 py-3 font-medium">Group</th>
            <th className="px-4 py-3 text-right font-medium">Yield</th>
            <th className="px-4 py-3 text-right font-medium">Batch cost</th>
            <th className="px-4 py-3 text-right font-medium">Per yield</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((prep) => {
            const open = openId === prep.id;
            const lines = snapshot.bomLines
              .filter((line) => line.sub_recipe_id === prep.id)
              .map((line) => ({
                id: line.id,
                name: line.component_name,
                quantity: line.base_qty ?? line.quantity,
                unit: line.unit,
                cost: lineCostForPrep(line, snapshot),
              }));
            return (
              <Fragment key={prep.id}>
                <tr className="border-t border-stone-100">
                  <td className="px-4 py-3">
                    <button
                      type="button"
                      className="inline-flex items-center gap-2 font-medium text-stone-900"
                      aria-expanded={open}
                      onClick={() => onToggle(open ? null : prep.id)}
                    >
                      <ChevronRight size={16} className={`text-stone-400 transition-transform ${open ? 'rotate-90' : ''}`} />
                      {prep.name}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-stone-500">{prep.entity_code}</td>
                  <td className="px-4 py-3 text-right">{prep.servings}</td>
                  <td className="px-4 py-3 text-right">
                    {money(prep.batchCost)}
                    {prep.incomplete ? <span className="ml-1 text-xs text-amber-700">partial</span> : null}
                  </td>
                  <td className="px-4 py-3 text-right">{money(prep.unitCost, 4)}</td>
                </tr>
                {open ? (
                  <tr className="border-t border-stone-100">
                    <td colSpan={5}>
                      <BomPanel
                        lines={lines}
                        entityCode={prep.entity_code}
                        subRecipeId={prep.id}
                        choices={snapshot.supplierChoices}
                        isAdmin={isAdmin}
                        onChanged={onChanged}
                      />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-stone-100 px-4 py-3 text-xs text-stone-500">
        Central-kitchen production recipes stay on the Production page so run history and lot labels are not edited from here.
      </p>
    </div>
  );
}

function lineCostForPrep(line: BomLine, snapshot: CostingSnapshot): number | null {
  if (!line.supplier_item_id) return line.line_cost_rm;
  const unit = snapshot.unitCostBySupplierItem.get(line.supplier_item_id);
  const qty = line.base_qty ?? line.quantity;
  if (unit == null) return line.line_cost_rm;
  return unit * qty;
}

function SourcingTable({ rows }: { rows: SourcingSuggestion[] }) {
  if (rows.length === 0) {
    return <EmptyState title="No vendor comparisons" description="Active priced supplier items will appear here." />;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-stone-200 bg-white">
      <table className="w-full min-w-[720px] text-sm">
        <thead className="bg-stone-50 text-left text-xs uppercase tracking-wide text-stone-500">
          <tr>
            <th className="px-4 py-3 font-medium">Ingredient</th>
            <th className="px-4 py-3 font-medium">Preferred vendor</th>
            <th className="px-4 py-3 text-right font-medium">Preferred cost</th>
            <th className="px-4 py-3 font-medium">Lowest vendor</th>
            <th className="px-4 py-3 text-right font-medium">Lowest cost</th>
            <th className="px-4 py-3 text-right font-medium">Savings</th>
            <th className="px-4 py-3 text-right font-medium">OTIF</th>
            <th className="px-4 py-3 text-right font-medium">Fill</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.ingredient_id ?? row.material_name} className="border-t border-stone-100">
              <td className="px-4 py-3">
                <div className="font-medium text-stone-900">{row.material_name}</div>
                <div className="text-xs text-stone-400">{row.supplier_count} vendor{row.supplier_count === 1 ? '' : 's'} · {row.base_unit}</div>
              </td>
              <td className="px-4 py-3 text-stone-700">{row.preferred_supplier_name ?? '—'}</td>
              <td className="px-4 py-3 text-right">{money(row.preferred_unit_cost, 4)}</td>
              <td className="px-4 py-3 text-stone-700">
                {row.lowest_supplier_name ?? '—'}
                {row.preferred_is_lowest ? <span className="ml-1 text-xs text-emerald-700">best</span> : null}
              </td>
              <td className="px-4 py-3 text-right">{money(row.lowest_unit_cost, 4)}</td>
              <td className="px-4 py-3 text-right">{percent(row.savings_percent)}</td>
              <td className="px-4 py-3 text-right">{rate(row.preferred_otif_rate)}</td>
              <td className="px-4 py-3 text-right">{rate(row.preferred_fill_rate)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
