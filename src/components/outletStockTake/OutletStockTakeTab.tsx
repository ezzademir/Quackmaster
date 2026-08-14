import { useCallback, useEffect, useMemo, useState } from 'react';
import { ClipboardList, Download } from 'lucide-react';
import type { Outlet } from '../../types';
import { supabase } from '../../utils/supabase';
import { hubRowAvailableQuantity } from '../../utils/hubInventoryMath';
import {
  allocateSkuCountToLots,
  buildOutletStockTakeCsv,
  fetchOutletInventoryRowsForStockTake,
  getOutletStockTakeSessionDetail,
  groupRowsForSkuCount,
  listOutletStockTakeSessions,
  postOutletStockTake,
  type OutletStockTakeSessionRow,
  type OutletStockTakeLineRow,
} from '../../utils/outletStockTakeService';
import { fetchStockTakeVarianceThreshold } from '../../utils/stockTakeSettings';
import { displayLotFirst, displaySkuSecond, nestedLotLabel, nestedRecipeSku } from '../../utils/lotLabel';

type RecipeMeta = { id: string; name: string; default_product_batch: string | null };

type DraftRow = {
  id: string;
  raw_material_id: string | null;
  product_batch: string | null;
  lot_label: string;
  quantity_on_hand: number;
  reserved_quantity: number;
  available_quantity: number;
  /** Primary column (recipe title, RM name, or FG batch when no recipe). */
  item_label: string;
  /** Secondary line — batch code, ingredient usage hints, etc. */
  item_detail: string;
  countedStr: string;
  remark: string;
  expiry_date?: string | null;
  created_at?: string | null;
  recipe_sku?: string | null;
};

function normBatch(pb: string | null | undefined): string {
  return String(pb ?? '').trim();
}

/** Map raw_material_id → distinct recipe names (from recipe_ingredients embed). */
function buildRmToRecipes(ingredientLines: unknown[]): Map<string, string[]> {
  const rmToRecipes = new Map<string, string[]>();
  for (const line of ingredientLines) {
    const row = line as { raw_material_id?: string; recipes?: { name?: string } | null };
    const rid = row.raw_material_id;
    const nm = row.recipes?.name?.trim();
    if (!rid || !nm) continue;
    const arr = rmToRecipes.get(rid) ?? [];
    if (!arr.includes(nm)) arr.push(nm);
    rmToRecipes.set(rid, arr);
  }
  for (const arr of rmToRecipes.values()) arr.sort((a, b) => a.localeCompare(b));
  return rmToRecipes;
}

function csvPrimaryLabel(
  inv: OutletStockTakeLineRow['outlet_inventory']
): string {
  if (!inv) return '';
  const lot = nestedLotLabel(inv.lot);
  if (lot) return lot;
  const pb = typeof inv.product_batch === 'string' ? inv.product_batch.trim() : '';
  if (pb) return pb;
  const m = inv.raw_materials ?? inv.material;
  const n = [m?.name?.trim(), m?.unit_of_measure?.trim()].filter(Boolean).join(' · ');
  return n || 'Ingredient';
}

/** PostgREST may nest RM as `raw_materials`, `material` alias, or (rare) an array; normalize for reading. */
function nestedMaterialPayload(r: Record<string, unknown>): { name?: string | null; unit_of_measure?: string | null } | null {
  const raw = r.raw_materials ?? r.material;
  if (raw == null || typeof raw !== 'object') return null;
  if (Array.isArray(raw)) {
    const head = raw[0];
    if (!head || typeof head !== 'object') return null;
    return head as { name?: string | null; unit_of_measure?: string | null };
  }
  return raw as { name?: string | null; unit_of_measure?: string | null };
}

function describeUnknownFetchError(context: string, err: unknown): string {
  if (err instanceof Error && err.message) return `${context}: ${err.message}`;
  if (err && typeof err === 'object' && 'message' in err && typeof (err as { message: unknown }).message === 'string')
    return `${context}: ${(err as { message: string }).message}`;
  try {
    return `${context}: ${JSON.stringify(err)}`;
  } catch {
    return `${context}: Unknown error`;
  }
}

function parseCount(raw: string): number | null {
  const n = parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) return null;
  return n;
}

function describePostError(
  payload: { error?: string; [k: string]: unknown },
  opts?: { blindSupervisor?: boolean }
): string {
  const code = payload.error;
  switch (code) {
    case 'not_authenticated_or_inactive':
      return 'You must be signed in as active staff to post a stock take.';
    case 'outlet_required':
      return 'Select an outlet.';
    case 'lines_required':
      return 'Add at least one inventory row (this outlet has no stock lines to count).';
    case 'invalid_line':
      return opts?.blindSupervisor
        ? 'Enter a valid counted quantity on every line.'
        : 'Each line needs a valid counted quantity (non‑negative number).';
    case 'outlet_inventory_not_found':
      return 'An inventory row no longer matches this outlet — refresh and try again.';
    case 'counted_below_reserved':
      return opts?.blindSupervisor
        ? 'One or more counts are below reserved stock. Adjust counts or contact a supervisor.'
        : 'Counted quantity cannot be below reserved quantity for a line.';
    case 'duplicate_outlet_inventory_id':
      return 'Duplicate inventory row in submission — refresh and try again.';
    default:
      return typeof code === 'string' ? code : 'Stock take could not be posted.';
  }
}

function downloadCsv(filename: string, csv: string) {
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

interface Props {
  outlets: Outlet[];
  onApplied?: () => void;
  /** When set, locks counting to this outlet (hides outlet picker). */
  lockedOutletId?: string | null;
  /** Pre-select outlet from deep link (e.g. reconciliation / audit). */
  initialOutletId?: string;
}

export function OutletStockTakeTab({ outlets, onApplied, lockedOutletId, initialOutletId }: Props) {
  const [outletId, setOutletId] = useState('');
  const [countDate, setCountDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [sessionNotes, setSessionNotes] = useState('');
  const [rows, setRows] = useState<DraftRow[]>([]);
  const [loadingInv, setLoadingInv] = useState(false);
  const [sessions, setSessions] = useState<OutletStockTakeSessionRow[]>([]);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [exportingId, setExportingId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null);
  /** Populated when supervisor view loads `recipes` (for catalog + ingredient cross-reference). */
  const [supervisorRecipeCatalog, setSupervisorRecipeCatalog] = useState<RecipeMeta[]>([]);
  /** Supervisor blind count: ingredients vs finished goods. */
  const [supervisorTab, setSupervisorTab] = useState<'ingredients' | 'finished_goods'>('ingredients');
  /** Staff/admin: count by lot row vs by SKU (product_batch / RM). */
  const [countMode, setCountMode] = useState<'lot' | 'sku'>('lot');
  /** Dual-count: second-entry map when variance exceeds threshold (staff/admin only). */
  const [recountPhase, setRecountPhase] = useState(false);
  const [recountStr, setRecountStr] = useState<Record<string, string>>({});
  const [varianceThreshold, setVarianceThreshold] = useState(5);

  const blindSupervisor = !!lockedOutletId;

  const loadOutletStockTakeData = useCallback(
    async (oid: string) => {
      if (!oid) {
        setRows([]);
        setSupervisorRecipeCatalog([]);
        return;
      }
      setLoadingInv(true);
      setMessage(null);
      setRecountPhase(false);
      setRecountStr({});

      try {
        if (lockedOutletId) {
          const isIngredients = supervisorTab === 'ingredients';
          const [invRes, recipeRes, ringRes] = await Promise.all([
            fetchOutletInventoryRowsForStockTake(oid, isIngredients ? { rmOnly: true } : { fgOnly: true }),
            supabase.from('recipes').select('id,name,default_product_batch').order('name'),
            supabase.from('recipe_ingredients').select('raw_material_id, recipes(name)'),
          ]);

          if (invRes.error) throw invRes.error;
          if (recipeRes.error) throw recipeRes.error;
          if (ringRes.error) throw ringRes.error;

          const inv = invRes.data;
          const recipes = (recipeRes.data ?? []) as RecipeMeta[];
          setSupervisorRecipeCatalog(recipes);

          const rmToRecipes = buildRmToRecipes(ringRes.data ?? []);
          const recipeByBatch = new Map(
            recipes
              .filter((r) => r.default_product_batch?.trim())
              .map((r) => [normBatch(r.default_product_batch), r.name] as const)
          );

          const mapped: DraftRow[] = (inv ?? []).flatMap((r: unknown) => {
            const row = r as Record<string, unknown>;
            const rmid = row.raw_material_id ? String(row.raw_material_id) : null;
            if (isIngredients && !rmid) return [];
            if (!isIngredients && rmid) return [];
            const qoh = Number(row.quantity_on_hand ?? 0);
            const res = Number(row.reserved_quantity ?? 0);
            const lot = row.lot as { product_batch_label?: string | null; expiry_date?: string | null } | null | undefined;
            const lotLabel = lot?.product_batch_label?.trim() || '';
            const recipeSku = nestedRecipeSku(row.lot);
            const av = hubRowAvailableQuantity(qoh, res, row.available_quantity != null ? Number(row.available_quantity) : null);
            const mat = nestedMaterialPayload(row);
            const pb = normBatch(row.product_batch as string | null | undefined);
            let item_label: string;
            let item_detail: string;
            if (isIngredients) {
              item_label = mat?.name?.trim() || 'Ingredient';
              const hint = rmid ? (rmToRecipes.get(rmid) ?? []).join(', ') : '';
              item_detail = hint ? `Used in: ${hint}` : '';
            } else {
              const recipeName = (recipeSku && recipeByBatch.get(recipeSku)) || (pb && recipeByBatch.get(pb)) || '';
              item_label = displayLotFirst(lotLabel, pb) || recipeName || 'Finished good';
              const sku = displaySkuSecond(lotLabel, pb, recipeSku);
              item_detail = [sku ? `SKU: ${sku}` : '', recipeName && recipeName !== item_label ? recipeName : '']
                .filter(Boolean)
                .join(' · ');
            }
            return [
              {
                id: String(row.id),
                raw_material_id: rmid,
                product_batch: pb || null,
                lot_label: lotLabel,
                recipe_sku: recipeSku || null,
                quantity_on_hand: qoh,
                reserved_quantity: res,
                available_quantity: av,
                item_label,
                item_detail,
                countedStr: '',
                remark: '',
                expiry_date: lot?.expiry_date ?? null,
                created_at: typeof row.created_at === 'string' ? row.created_at : null,
              } satisfies DraftRow,
            ];
          });

          mapped.sort((a, b) => a.item_label.localeCompare(b.item_label) || normBatch(a.product_batch).localeCompare(normBatch(b.product_batch)));
          setRows(mapped);
        } else {
          setSupervisorRecipeCatalog([]);
          const invRes = await fetchOutletInventoryRowsForStockTake(oid);
          if (invRes.error) throw invRes.error;

          const inv = invRes.data;

          const mapped: DraftRow[] = (inv ?? []).map((r: unknown) => {
            const row = r as Record<string, unknown>;
            const qoh = Number(row.quantity_on_hand ?? 0);
            const res = Number(row.reserved_quantity ?? 0);
            const lot = row.lot as { product_batch_label?: string | null; expiry_date?: string | null } | null | undefined;
            const lotLabel = lot?.product_batch_label?.trim() || '';
            const recipeSku = nestedRecipeSku(row.lot);
            const av = hubRowAvailableQuantity(qoh, res, row.available_quantity != null ? Number(row.available_quantity) : null);
            const rmid = row.raw_material_id ? String(row.raw_material_id) : null;
            const mat = nestedMaterialPayload(row);
            const pb = normBatch(row.product_batch as string | null | undefined);
            let item_label: string;
            let item_detail: string;
            if (rmid) {
              item_label = [mat?.name?.trim() || 'Ingredient', mat?.unit_of_measure?.trim()].filter(Boolean).join(' · ') || 'Ingredient';
              item_detail = '';
            } else {
              item_label = displayLotFirst(lotLabel, pb) || '—';
              const sku = displaySkuSecond(lotLabel, pb, recipeSku);
              item_detail = sku ? `SKU: ${sku}` : '';
            }
            return {
              id: String(row.id),
              raw_material_id: rmid,
              product_batch: pb || null,
              lot_label: lotLabel,
              recipe_sku: recipeSku || null,
              quantity_on_hand: qoh,
              reserved_quantity: res,
              available_quantity: av,
              item_label,
              item_detail,
              countedStr: String(qoh),
              remark: '',
              expiry_date: lot?.expiry_date ?? null,
              created_at: typeof row.created_at === 'string' ? row.created_at : null,
            };
          });
          mapped.sort((a, b) => a.item_label.localeCompare(b.item_label) || normBatch(a.product_batch).localeCompare(normBatch(b.product_batch)));
          setRows(mapped);
        }
      } catch (e) {
        setMessage({ tone: 'err', text: describeUnknownFetchError('Could not load outlet inventory', e) });
        setRows([]);
        setSupervisorRecipeCatalog([]);
      } finally {
        setLoadingInv(false);
      }
    },
    [lockedOutletId, supervisorTab]
  );

  const refreshSessions = useCallback(async (oid?: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingSessions(true);
    try {
      const list = await listOutletStockTakeSessions(oid || undefined);
      setSessions(list);
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Failed to load sessions.' });
    } finally {
      if (!opts?.silent) setLoadingSessions(false);
    }
  }, []);

  useEffect(() => {
    if (lockedOutletId) {
      setOutletId(lockedOutletId);
    }
  }, [lockedOutletId]);

  useEffect(() => {
    if (lockedOutletId || !initialOutletId) return;
    if (outlets.some((o) => o.id === initialOutletId)) {
      setOutletId(initialOutletId);
    }
  }, [initialOutletId, lockedOutletId, outlets]);

  useEffect(() => {
    void loadOutletStockTakeData(outletId);
  }, [outletId, loadOutletStockTakeData]);

  useEffect(() => {
    void (async () => {
      const t = await fetchStockTakeVarianceThreshold();
      setVarianceThreshold(t);
    })();
  }, []);

  useEffect(() => {
    void refreshSessions(outletId || undefined);
  }, [outletId, refreshSessions]);

  useEffect(() => {
    const channel = supabase
      .channel('outlet-stock-take-sessions')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'outlet_stock_take_sessions' },
        (payload) => {
          if (outletId) {
            const nid = (payload.new as { outlet_id?: string } | null)?.outlet_id;
            const oid = (payload.old as { outlet_id?: string } | null)?.outlet_id;
            const affected = nid ?? oid;
            if (affected && affected !== outletId) return;
          }
          void refreshSessions(outletId || undefined, { silent: true });
        }
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [outletId, refreshSessions]);

  const varianceOf = (r: DraftRow) => {
    const c = parseCount(r.countedStr);
    if (c === null) return null;
    return c - r.quantity_on_hand;
  };

  const skuGroups = useMemo(() => {
    if (blindSupervisor || countMode !== 'sku') return [];
    return groupRowsForSkuCount(
      rows.map((r) => ({
        id: r.id,
        raw_material_id: r.raw_material_id,
        product_batch: r.product_batch,
        recipe_sku: r.recipe_sku,
        quantity_on_hand: r.quantity_on_hand,
        reserved_quantity: r.reserved_quantity,
        expiry_date: r.expiry_date,
        created_at: r.created_at,
        item_label: r.item_label,
      }))
    );
  }, [blindSupervisor, countMode, rows]);

  const [skuCounted, setSkuCounted] = useState<Record<string, string>>({});
  const [skuRemarks, setSkuRemarks] = useState<Record<string, string>>({});

  useEffect(() => {
    if (countMode !== 'sku') return;
    const next: Record<string, string> = {};
    for (const g of skuGroups) {
      next[g.key] = String(g.system_qoh);
    }
    setSkuCounted(next);
    setSkuRemarks({});
    setRecountPhase(false);
    setRecountStr({});
  }, [countMode, outletId, rows.length]); // eslint-disable-line react-hooks/exhaustive-deps -- reset when inventory reloads

  const canSubmitLot =
    outletId &&
    rows.length > 0 &&
    !submitting &&
    !loadingInv &&
    rows.every((r) => {
      const c = parseCount(r.countedStr);
      return c !== null && c >= (r.reserved_quantity ?? 0);
    });

  const canSubmitSku =
    outletId &&
    skuGroups.length > 0 &&
    !submitting &&
    !loadingInv &&
    skuGroups.every((g) => {
      const c = parseCount(skuCounted[g.key] ?? '');
      return c !== null && c >= g.reserved;
    });

  const canSubmit = countMode === 'sku' && !blindSupervisor ? canSubmitSku : canSubmitLot;

  const linesNeedingRecount = (): Array<{ key: string; label: string; first: number; system: number }> => {
    if (blindSupervisor) return [];
    if (countMode === 'sku') {
      return skuGroups
        .map((g) => {
          const first = parseCount(skuCounted[g.key] ?? '');
          if (first === null) return null;
          const abs = Math.abs(first - g.system_qoh);
          if (abs <= varianceThreshold) return null;
          return { key: g.key, label: g.label, first, system: g.system_qoh };
        })
        .filter((x): x is { key: string; label: string; first: number; system: number } => !!x);
    }
    return rows
      .map((r) => {
        const first = parseCount(r.countedStr);
        if (first === null) return null;
        const abs = Math.abs(first - r.quantity_on_hand);
        if (abs <= varianceThreshold) return null;
        return { key: r.id, label: r.item_label, first, system: r.quantity_on_hand };
      })
      .filter((x): x is { key: string; label: string; first: number; system: number } => !!x);
  };

  const recountMatches = () => {
    const need = linesNeedingRecount();
    return need.every((n) => {
      const second = parseCount(recountStr[n.key] ?? '');
      return second !== null && Math.abs(second - n.first) < 0.0001;
    });
  };

  const postLines = async (
    lines: Array<{ outlet_inventory_id: string; counted_qty: number; line_remark?: string | null }>
  ) => {
    const idem = crypto.randomUUID();
    const result = await postOutletStockTake({
      outletId,
      countDate,
      notes: sessionNotes.trim() || null,
      lines,
      idempotencyKey: idem,
    });

    if (!result.success) {
      setMessage({
        tone: 'err',
        text: describePostError(result as { error?: string }, { blindSupervisor }),
      });
      return;
    }

    const sessionId = result.session_id;
    setMessage({
      tone: 'ok',
      text: result.idempotent_replay
        ? 'Replayed existing stock take (same idempotency key).'
        : 'Stock take posted and inventory updated.',
    });

    if (!blindSupervisor) {
      const detail = await getOutletStockTakeSessionDetail(sessionId);
      if (detail) {
        const csvLines = detail.lines.map((l) => ({
          outlet_inventory_id: l.outlet_inventory_id,
          product_batch: csvPrimaryLabel(l.outlet_inventory),
          lot_label: l.outlet_inventory?.lot?.product_batch_label ?? '',
          system_qoh_before: Number(l.system_qoh_before),
          counted_qty: Number(l.counted_qty),
          variance: Number(l.variance),
          line_remark: l.line_remark,
        }));
        const csv = buildOutletStockTakeCsv(detail, csvLines);
        const safeDate = (detail.count_date ?? countDate).replace(/[^\d-]/g, '');
        downloadCsv(`outlet-stock-take-${detail.id.slice(0, 8)}-${safeDate}.csv`, csv);
      }
    }

    setSessionNotes('');
    setRecountPhase(false);
    setRecountStr({});
    void loadOutletStockTakeData(outletId);
    void refreshSessions(outletId, { silent: true });
    onApplied?.();
  };

  const handleSubmit = async () => {
    if (!outletId) return;
    setSubmitting(true);
    setMessage(null);
    try {
      if (!blindSupervisor) {
        const need = linesNeedingRecount();
        if (need.length > 0 && !recountPhase) {
          setRecountPhase(true);
          setRecountStr(Object.fromEntries(need.map((n) => [n.key, ''])));
          setMessage({
            tone: 'err',
            text: `${need.length} line(s) exceed the variance threshold (±${varianceThreshold}). Enter a matching recount to confirm before posting.`,
          });
          return;
        }
        if (recountPhase && !recountMatches()) {
          setMessage({
            tone: 'err',
            text: 'Recount values must match the first count exactly for every highlighted line.',
          });
          return;
        }
      }

      if (countMode === 'sku' && !blindSupervisor) {
        const lines: Array<{ outlet_inventory_id: string; counted_qty: number; line_remark?: string | null }> = [];
        for (const g of skuGroups) {
          const c = parseCount(skuCounted[g.key] ?? '');
          if (c === null) throw new Error('invalid_counts');
          const allocated = allocateSkuCountToLots(g.lots, c);
          const remark = skuRemarks[g.key]?.trim() || null;
          for (const a of allocated) {
            lines.push({ ...a, line_remark: remark });
          }
        }
        await postLines(lines);
        return;
      }

      if (rows.length === 0) return;
      const lines = rows.map((r) => {
        const c = parseCount(r.countedStr);
        if (c === null) throw new Error('invalid_counts');
        return {
          outlet_inventory_id: r.id,
          counted_qty: c,
          line_remark: r.remark.trim() || null,
        };
      });
      await postLines(lines);
    } catch (e) {
      if ((e as Error).message === 'invalid_counts') {
        setMessage({
          tone: 'err',
          text: blindSupervisor
            ? 'Enter a valid counted quantity on every line before submitting.'
            : 'Fix invalid counted quantities before submitting.',
        });
      } else {
        setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Submit failed.' });
      }
    } finally {
      setSubmitting(false);
    }
  };

  const exportSession = async (sessionId: string) => {
    setExportingId(sessionId);
    setMessage(null);
    try {
      const detail = await getOutletStockTakeSessionDetail(sessionId);
      if (!detail) {
        setMessage({ tone: 'err', text: 'Session not found.' });
        return;
      }
      const csvLines = detail.lines.map((l) => ({
        outlet_inventory_id: l.outlet_inventory_id,
        product_batch: csvPrimaryLabel(l.outlet_inventory),
        lot_label: l.outlet_inventory?.lot?.product_batch_label ?? '',
        system_qoh_before: Number(l.system_qoh_before),
        counted_qty: Number(l.counted_qty),
        variance: Number(l.variance),
        line_remark: l.line_remark,
      }));
      const csv = buildOutletStockTakeCsv(detail, csvLines);
      const safeDate = (detail.count_date ?? '').replace(/[^\d-]/g, '');
      downloadCsv(`outlet-stock-take-${detail.id.slice(0, 8)}-${safeDate}.csv`, csv);
      setMessage({ tone: 'ok', text: 'CSV downloaded.' });
    } catch (e) {
      setMessage({ tone: 'err', text: e instanceof Error ? e.message : 'Export failed.' });
    } finally {
      setExportingId(null);
    }
  };

  const outletName = useMemo(() => outlets.find((o) => o.id === outletId)?.name ?? '', [outlets, outletId]);

  const inventoryColTitle = blindSupervisor
    ? supervisorTab === 'ingredients'
      ? 'Ingredient'
      : 'Finished good'
    : 'Batch / ingredient';

  const renderMobileInventoryCards = (subset: DraftRow[], blind: boolean) =>
    subset.map((r) => {
      const v = blind ? null : varianceOf(r);
      const bad = (() => {
        const c = parseCount(r.countedStr);
        if (c === null) return true;
        return c < (r.reserved_quantity ?? 0);
      })();
      return (
        <div
          key={r.id}
          className={`rounded-xl border bg-white p-3 shadow-sm ${
            bad ? 'border-red-200 bg-red-50/40' : 'border-gray-200'
          }`}
        >
          <div className="min-w-0 border-b border-gray-100 pb-2">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">{inventoryColTitle}</p>
            <p className="mt-0.5 font-medium leading-snug text-gray-900">{r.item_label}</p>
            {r.item_detail ? <p className="mt-1 text-xs leading-relaxed text-gray-500">{r.item_detail}</p> : null}
          </div>
          {!blind ? (
            <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2 text-sm">
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">SKU</dt>
                <dd className="tabular-nums text-gray-800">{displaySkuSecond(r.lot_label, r.product_batch, r.recipe_sku) || '—'}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">System QoH</dt>
                <dd className="tabular-nums text-right text-gray-900">{r.quantity_on_hand}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Reserved</dt>
                <dd className="tabular-nums text-right text-gray-600">{r.reserved_quantity}</dd>
              </div>
              <div>
                <dt className="text-[11px] font-medium uppercase tracking-wide text-gray-400">Variance</dt>
                <dd
                  className={`tabular-nums text-right ${
                    v != null && v !== 0 ? 'font-semibold text-amber-800' : 'text-gray-600'
                  }`}
                >
                  {v === null ? '—' : v}
                </dd>
              </div>
            </dl>
          ) : null}
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor={`count-${r.id}`}>
              Counted quantity
            </label>
            <input
              id={`count-${r.id}`}
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              autoComplete="off"
              value={r.countedStr}
              onChange={(e) => {
                const val = e.target.value;
                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, countedStr: val } : x)));
              }}
              className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-right text-base tabular-nums focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 sm:min-h-0 sm:text-sm"
            />
          </div>
          <div className="mt-3">
            <label className="mb-1 block text-xs font-medium text-gray-600" htmlFor={`remark-${r.id}`}>
              Line remark <span className="font-normal text-gray-400">(optional)</span>
            </label>
            <input
              id={`remark-${r.id}`}
              value={r.remark}
              onChange={(e) => {
                const val = e.target.value;
                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, remark: val } : x)));
              }}
              placeholder="Optional"
              autoComplete="off"
              className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-base focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 sm:min-h-0 sm:text-xs"
            />
          </div>
        </div>
      );
    });

  const renderInventoryRows = (subset: DraftRow[], blind: boolean) =>
    subset.map((r) => {
      const v = blind ? null : varianceOf(r);
      const bad = (() => {
        const c = parseCount(r.countedStr);
        if (c === null) return true;
        return c < (r.reserved_quantity ?? 0);
      })();
      return (
        <tr key={r.id} className={bad ? 'bg-red-50/40' : 'hover:bg-gray-50'}>
          <td className="px-3 py-2 text-gray-900">
            <div className="font-medium">{r.item_label}</div>
            {r.item_detail ? <div className="text-xs text-gray-500">{r.item_detail}</div> : null}
          </td>
          {!blind ? (
            <td className="hidden sm:table-cell px-3 py-2 text-gray-600 text-xs">
              {r.raw_material_id ? '—' : displaySkuSecond(r.lot_label, r.product_batch, r.recipe_sku) || '—'}
            </td>
          ) : null}
          {!blind ? <td className="px-3 py-2 text-right tabular-nums">{r.quantity_on_hand}</td> : null}
          {!blind ? (
            <td className="hidden md:table-cell px-3 py-2 text-right tabular-nums text-gray-600">{r.reserved_quantity}</td>
          ) : null}
          <td className="px-3 py-2 text-right">
            <input
              type="number"
              min={0}
              step="0.01"
              inputMode="decimal"
              autoComplete="off"
              value={r.countedStr}
              onChange={(e) => {
                const val = e.target.value;
                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, countedStr: val } : x)));
              }}
              className="w-full max-w-[7rem] rounded-lg border border-gray-300 px-2 py-1.5 text-right text-sm tabular-nums md:w-24 md:rounded md:py-1"
            />
          </td>
          {!blind ? (
            <td className={`px-3 py-2 text-right tabular-nums ${v != null && v !== 0 ? 'font-semibold text-amber-800' : 'text-gray-600'}`}>
              {v === null ? '—' : v}
            </td>
          ) : null}
          <td className="px-3 py-2">
            <input
              value={r.remark}
              onChange={(e) => {
                const val = e.target.value;
                setRows((prev) => prev.map((x) => (x.id === r.id ? { ...x, remark: val } : x)));
              }}
              placeholder="Optional"
              autoComplete="off"
              className="w-full min-w-[6rem] rounded-lg border border-gray-300 px-2 py-1.5 text-xs md:rounded md:py-1"
            />
          </td>
        </tr>
      );
    });

  const renderTableShell = (bodyRows: DraftRow[], blind: boolean) => (
    <>
      <div className="hidden overflow-x-auto rounded-lg border border-gray-200 md:block">
        <table className={`w-full text-sm ${blind ? 'min-w-[420px]' : 'min-w-[640px]'}`}>
          <thead className="border-b border-gray-200 bg-gray-50">
            <tr>
              <th className="px-3 py-2 text-left font-semibold text-gray-700">{inventoryColTitle}</th>
              {!blind ? (
                <th className="hidden sm:table-cell px-3 py-2 text-left font-semibold text-gray-700">SKU</th>
              ) : null}
              {!blind ? <th className="px-3 py-2 text-right font-semibold text-gray-700">System QoH</th> : null}
              {!blind ? (
                <th className="hidden md:table-cell px-3 py-2 text-right font-semibold text-gray-700">Reserved</th>
              ) : null}
              <th className="px-3 py-2 text-right font-semibold text-gray-700">Counted</th>
              {!blind ? <th className="px-3 py-2 text-right font-semibold text-gray-700">Variance</th> : null}
              <th className="min-w-[8rem] px-3 py-2 text-left font-semibold text-gray-700">Line remark</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">{renderInventoryRows(bodyRows, blind)}</tbody>
        </table>
      </div>
      <div className="space-y-3 md:hidden">{renderMobileInventoryCards(bodyRows, blind)}</div>
    </>
  );

  return (
    <div className="space-y-5 sm:space-y-6">
      <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-3 py-2.5 text-xs text-amber-950 sm:px-4 sm:py-3 sm:text-sm">
        <span className="inline-flex items-center gap-2 font-semibold text-amber-900">
          <ClipboardList size={18} className="size-[1.125rem] shrink-0 sm:size-[18px]" />
          Outlet stock take
        </span>
        <p className="mt-1.5 leading-relaxed text-amber-900/90">
          {lockedOutletId
            ? 'Blind count: use the Ingredients and Finished goods tabs. System quantities, lots, reservations, and variance are hidden. Enter every counted quantity for the active tab, then post. Admin and staff can export full session detail from Stock take.'
            : 'Count physical stock per lot row or by SKU. Submitting updates on-hand via the server. Lines exceeding the variance threshold require a matching recount before post. Counted quantity cannot be below reserved.'}
        </p>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <h2 className="text-sm font-semibold text-gray-800">New count</h2>
          {lockedOutletId ? (
            <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
              {(
                [
                  ['ingredients', 'Ingredients'],
                  ['finished_goods', 'Finished goods'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => setSupervisorTab(id)}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    supervisorTab === id ? 'bg-white text-amber-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          ) : (
            <div className="flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
              {(
                [
                  ['lot', 'By lot'],
                  ['sku', 'By SKU'],
                ] as const
              ).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setCountMode(id);
                    setRecountPhase(false);
                  }}
                  className={`flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors ${
                    countMode === id ? 'bg-white text-amber-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:items-end">
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium text-gray-600">Outlet</label>
              {lockedOutletId ? (
                <p className="min-h-11 w-full rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-base leading-snug text-gray-800 sm:min-h-0 sm:py-2 sm:text-sm">
                  {(outletName || outlets.find((o) => o.id === lockedOutletId)?.name) ?? 'Your outlet'}
                </p>
              ) : (
                <select
                  value={outletId}
                  onChange={(e) => setOutletId(e.target.value)}
                  className="min-h-11 w-full rounded-lg border border-gray-300 bg-white px-3 py-2.5 text-base focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 sm:min-h-0 sm:py-2 sm:text-sm"
                >
                  <option value="">Select outlet…</option>
                  {outlets.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <div className="min-w-0">
              <label className="mb-1 block text-xs font-medium text-gray-600">Count date</label>
              <input
                type="date"
                value={countDate}
                onChange={(e) => setCountDate(e.target.value)}
                className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 sm:min-h-0 sm:w-auto sm:py-2 sm:text-sm"
              />
            </div>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-600">Session notes (optional)</label>
            <input
              value={sessionNotes}
              onChange={(e) => setSessionNotes(e.target.value)}
              placeholder="e.g. Year-end count, cycle count Aisle 2…"
              autoComplete="off"
              className="min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2.5 text-base focus:border-amber-500 focus:outline-none focus:ring-1 focus:ring-amber-500 sm:min-h-0 sm:py-2 sm:text-sm"
            />
          </div>

          {message && (
            <p
              className={`rounded-lg px-3 py-2 text-sm ${
                message.tone === 'ok' ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'
              }`}
            >
              {message.text}
            </p>
          )}

          {loadingInv ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading inventory…</div>
          ) : !outletId ? (
            <p className="text-sm text-gray-500">Choose an outlet to load rows.</p>
          ) : (countMode === 'sku' && !blindSupervisor ? skuGroups.length === 0 : rows.length === 0) ? (
            <div className="space-y-1 text-sm text-amber-800">
              <p>
                {lockedOutletId
                  ? supervisorTab === 'ingredients'
                    ? 'No ingredient stock at this outlet — receive hub supply first before running this count.'
                    : 'No finished-goods stock at this outlet — receive hub supply first before running this count.'
                  : 'No outlet inventory rows — receive stock before running a stock take.'}
              </p>
              {lockedOutletId && supervisorTab === 'ingredients' && supervisorRecipeCatalog.length > 0 ? (
                <p className="text-xs text-gray-600">
                  Recipe catalog loaded ({supervisorRecipeCatalog.length} recipes); rows appear when hub supply creates ingredient lines.
                </p>
              ) : null}
            </div>
          ) : (
            <>
              {lockedOutletId ? (
                <div className="space-y-3">
                  <div>
                    <h3 className="text-sm font-semibold text-gray-800">
                      {supervisorTab === 'ingredients' ? 'Ingredients' : 'Finished goods'}
                    </h3>
                    {supervisorTab === 'ingredients' && supervisorRecipeCatalog.length > 0 ? (
                      <p className="mt-0.5 text-xs text-gray-500">
                        Recipe catalog loaded ({supervisorRecipeCatalog.length} recipes) — usage hints shown per line where known.
                      </p>
                    ) : null}
                  </div>
                  {renderTableShell(rows, true)}
                </div>
              ) : countMode === 'sku' ? (
                <div className="space-y-3">
                  <p className="text-xs text-gray-500">
                    Enter one counted total per SKU / ingredient. On post, quantities are allocated to lots FIFO by expiry.
                  </p>
                  <div className="hidden overflow-x-auto rounded-lg border border-gray-200 md:block">
                    <table className="w-full min-w-[520px] text-sm">
                      <thead className="border-b border-gray-200 bg-gray-50">
                        <tr>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700">SKU / ingredient</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-700">Lots</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-700">System QoH</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-700">Counted</th>
                          <th className="px-3 py-2 text-right font-semibold text-gray-700">Variance</th>
                          <th className="px-3 py-2 text-left font-semibold text-gray-700">Remark</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100">
                        {skuGroups.map((g) => {
                          const c = parseCount(skuCounted[g.key] ?? '');
                          const v = c === null ? null : c - g.system_qoh;
                          return (
                            <tr key={g.key} className="hover:bg-gray-50">
                              <td className="px-3 py-2 font-medium text-gray-900">{g.label}</td>
                              <td className="px-3 py-2 text-right tabular-nums text-gray-600">{g.lots.length}</td>
                              <td className="px-3 py-2 text-right tabular-nums">{g.system_qoh}</td>
                              <td className="px-3 py-2 text-right">
                                <input
                                  type="number"
                                  min={0}
                                  step="0.01"
                                  value={skuCounted[g.key] ?? ''}
                                  onChange={(e) => {
                                    const val = e.target.value;
                                    setSkuCounted((prev) => ({ ...prev, [g.key]: val }));
                                    setRecountPhase(false);
                                  }}
                                  className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm tabular-nums"
                                />
                              </td>
                              <td
                                className={`px-3 py-2 text-right tabular-nums ${
                                  v != null && Math.abs(v) > varianceThreshold ? 'font-semibold text-amber-800' : 'text-gray-600'
                                }`}
                              >
                                {v === null ? '—' : v}
                              </td>
                              <td className="px-3 py-2">
                                <input
                                  value={skuRemarks[g.key] ?? ''}
                                  onChange={(e) => setSkuRemarks((prev) => ({ ...prev, [g.key]: e.target.value }))}
                                  className="w-full min-w-[6rem] rounded border border-gray-300 px-2 py-1 text-xs"
                                  placeholder="Optional"
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="space-y-3 md:hidden">
                    {skuGroups.map((g) => {
                      const c = parseCount(skuCounted[g.key] ?? '');
                      const v = c === null ? null : c - g.system_qoh;
                      return (
                        <div key={g.key} className="rounded-xl border border-gray-200 bg-white p-3 shadow-sm">
                          <p className="font-medium text-gray-900">{g.label}</p>
                          <p className="text-xs text-gray-500">
                            {g.lots.length} lot(s) · System {g.system_qoh}
                            {v != null ? ` · Var ${v}` : ''}
                          </p>
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={skuCounted[g.key] ?? ''}
                            onChange={(e) => {
                              setSkuCounted((prev) => ({ ...prev, [g.key]: e.target.value }));
                              setRecountPhase(false);
                            }}
                            className="mt-2 min-h-11 w-full rounded-lg border border-gray-300 px-3 py-2 text-right"
                          />
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : (
                renderTableShell(rows, false)
              )}

              {recountPhase && !blindSupervisor ? (
                <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                  <p className="text-sm font-semibold text-amber-950">Recount required</p>
                  <p className="text-xs text-amber-900">
                    Re-enter the same counted quantity for each line below (threshold ±{varianceThreshold}).
                  </p>
                  {linesNeedingRecount().map((n) => (
                    <div key={n.key} className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="min-w-[8rem] flex-1 font-medium text-gray-800">{n.label}</span>
                      <span className="text-xs text-gray-500">First: {n.first}</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={recountStr[n.key] ?? ''}
                        onChange={(e) => setRecountStr((prev) => ({ ...prev, [n.key]: e.target.value }))}
                        placeholder="Recount"
                        className="w-28 rounded border border-amber-400 px-2 py-1 text-right text-sm"
                      />
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                <p className="order-2 text-xs text-gray-500 sm:order-1">
                  {outletName ? (
                    <>
                      Outlet: <span className="font-medium text-gray-700">{outletName}</span> ·{' '}
                      {countMode === 'sku' && !blindSupervisor
                        ? `${skuGroups.length} SKU${skuGroups.length !== 1 ? 's' : ''}`
                        : `${rows.length} row${rows.length !== 1 ? 's' : ''}`}
                      {blindSupervisor && supervisorRecipeCatalog.length > 0 ? (
                        <> · {supervisorRecipeCatalog.length} recipes in catalog</>
                      ) : null}
                    </>
                  ) : null}
                </p>
                <button
                  type="button"
                  onClick={() => void handleSubmit()}
                  disabled={!canSubmit}
                  className="order-1 min-h-11 w-full shrink-0 rounded-lg bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-700 disabled:cursor-not-allowed disabled:opacity-50 sm:order-2 sm:min-h-0 sm:w-auto sm:py-2 active:bg-amber-800"
                >
                  {submitting ? 'Posting…' : recountPhase ? 'Confirm recount & post' : 'Post stock take'}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="space-y-3 rounded-xl border border-gray-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold text-gray-800">Recent sessions</h2>
            {loadingSessions && <span className="text-xs text-gray-400">Loading…</span>}
          </div>
          <p className="text-xs leading-relaxed text-gray-500">
            {outletId ? 'Filtered to the selected outlet. ' : 'All outlets (latest 100). '}
            {blindSupervisor
              ? 'Your posted sessions appear here for reference. Admin or staff can export CSV from Inventory → Outlet stock take.'
              : 'Export CSV includes session metadata, variance, and line remarks.'}
          </p>
          <ul className="max-h-[min(28rem,55vh)] space-y-2 overflow-y-auto overscroll-y-contain text-sm sm:max-h-[28rem]">
            {sessions.length === 0 ? (
              <li className="text-gray-400">No sessions yet.</li>
            ) : (
              sessions.map((s) => (
                <li
                  key={s.id}
                  className="flex flex-col gap-2 rounded-lg border border-gray-100 bg-gray-50/80 px-3 py-2.5 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:py-2"
                >
                  <div className="min-w-0 flex-1">
                    <p className="break-words font-medium text-gray-900">{s.outlet?.name ?? 'Outlet'}</p>
                    <p className="mt-0.5 break-words text-xs text-gray-500">
                      {s.count_date} · posted {new Date(s.posted_at).toLocaleString()}
                      {s.notes ? ` · ${s.notes}` : ''}
                    </p>
                  </div>
                  {!blindSupervisor ? (
                    <button
                      type="button"
                      onClick={() => void exportSession(s.id)}
                      disabled={exportingId === s.id}
                      className="inline-flex min-h-10 w-full shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 sm:min-h-0 sm:w-auto sm:justify-center sm:py-1.5"
                    >
                      <Download size={14} className="shrink-0" aria-hidden />
                      {exportingId === s.id ? '…' : 'CSV'}
                    </button>
                  ) : null}
                </li>
              ))
            )}
          </ul>
        </div>
      </div>
    </div>
  );
}
