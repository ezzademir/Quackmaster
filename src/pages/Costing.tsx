import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EntityChip } from '../components/EntityChip';
import { Modal } from '../components/Modal';
import { Button, EmptyState, PageHeader, StatCard, Status, Tabs } from '../components/ui';
import { useAuth } from '../utils/auth';
import {
  costingStats,
  emptyCostingCopy,
  entityChoices,
  entityCodeForProcurementTag,
  filterCostingRows,
  formatPct,
  formatQty,
  formatRm,
  mergeDishCogs,
  sortDrift,
  type BomLineRow,
  type CostingTab,
  type DishCogsRow,
  type DishRow,
  type DriftRow,
  type PriceFlagRow,
  type RecipeCostRow,
  type RecipeParent,
} from '../utils/costingDisplay';
import { formatMytDateTime } from '../utils/poCancelUi';
import { supabase } from '../utils/supabase';

const RECIPE_COLS =
  'kind, id, entity_code, name, status, source_sheet, selling_price_ex_sst_rm, line_count, incomplete_lines, cost_complete, food_cost_rm, known_cost_rm';
const COGS_COLS = 'menu_item_id, cogs_dine_in_pct, cogs_takeaway_pct, food_cost_pct';
const DRIFT_COLS =
  'bom_line_id, entity_code, parent_name, parent_kind, component_name, supplier_item, snapshot_cost_rm, current_cost_rm, drift_rm, drift_pct';
const FLAG_COLS =
  'id, item_name, procurement_tag, price_rm, unit_cost_rm, previous_unit_cost_rm, pct_change, source, entered_at, note';
const LINE_COLS =
  'id, component_name, qty, unit, base_qty, line_cost_rm, cost_complete, price_basis, status, issues, shared_ingredient';

function costStatus(complete: boolean) {
  return complete ? <Status tone="success">Complete</Status> : <Status tone="warning">Incomplete</Status>;
}

function foodCost(row: { cost_complete: boolean; food_cost_rm: number | string | null; known_cost_rm: number | string | null }) {
  if (row.cost_complete) return formatRm(row.food_cost_rm, 4);
  if (row.known_cost_rm == null) return '—';
  return `${formatRm(row.known_cost_rm, 4)} partial`;
}

function RecipeLines({ recipe }: { recipe: RecipeCostRow }) {
  const [lines, setLines] = useState<BomLineRow[]>([]);
  const [parent, setParent] = useState<RecipeParent | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const table = recipe.kind === 'dish' ? 'menu_items' : 'sub_recipes';
    const parentCols =
      recipe.kind === 'dish'
        ? 'wastage_pct, servings, notes, packaging_rule, pkg_dine_in_rm, pkg_takeaway_rm'
        : 'wastage_pct, servings, notes, yield_note';
    const lineKey = recipe.kind === 'dish' ? 'menu_item_id' : 'sub_recipe_id';
    void (async () => {
      const [parentRes, lineRes] = await Promise.all([
        supabase.from(table).select(parentCols).eq('id', recipe.id).maybeSingle(),
        supabase.from('bom_lines').select(LINE_COLS).eq(lineKey, recipe.id).order('component_name'),
      ]);
      if (cancelled) return;
      if (parentRes.error || lineRes.error) {
        setError(parentRes.error?.message ?? lineRes.error?.message ?? 'Could not load the recipe.');
        return;
      }
      const raw = (parentRes.data ?? null) as Partial<RecipeParent> | null;
      setParent(
        raw
          ? {
              wastage_pct: raw.wastage_pct ?? null,
              servings: raw.servings ?? null,
              notes: raw.notes ?? null,
              yield_note: raw.yield_note ?? null,
              packaging_rule: raw.packaging_rule ?? null,
              pkg_dine_in_rm: raw.pkg_dine_in_rm ?? null,
              pkg_takeaway_rm: raw.pkg_takeaway_rm ?? null,
            }
          : null,
      );
      setLines((lineRes.data ?? []) as BomLineRow[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [recipe]);

  return (
    <div className="space-y-4">
      {error ? <p className="text-sm text-red-700">{error}</p> : null}
      <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4">
        <div>
          <dt className="text-xs text-stone-500">Food cost</dt>
          <dd className="font-medium tabular-nums text-stone-900">{foodCost(recipe)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Selling price ex SST</dt>
          <dd className="font-medium tabular-nums text-stone-900">{formatRm(recipe.selling_price_ex_sst_rm)}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Wastage</dt>
          <dd className="font-medium tabular-nums text-stone-900">{parent ? formatPct(parent.wastage_pct) : '—'}</dd>
        </div>
        <div>
          <dt className="text-xs text-stone-500">Servings</dt>
          <dd className="font-medium tabular-nums text-stone-900">{parent ? formatQty(parent.servings) : '—'}</dd>
        </div>
      </dl>
      {parent?.packaging_rule ? (
        <p className="text-sm text-stone-600">
          Packaging: {parent.packaging_rule}. Dine-in {formatRm(parent.pkg_dine_in_rm)}, takeaway {formatRm(parent.pkg_takeaway_rm)}.
        </p>
      ) : null}
      {parent?.yield_note ? <p className="text-sm text-stone-600">{parent.yield_note}</p> : null}
      {parent?.notes ? <p className="text-sm text-stone-500">{parent.notes}</p> : null}
      {lines.length === 0 && !error ? (
        <EmptyState title="No lines" description="This recipe has no bill of materials." />
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table min-w-[640px]">
            <thead>
              <tr>
                <th>Component</th>
                <th>Qty</th>
                <th>Line cost</th>
                <th>Basis</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((line) => (
                <tr key={line.id}>
                  <td>
                    <div className="font-medium">{line.component_name}</div>
                    {line.issues ? <div className="text-xs text-amber-800">{line.issues}</div> : null}
                    {line.shared_ingredient ? <div className="text-xs text-stone-400">Shared ingredient</div> : null}
                  </td>
                  <td className="tabular-nums">
                    {formatQty(line.qty)} {line.unit ?? ''}
                  </td>
                  <td className="tabular-nums">{line.cost_complete ? formatRm(line.line_cost_rm, 4) : '—'}</td>
                  <td className="capitalize">{line.price_basis}</td>
                  <td>{costStatus(line.cost_complete)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FlagRow({
  flag,
  busy,
  onDecide,
}: {
  flag: PriceFlagRow;
  busy: boolean;
  onDecide: (flag: PriceFlagRow, decision: 'accepted' | 'queried', note: string) => void;
}) {
  const [note, setNote] = useState('');
  return (
    <div className="space-y-3 border-b border-stone-100 px-4 py-3 last:border-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium text-stone-900">{flag.item_name}</div>
          <div className="mt-0.5 text-xs text-stone-500">
            <EntityChip code={entityCodeForProcurementTag(flag.procurement_tag)} />
            <span className="ml-2">
              {flag.source} · {formatMytDateTime(flag.entered_at)}
            </span>
          </div>
        </div>
        <div className="text-right text-sm tabular-nums">
          <div className="font-medium text-amber-800">{formatPct(flag.pct_change)}</div>
          <div className="text-xs text-stone-500">
            {formatRm(flag.previous_unit_cost_rm, 4)} → {formatRm(flag.unit_cost_rm, 4)}
          </div>
        </div>
      </div>
      {flag.note ? <p className="text-sm text-stone-600">{flag.note}</p> : null}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <input
          aria-label={`Note for ${flag.item_name}`}
          className="w-full rounded-lg border border-stone-200 px-3 py-2 text-sm sm:max-w-sm"
          placeholder="Note (optional)"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <div className="flex gap-2">
          <Button disabled={busy} onClick={() => onDecide(flag, 'accepted', note)} aria-label={`Accept ${flag.item_name}`}>
            Accept
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => onDecide(flag, 'queried', note)} aria-label={`Query ${flag.item_name}`}>
            Query
          </Button>
        </div>
      </div>
    </div>
  );
}

export function Costing() {
  const { isAdmin } = useAuth();
  const [tab, setTab] = useState<CostingTab>('dishes');
  const [entity, setEntity] = useState('all');
  const [query, setQuery] = useState('');
  const [recipes, setRecipes] = useState<RecipeCostRow[]>([]);
  const [cogs, setCogs] = useState<DishCogsRow[]>([]);
  const [drift, setDrift] = useState<DriftRow[]>([]);
  const [flags, setFlags] = useState<PriceFlagRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<RecipeCostRow | null>(null);
  const [busyFlagId, setBusyFlagId] = useState<string | null>(null);
  const busyFlagRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    const [recipeRes, cogsRes, driftRes, flagRes] = await Promise.all([
      supabase.from('v_recipe_cost').select(RECIPE_COLS).order('name'),
      supabase.from('v_dish_cogs').select(COGS_COLS),
      supabase.from('v_cost_drift').select(DRIFT_COLS),
      supabase.from('v_price_flags_open').select(FLAG_COLS).order('entered_at', { ascending: false }),
    ]);
    const failed = [recipeRes, cogsRes, driftRes, flagRes].find((result) => result.error);
    setError(failed?.error?.message ?? null);
    setRecipes((recipeRes.data ?? []) as RecipeCostRow[]);
    setCogs((cogsRes.data ?? []) as DishCogsRow[]);
    setDrift(sortDrift((driftRes.data ?? []) as DriftRow[]));
    setFlags((flagRes.data ?? []) as PriceFlagRow[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const dishes = useMemo(() => mergeDishCogs(recipes, cogs), [recipes, cogs]);
  const subRecipes = useMemo(() => recipes.filter((row) => row.kind === 'sub-recipe'), [recipes]);
  const stats = useMemo(() => costingStats(dishes, drift, flags), [dishes, drift, flags]);
  const choices = useMemo(
    () => entityChoices([...dishes, ...subRecipes, ...drift].map((row) => row.entity_code)),
    [dishes, subRecipes, drift],
  );

  const visibleDishes = filterCostingRows(dishes, entity, query, (row) => row.entity_code, (row) => row.name);
  const visibleRecipes = filterCostingRows(subRecipes, entity, query, (row) => row.entity_code, (row) => row.name);
  const visibleDrift = filterCostingRows(
    drift,
    entity,
    query,
    (row) => row.entity_code,
    (row) => `${row.parent_name} ${row.component_name} ${row.supplier_item ?? ''}`,
  );
  const visibleFlags = filterCostingRows(
    flags,
    entity,
    query,
    (row) => entityCodeForProcurementTag(row.procurement_tag),
    (row) => row.item_name,
  );

  async function decide(flag: PriceFlagRow, decision: 'accepted' | 'queried', note: string) {
    if (busyFlagRef.current) return;
    busyFlagRef.current = String(flag.id);
    setBusyFlagId(String(flag.id));
    const { error: insertError } = await supabase.from('price_flag_reviews').insert({
      price_history_id: flag.id,
      decision,
      note: note.trim() || null,
    });
    busyFlagRef.current = null;
    setBusyFlagId(null);
    if (insertError) {
      setError(insertError.message);
      return;
    }
    setFlags((rows) => rows.filter((row) => String(row.id) !== String(flag.id)));
  }

  if (!isAdmin) {
    return <EmptyState title="No access" description="Menu costing is visible to admins only." />;
  }

  const loadedCount =
    tab === 'dishes' ? dishes.length : tab === 'recipes' ? subRecipes.length : tab === 'drift' ? drift.length : flags.length;
  const visibleCount =
    tab === 'dishes'
      ? visibleDishes.length
      : tab === 'recipes'
        ? visibleRecipes.length
        : tab === 'drift'
          ? visibleDrift.length
          : visibleFlags.length;
  const empty = emptyCostingCopy(tab, loadedCount, visibleCount);

  return (
    <div className="space-y-4">
      <PageHeader
        title="Costing"
        description="Food cost per serving for Quackteow and Merdeka House. A dish stays incomplete until every line has a real price."
        filters={
          <>
            <select
              aria-label="Entity"
              className="rounded-lg border border-stone-200 bg-white px-3 py-2 text-sm"
              value={entity}
              onChange={(event) => setEntity(event.target.value)}
            >
              {choices.map((choice) => (
                <option key={choice.value} value={choice.value}>
                  {choice.label}
                </option>
              ))}
            </select>
            <input
              aria-label={tab === 'flags' ? 'Search price flags' : tab === 'drift' ? 'Search cost drift' : 'Search recipes'}
              type="search"
              className="rounded-lg border border-stone-200 px-3 py-2 text-sm"
              placeholder="Search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </>
        }
      />

      {error ? <div className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-800">{error}</div> : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Dishes with a full cost" value={stats.complete} sub={`${stats.dishes} dishes`} />
        <StatCard label="Incomplete dishes" value={stats.incomplete} tone={stats.incomplete > 0 ? 'danger' : 'default'} />
        <StatCard label="Lines that drifted" value={stats.drift} />
        <StatCard label="Open price flags" value={stats.flags} tone={stats.flags > 0 ? 'danger' : 'default'} />
      </div>

      <Tabs
        value={tab}
        onChange={setTab}
        items={[
          { id: 'dishes', label: 'Dishes' },
          { id: 'recipes', label: 'Sub-recipes' },
          { id: 'drift', label: 'Drift' },
          { id: 'flags', label: `Price flags${stats.flags ? ` (${stats.flags})` : ''}` },
        ]}
      />

      {loading ? <p className="text-sm text-stone-500">Loading…</p> : null}

      {!loading && empty ? (
        <div className="panel">
          <EmptyState title={empty.title} description={empty.description} />
        </div>
      ) : null}

      {!loading && tab === 'dishes' && visibleDishes.length > 0 ? (
        <RecipeTable rows={visibleDishes} showCogs onOpen={setSelected} />
      ) : null}
      {!loading && tab === 'recipes' && visibleRecipes.length > 0 ? (
        <RecipeTable rows={visibleRecipes} showCogs={false} onOpen={setSelected} />
      ) : null}

      {!loading && tab === 'drift' && visibleDrift.length > 0 ? (
        <div className="panel overflow-x-auto">
          <table className="data-table min-w-[760px]">
            <thead>
              <tr>
                <th>Recipe</th>
                <th>Component</th>
                <th>Entity</th>
                <th>Saved</th>
                <th>Current</th>
                <th>Drift</th>
              </tr>
            </thead>
            <tbody>
              {visibleDrift.map((row) => (
                <tr key={row.bom_line_id}>
                  <td>
                    <div className="font-medium">{row.parent_name}</div>
                    <div className="text-xs capitalize text-stone-400">{row.parent_kind}</div>
                  </td>
                  <td>
                    <div>{row.component_name}</div>
                    <div className="text-xs text-stone-400">{row.supplier_item}</div>
                  </td>
                  <td>
                    <EntityChip code={row.entity_code} />
                  </td>
                  <td className="tabular-nums">{formatRm(row.snapshot_cost_rm, 4)}</td>
                  <td className="tabular-nums">{formatRm(row.current_cost_rm, 4)}</td>
                  <td className={`tabular-nums ${Number(row.drift_rm) > 0 ? 'text-red-700' : 'text-stone-700'}`}>
                    {formatRm(row.drift_rm, 4)}
                    <div className="text-xs">{formatPct(row.drift_pct)}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {!loading && tab === 'flags' && visibleFlags.length > 0 ? (
        <div className="panel">
          {visibleFlags.map((flag) => (
            <FlagRow key={String(flag.id)} flag={flag} busy={busyFlagId !== null} onDecide={(row, decision, note) => void decide(row, decision, note)} />
          ))}
        </div>
      ) : null}

      <Modal
        isOpen={selected != null}
        onClose={() => setSelected(null)}
        title={
          selected ? (
            <span className="inline-flex items-center gap-2">
              {selected.name}
              <EntityChip code={selected.entity_code} />
            </span>
          ) : (
            'Recipe'
          )
        }
        size="xl"
      >
        {selected ? <RecipeLines key={selected.id} recipe={selected} /> : null}
      </Modal>
    </div>
  );
}

function RecipeTable({
  rows,
  showCogs,
  onOpen,
}: {
  rows: Array<RecipeCostRow | DishRow>;
  showCogs: boolean;
  onOpen: (row: RecipeCostRow) => void;
}) {
  return (
    <>
      <div className="space-y-2 md:hidden">
        {rows.map((row) => (
          <button
            key={row.id}
            type="button"
            onClick={() => onOpen(row)}
            className="flex w-full flex-col gap-2 rounded-xl border border-stone-200 bg-white p-3.5 text-left"
          >
            <div className="flex items-start justify-between gap-3">
              <span className="text-sm font-medium text-stone-900">{row.name}</span>
              <EntityChip code={row.entity_code} />
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-stone-500">
              {costStatus(row.cost_complete)}
              <span className="tabular-nums">{foodCost(row)}</span>
              {showCogs && 'cogs_dine_in_pct' in row ? (
                <span className="tabular-nums">Dine-in {formatPct(row.cogs_dine_in_pct)}</span>
              ) : null}
            </div>
          </button>
        ))}
      </div>
      <div className="panel hidden overflow-x-auto md:block">
        <table className="data-table min-w-[720px]">
          <thead>
            <tr>
              <th>Name</th>
              <th>Entity</th>
              <th>Food cost</th>
              <th>Price ex SST</th>
              {showCogs ? (
                <>
                  <th>Dine-in COGS</th>
                  <th>Takeaway COGS</th>
                </>
              ) : null}
              <th>Lines</th>
              <th>Cost</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  <button type="button" className="text-left font-medium text-brand-800 hover:underline" onClick={() => onOpen(row)}>
                    {row.name}
                  </button>
                  {row.status !== 'active' ? <div className="text-xs text-stone-400">{row.status}</div> : null}
                </td>
                <td>
                  <EntityChip code={row.entity_code} />
                </td>
                <td className="tabular-nums">{foodCost(row)}</td>
                <td className="tabular-nums">{formatRm(row.selling_price_ex_sst_rm)}</td>
                {showCogs && 'cogs_dine_in_pct' in row ? (
                  <>
                    <td className="tabular-nums">{formatPct(row.cogs_dine_in_pct)}</td>
                    <td className="tabular-nums">{formatPct(row.cogs_takeaway_pct)}</td>
                  </>
                ) : null}
                <td className="tabular-nums">
                  {formatQty(row.line_count)}
                  {Number(row.incomplete_lines) > 0 ? (
                    <div className="text-xs text-amber-800">{formatQty(row.incomplete_lines)} incomplete</div>
                  ) : null}
                </td>
                <td>{costStatus(row.cost_complete)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
