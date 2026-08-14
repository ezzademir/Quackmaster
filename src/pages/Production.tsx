import { useEffect, useState } from 'react';
import { Plus, CreditCard as Edit2, Trash2, ChevronRight, FlaskConical, AlertCircle, Shield, Printer, RotateCcw, Ban } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Modal } from '../components/Modal';
import { DateFilter } from '../components/DateFilter';
import { ProductionPlanningPanel } from '../components/ProductionPlanningPanel';
import { FinishedGoodsLotLabel, type FinishedGoodsLotLabelData } from '../components/FinishedGoodsLotLabel';
import { supabase } from '../utils/supabase';
import { isDateInRange, type DateRange } from '../utils/dateRange';
import { logActivity } from '../utils/activityLog';
import {
  backfillLotExpiryForRecipe,
  completeProductionRun,
  deleteProductionRun,
  restoreVoidedProductionRun,
  voidProductionRun,
} from '../utils/productionService';
import { voidConfirmMatches } from '../utils/lotLabel';
import { useAuth } from '../utils/auth';
import type { Recipe, RecipeIngredient, RawMaterial, ProductionRun } from '../types';

type Tab = 'runs' | 'recipes' | 'planning';

/** Persisted QC yield, or derived from planned/actual when older rows never saved yield_percentage */
function effectiveRunYieldPct(run: {
  planned_output: number;
  actual_output: number;
  yield_percentage?: number | null;
}): number | null {
  if (run.yield_percentage != null && Number.isFinite(run.yield_percentage)) {
    return run.yield_percentage;
  }
  if (run.planned_output > 0) {
    return (run.actual_output / run.planned_output) * 100;
  }
  return null;
}

function StatusBadge({ status }: { status: string }) {
  const map: Record<string, string> = {
    in_progress: 'bg-blue-100 text-blue-700',
    completed: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-red-100 text-red-700',
    voided: 'bg-gray-200 text-gray-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${map[status] ?? 'bg-gray-100 text-gray-700'}`}>
      {status.replace('_', ' ')}
    </span>
  );
}

function YieldBar({ value }: { value: number }) {
  const color = value >= 95 ? 'bg-emerald-500' : value >= 80 ? 'bg-amber-400' : 'bg-red-500';
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 rounded-full bg-gray-200">
        <div className={`h-1.5 rounded-full ${color} transition-all`} style={{ width: `${Math.min(value, 100)}%` }} />
      </div>
      <span className="text-sm font-semibold text-gray-900">{value.toFixed(1)}%</span>
    </div>
  );
}

function VariantsBadge({ planned, actual }: { planned: number; actual: number }) {
  const variance = planned - actual;
  const tone =
    variance > 0
      ? 'bg-amber-100 text-amber-700'
      : variance < 0
        ? 'bg-blue-100 text-blue-700'
        : 'bg-emerald-100 text-emerald-700';

  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold ${tone}`}>
      {variance > 0 ? '+' : ''}
      {variance.toFixed(2)}
    </span>
  );
}

// ---- Recipe Modal ----
interface IngredientLine { raw_material_id: string; quantity_required: string; }

function RecipeModal({
  recipe,
  ingredients,
  materials,
  onClose,
  onSave,
}: {
  recipe: Recipe | null;
  ingredients: RecipeIngredient[];
  materials: RawMaterial[];
  onClose: () => void;
  onSave: () => void;
}) {
  const [form, setForm] = useState({
    name: recipe?.name ?? '',
    description: recipe?.description ?? '',
    standard_batch_size: recipe?.standard_batch_size?.toString() ?? '',
    batch_unit: recipe?.batch_unit ?? '',
    target_yield_percentage: recipe?.target_yield_percentage?.toString() ?? '100',
    default_product_batch: recipe?.default_product_batch ?? '',
    shelf_life_days: recipe?.shelf_life_days?.toString() ?? '',
  });
  const [lines, setLines] = useState<IngredientLine[]>(
    ingredients.length > 0
      ? ingredients.map((ing) => ({ raw_material_id: ing.raw_material_id, quantity_required: ing.quantity_required.toString() }))
      : [{ raw_material_id: '', quantity_required: '' }]
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  function addLine() { setLines([...lines, { raw_material_id: '', quantity_required: '' }]); }
  function removeLine(i: number) { setLines(lines.filter((_, idx) => idx !== i)); }
  function updateLine(i: number, key: keyof IngredientLine, val: string) {
    const next = [...lines]; next[i] = { ...next[i], [key]: val }; setLines(next);
  }

  async function handleSave() {
    if (!form.name.trim() || !form.standard_batch_size || !form.batch_unit.trim()) {
      setError('Name, batch size and batch unit are required'); return;
    }
    const validLines = lines.filter((l) => l.raw_material_id && parseFloat(l.quantity_required) > 0);
    if (validLines.length === 0) { setError('Add at least one ingredient'); return; }
    const batchCode = form.default_product_batch.trim();
    const shelfRaw = form.shelf_life_days.trim();
    const shelfDays = shelfRaw === '' ? null : parseInt(shelfRaw, 10);
    if (shelfRaw !== '' && (!Number.isFinite(shelfDays) || (shelfDays ?? 0) < 0)) {
      setError('Shelf life must be a non-negative number of days');
      return;
    }
    const prevSku = (recipe?.default_product_batch ?? '').trim();
    if (recipe && prevSku !== batchCode) {
      const { data: runs } = await supabase.from('production_runs').select('id').eq('recipe_id', recipe.id);
      const runIds = (runs ?? []).map((r) => r.id as string);
      let hasLotsOrStock = false;
      if (runIds.length > 0) {
        const { count: lotCount } = await supabase
          .from('inventory_lots')
          .select('id', { count: 'exact', head: true })
          .in('production_run_id', runIds);
        hasLotsOrStock = (lotCount ?? 0) > 0;
      }
      if (hasLotsOrStock) {
        const token = batchCode || 'CONFIRM';
        const typed = window.prompt(
          `This recipe has existing lots or stock.\n\nChanging the SKU only applies to NEW lots. Inked lot codes stay unchanged.\nLeftover stock will still sell under the old SKU and the new one after matching is updated.\n\nType ${token} to confirm.`
        );
        if ((typed ?? '').trim() !== token) {
          setError('SKU change cancelled');
          return;
        }
      }
    }
    setSaving(true);
    const payload = {
      name: form.name,
      description: form.description || null,
      standard_batch_size: parseFloat(form.standard_batch_size),
      batch_unit: form.batch_unit,
      target_yield_percentage: parseFloat(form.target_yield_percentage) || 100,
      default_product_batch: batchCode ? batchCode : null,
      shelf_life_days: shelfDays,
    };
    let recipeId = recipe?.id;
    if (recipe) {
      await supabase.from('recipes').update(payload).eq('id', recipe.id);
      await supabase.from('recipe_ingredients').delete().eq('recipe_id', recipe.id);
    } else {
      const { data, error: err } = await supabase.from('recipes').insert(payload).select().single();
      if (err || !data) { setError(err?.message ?? 'Failed'); setSaving(false); return; }
      recipeId = data.id;
    }
    await supabase.from('recipe_ingredients').insert(
      validLines.map((l) => ({ recipe_id: recipeId, raw_material_id: l.raw_material_id, quantity_required: parseFloat(l.quantity_required) }))
    );
    if (recipeId && shelfDays != null && shelfDays > 0) {
      await backfillLotExpiryForRecipe(recipeId, shelfDays);
    }
    await logActivity({ action: recipe ? 'updated' : 'created', entityType: 'recipe', entityId: recipeId ?? '', entityLabel: form.name });
    onSave();
  }

  return (
    <Modal isOpen onClose={onClose} title={recipe ? 'Edit Recipe' : 'New Recipe'} size="xl">
      {error && <p className="mb-4 rounded-lg bg-red-50 px-3 py-2 text-sm text-red-600">{error}</p>}
      <div className="space-y-5">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Recipe Name *</label>
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Description</label>
            <textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Standard Batch Size *</label>
            <input type="number" min="0" step="0.01" value={form.standard_batch_size} onChange={(e) => setForm({ ...form, standard_batch_size: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Batch Unit *</label>
            <input value={form.batch_unit} onChange={(e) => setForm({ ...form, batch_unit: e.target.value })} placeholder="kg, L, pcs…"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Target Yield %</label>
            <input type="number" min="0" max="100" step="0.1" value={form.target_yield_percentage} onChange={(e) => setForm({ ...form, target_yield_percentage: e.target.value })}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Product SKU</label>
            <input
              value={form.default_product_batch}
              onChange={(e) => setForm({ ...form, default_product_batch: e.target.value })}
              placeholder="Product SKU (e.g. QUACKTEOW)"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              What you sell, PAR, and FIFO against. Each completed run gets a unique lot like SKU-YYMMDD-0007.
              Changing SKU only affects <span className="font-medium">new</span> lots — already-inked codes stay as printed.
            </p>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Shelf life (days)</label>
            <input
              type="number"
              min="0"
              step="1"
              value={form.shelf_life_days}
              onChange={(e) => setForm({ ...form, shelf_life_days: e.target.value })}
              placeholder="e.g. 7"
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <p className="mt-1 text-xs text-gray-500">
              Days from production date to EXP on the lot label. Also powers “Lots expiring soon” on Overview. Saving
              fills expiry on lots that still have none.
            </p>
          </div>
        </div>

        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-gray-900">Ingredients (per batch)</h3>
            <button onClick={addLine} className="inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-800">
              <Plus size={14} /> Add Ingredient
            </button>
          </div>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-700">Raw Material</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-700">Qty Required</th>
                  <th className="w-8 px-2 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {lines.map((line, i) => (
                  <tr key={i}>
                    <td className="px-3 py-2">
                      <select value={line.raw_material_id} onChange={(e) => updateLine(i, 'raw_material_id', e.target.value)}
                        className="w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none">
                        <option value="">Select material…</option>
                        {materials.map((m) => <option key={m.id} value={m.id}>{m.name} ({m.unit_of_measure})</option>)}
                      </select>
                    </td>
                    <td className="px-3 py-2">
                      <input type="number" min="0" step="0.001" value={line.quantity_required} onChange={(e) => updateLine(i, 'quantity_required', e.target.value)}
                        className="w-24 rounded border border-gray-300 px-2 py-1.5 text-right text-sm focus:border-blue-500 focus:outline-none" />
                    </td>
                    <td className="px-2 py-2">
                      <button onClick={() => removeLine(i)} className="text-gray-300 hover:text-red-500 transition-colors"><Trash2 size={14} /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
          {saving ? 'Saving…' : 'Save Recipe'}
        </button>
      </div>
    </Modal>
  );
}

// ---- New Production Run Modal ----
interface RunMaterial { raw_material_id: string; quantity_consumed: string; required: number; material_name: string; unit: string; available_qty?: number; }

function parseRunSequence(runNumber: string): number | null {
  const m = /^RUN-(\d+)$/i.exec(String(runNumber).trim());
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return Number.isFinite(n) ? n : null;
}

/** Next RUN-nnnn based on current rows (numeric suffix only). */
function nextRunNumber(existing: string[]): string {
  const nums = existing.map(parseRunSequence).filter((n): n is number => n !== null);
  const max = nums.length > 0 ? Math.max(...nums) : 0;
  return `RUN-${String(max + 1).padStart(4, '0')}`;
}

async function allocateNextRunNumber(): Promise<string> {
  const { data, error } = await supabase.rpc('next_production_run_number');
  if (!error && typeof data === 'string') return data;

  const { data: rows, error: selErr } = await supabase.from('production_runs').select('run_number');
  if (selErr) throw selErr;
  return nextRunNumber((rows ?? []).map((r) => r.run_number));
}

type RecipeWithIngredients = Recipe & { ingredients?: (RecipeIngredient & { material?: RawMaterial })[] };

function NewRunModal({
  recipes,
  onClose,
  onSave,
  profile,
  initialRecipeId,
  initialPlannedOutput,
  plannedBatchId,
}: {
  recipes: RecipeWithIngredients[];
  onClose: () => void;
  onSave: () => void;
  profile: { role: 'admin' | 'staff' | 'pending' | 'supervisor' } | null;
  initialRecipeId?: string;
  initialPlannedOutput?: number;
  plannedBatchId?: string | null;
}) {
  const [recipe_id, setRecipeId] = useState(initialRecipeId ?? '');
  const [production_date, setDate] = useState(new Date().toISOString().split('T')[0]);
  const [planned_output, setPlanned] = useState(
    initialPlannedOutput != null ? String(initialPlannedOutput) : ''
  );
  const [actual_output, setActual] = useState('');
  const [notes, setNotes] = useState('');
  const [runMaterials, setRunMaterials] = useState<RunMaterial[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [printLabel, setPrintLabel] = useState<FinishedGoodsLotLabelData | null>(null);

  useEffect(() => {
    if (initialRecipeId) void selectRecipe(initialRecipeId);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot prefill from planning
  }, []);

  async function selectRecipe(id: string) {
    setRecipeId(id);
    const recipe = recipes.find((r) => r.id === id);
    if (!recipe) {
      setRunMaterials([]);
      setPlanned('');
      return;
    }

    const standardBatch = recipe.standard_batch_size;
    setPlanned(standardBatch.toString());

    // Fetch available quantities for raw materials
    const materialIds = (recipe.ingredients ?? []).map((ing) => ing.raw_material_id);
    const { data: inventoryData, error: invError } = await supabase
      .from('hub_inventory')
      .select('raw_material_id, quantity_on_hand')
      .in('raw_material_id', materialIds);

    if (invError) {
      console.error('Error fetching inventory:', invError);
      setError('Failed to load raw material inventory. Please try again.');
      return;
    }

    const availableQuantities = new Map(
      (inventoryData ?? []).map((item) => [item.raw_material_id, item.quantity_on_hand])
    );

    setRunMaterials(
      (recipe.ingredients ?? []).map((ing) => ({
        raw_material_id: ing.raw_material_id,
        quantity_consumed: ing.quantity_required.toString(),
        required: ing.quantity_required, // Base requirement for 1 batch
        material_name: ing.material?.name ?? '—',
        unit: ing.material?.unit_of_measure ?? '',
        available_qty: availableQuantities.get(ing.raw_material_id) ?? 0,
      }))
    );
  }

  function updatePlannedOutput(val: string) {
    setPlanned(val);
    const newPlanned = parseFloat(val);
    const recipe = recipes.find((r) => r.id === recipe_id);

    if (recipe && !isNaN(newPlanned) && recipe.standard_batch_size > 0) {
      // Scale required quantities based on the new planned output
      const ratio = newPlanned / recipe.standard_batch_size;
      const next = runMaterials.map((m) => {
        const recipeIng = recipe.ingredients?.find((i) => i.raw_material_id === m.raw_material_id);
        const scaledReq = recipeIng ? recipeIng.quantity_required * ratio : m.required;
        return {
          ...m,
          required: scaledReq,
          quantity_consumed: scaledReq.toFixed(3),
        };
      });
      setRunMaterials(next);
    }
  }

  function adjustToStock() {
    const recipe = recipes.find((r) => r.id === recipe_id);
    if (!recipe || !recipe.ingredients || recipe.ingredients.length === 0) return;

    // Find the ingredient that limits production the most (the bottleneck)
    let minRatio = Infinity;

    runMaterials.forEach((m) => {
      const recipeIng = recipe.ingredients?.find((i) => i.raw_material_id === m.raw_material_id);
      if (recipeIng && recipeIng.quantity_required > 0) {
        const available = m.available_qty ?? 0;
        const ratio = available / recipeIng.quantity_required;
        if (ratio < minRatio) minRatio = ratio;
      }
    });

    if (minRatio === Infinity) return;

    // Calculate new planned output based on the bottleneck ratio
    const maxPlanned = recipe.standard_batch_size * minRatio;
    updatePlannedOutput(maxPlanned.toFixed(2));
  }

  async function handleSave() {
    if (!recipe_id) { setError('Select a recipe'); return; }
    if (!actual_output || parseFloat(actual_output) < 0) { setError('Enter actual output'); return; }

    // Validate sufficient stock
    for (const m of runMaterials) {
      const used = parseFloat(m.quantity_consumed) || 0;
      const available = m.available_qty ?? 0;
      if (used > available) {
        setError(`Insufficient stock for ${m.material_name}. Available: ${available} ${m.unit}, but tried to use ${used} ${m.unit}.`);
        return;
      }
    }

    setSaving(true);
    try {
      const plannedOutput = parseFloat(planned_output) || 0;
      const actualOutputQty = parseFloat(actual_output);

      let run: {
        id: string;
        run_number: string;
        recipe_id: string;
        production_date: string;
        planned_output: number;
        actual_output: number;
        status: string;
        notes: string | null;
      } | null = null;
      let run_number = '';

      const maxAttempts = 12;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        run_number = await allocateNextRunNumber();

        const { data: created, error: runErr } = await supabase
          .from('production_runs')
          .insert({
            run_number,
            recipe_id,
            production_date,
            planned_output: plannedOutput,
            actual_output: actualOutputQty,
            status: 'in_progress',
            notes: notes || null,
            ...(plannedBatchId ? { planned_batch_id: plannedBatchId } : {}),
          })
          .select()
          .single();

        if (!runErr && created) {
          run = created;
          break;
        }

        const msg = runErr?.message ?? '';
        const dup =
          runErr?.code === '23505' ||
          msg.includes('production_runs_run_number_key') ||
          msg.includes('duplicate key');

        if (!dup) {
          setError(runErr?.message ?? 'Failed to create production run');
          setSaving(false);
          return;
        }
      }

      if (!run) {
        setError('Could not allocate a unique run number. Please try again.');
        setSaving(false);
        return;
      }
      if (runMaterials.length > 0) {
        await supabase.from('production_run_materials').insert(
          runMaterials.map((m) => ({
            production_run_id: run.id,
            raw_material_id: m.raw_material_id,
            quantity_consumed: parseFloat(m.quantity_consumed) || 0,
          }))
        );
      }

      // Get recipe for QC evaluation
      const selectedRecipe = recipes.find((r) => r.id === recipe_id);
      const targetYield = selectedRecipe?.target_yield_percentage || 100;

      // Evaluate QC using productionService
      const result = await completeProductionRun({
        productionRunId: run.id,
        recipeId: recipe_id,
        plannedOutput,
        actualOutput: actualOutputQty,
        targetYield,
        productBatch: selectedRecipe?.default_product_batch?.trim() || undefined,
        isAdmin: profile?.role === 'admin',
      });

      if (!result.success) {
        // Abandon the draft. Inventory post is atomic; this must not leave hub FG behind.
        await supabase
          .from('production_runs')
          .update({ status: 'cancelled' })
          .eq('id', run.id);

        const qcRejected = result.qcReport?.qcResult.passed === false;
        setError(
          qcRejected
            ? `QC Evaluation Failed: ${result.error}`
            : result.message || result.error || 'Production completion failed'
        );
        setSaving(false);
        return;
      }

      if (result.qcReport?.actions.requiresApproval && !result.inventoryPosted) {
        setError('Production completed but requires admin QC approval before inventory posting. Current status: QC Review');
        setSaving(false);
        onSave();
        return;
      }

      await logActivity({
        action: 'completed',
        entityType: 'production_run',
        entityId: run.id,
        entityLabel: result.lotLabel || run_number,
        details: {
          yield_percentage: result.qcReport?.qcResult.yieldPercentage,
          actual_output: actualOutputQty,
          qc_status: result.qcReport?.qcResult.status,
          inventory_posted: result.inventoryPosted,
          lot_label: result.lotLabel,
          sku: result.sku,
        },
      });

      setSaving(false);
      if (result.inventoryPosted && result.lotLabel) {
        setPrintLabel({
          productName: selectedRecipe?.name ?? 'Finished goods',
          lotLabel: result.lotLabel,
          sku: result.sku || selectedRecipe?.default_product_batch || 'FG',
          runNumber: result.runNumber || run_number,
          manufacturedAt: result.manufacturedAt ?? production_date,
          expiryDate: result.expiryDate ?? null,
          quantity: result.finishedQuantity ?? actualOutputQty,
          unit: selectedRecipe?.batch_unit ?? null,
        });
        return;
      }
      onSave();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete production run');
      setSaving(false);
    }
  }

  const selectedRecipe = recipes.find((r) => r.id === recipe_id);

  if (printLabel) {
    return (
      <Modal isOpen onClose={() => onSave()} title="Print finished-goods label" size="md">
        <FinishedGoodsLotLabel data={printLabel} onDone={() => onSave()} doneLabel="Close" />
      </Modal>
    );
  }

  return (
    <Modal isOpen onClose={onClose} title="New Production Run" size="xl">
      {error && (
        <div className="mb-4 flex items-start gap-3 rounded-lg bg-red-50 p-3">
          <AlertCircle size={18} className="mt-0.5 flex-shrink-0 text-red-600" />
          <div>
            <p className="text-sm font-medium text-red-900">Error</p>
            <p className="text-sm text-red-700">{error}</p>
          </div>
        </div>
      )}
      <div className="space-y-5">
        <div className="grid gap-4 grid-cols-1 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="mb-1 block text-sm font-medium text-gray-700">Recipe *</label>
            <select value={recipe_id} onChange={(e) => selectRecipe(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500">
              <option value="">Select recipe…</option>
              {recipes.map((r) => <option key={r.id} value={r.id}>{r.name} (batch: {r.standard_batch_size} {r.batch_unit})</option>)}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Production Date</label>
            <input type="date" value={production_date} onChange={(e) => setDate(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Notes</label>
            <input value={notes} onChange={(e) => setNotes(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <div className="mb-1 flex items-center justify-between">
              <label className="text-sm font-medium text-gray-700">Planned Output ({selectedRecipe?.batch_unit ?? 'units'})</label>
              {recipe_id && (
                <button
                  onClick={adjustToStock}
                  className="text-xs font-medium text-blue-600 hover:text-blue-800 transition-colors"
                  title="Adjust planned output based on available raw materials"
                >
                  Scale to Stock
                </button>
              )}
            </div>
            <input type="number" min="0" step="0.01" value={planned_output} onChange={(e) => updatePlannedOutput(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
          <div>
            <label className="mb-1 block text-sm font-medium text-gray-700">Actual Output ({selectedRecipe?.batch_unit ?? 'units'})</label>
            <input type="number" min="0" step="0.01" value={actual_output} onChange={(e) => setActual(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500" />
          </div>
        </div>

        {selectedRecipe && (
          <p className="rounded-lg border border-emerald-100 bg-emerald-50/70 px-3 py-2 text-xs text-emerald-900">
            After complete, print this lot on packs:{' '}
            <span className="font-mono font-semibold">
              {(selectedRecipe.default_product_batch || selectedRecipe.name || 'FG')
                .toUpperCase()
                .replace(/[^A-Z0-9]+/g, '-')
                .replace(/^-|-$/g, '')}
              -{production_date.replace(/-/g, '').slice(2)}-####
            </span>
            <span className="text-emerald-800"> (#### is the run number, e.g. 0007)</span>
          </p>
        )}

        {planned_output && actual_output && (
          <div className="rounded-lg bg-emerald-50 px-4 py-3 text-sm">
            {(() => {
              const planned = parseFloat(planned_output) || 0;
              const actual = parseFloat(actual_output) || 0;
              const yieldPct = planned > 0 ? (actual / planned) * 100 : 0;
              const variants = planned - actual;
              return (
                <>
                  Yield: <strong>{yieldPct.toFixed(1)}%</strong>
                  {selectedRecipe?.target_yield_percentage && (
                    <span className="text-gray-500"> · Target: {selectedRecipe.target_yield_percentage}%</span>
                  )}
                  <span className="text-gray-500">
                    {' '}· Variants (Planned - Actual):{' '}
                    <strong className="text-gray-800">
                      {variants > 0 ? '+' : ''}
                      {variants.toFixed(2)} {selectedRecipe?.batch_unit ?? 'units'}
                    </strong>
                  </span>
                </>
              );
            })()}
          </div>
        )}

        {runMaterials.length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Material Consumption</h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-700">Material</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Required</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Available</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-700">Actual Used</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {runMaterials.map((m, i) => {
                    const hasEnoughStock = (m.available_qty ?? 0) >= m.required;
                    return (
                    <tr key={i}>
                      <td className="px-3 py-2 font-medium text-gray-900">
                        <span className={`inline-block h-2 w-2 rounded-full mr-2 ${hasEnoughStock ? 'bg-emerald-500' : 'bg-red-500'}`} title={hasEnoughStock ? 'Stock available' : 'Insufficient stock'} />
                        {m.material_name}<span className="ml-1 text-xs text-gray-400">({m.unit})</span>
                      </td>
                      <td className="px-3 py-2 text-right text-gray-500">{m.required.toFixed(2)}</td>
                      <td className="px-3 py-2 text-right">
                        <span className={hasEnoughStock ? 'text-gray-500' : 'font-medium text-red-600'}>
                          {m.available_qty?.toFixed(2)}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input type="number" min="0" step="0.001" value={m.quantity_consumed}
                          onChange={(e) => {
                            const next = [...runMaterials]; next[i] = { ...next[i], quantity_consumed: e.target.value }; setRunMaterials(next);
                          }}
                          className="w-24 rounded border border-gray-300 px-2 py-1 text-right text-sm focus:border-blue-500 focus:outline-none" />
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      <div className="mt-6 flex justify-end gap-3">
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Cancel</button>
        <button onClick={handleSave} disabled={saving} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 disabled:opacity-60 transition-colors">
          {saving ? 'Processing…' : 'Complete Run & Update Stock'}
        </button>
      </div>
    </Modal>
  );
}

// ---- Run Detail Modal ----
type FgLotEmbed = {
  product_batch_label: string;
  expiry_date: string | null;
  manufactured_at: string | null;
};

type RunWithDetails = ProductionRun & {
  recipe?: Recipe;
  materials?: { raw_material_id: string; quantity_consumed: number; material?: RawMaterial }[];
  fg_lot?: FgLotEmbed | FgLotEmbed[] | null;
};

function firstFgLot(run: RunWithDetails): FgLotEmbed | null {
  const lot = run.fg_lot;
  if (!lot) return null;
  return Array.isArray(lot) ? (lot[0] ?? null) : lot;
}

function RunDetailModal({
  run,
  isAdmin,
  onClose,
  onVoid,
  onRestore,
  onDelete,
}: {
  run: RunWithDetails;
  isAdmin: boolean;
  onClose: () => void;
  onVoid: () => void;
  onRestore: () => void;
  onDelete: () => void;
}) {
  const variants = run.planned_output - run.actual_output;
  const yieldPct = effectiveRunYieldPct(run);
  const lot = firstFgLot(run);
  const [showLabel, setShowLabel] = useState(false);

  return (
    <Modal isOpen onClose={onClose} title={`Production Run: ${run.run_number}`} size="lg">
      {showLabel && lot ? (
        <FinishedGoodsLotLabel
          data={{
            productName: run.recipe?.name ?? 'Finished goods',
            lotLabel: lot.product_batch_label,
            sku: run.recipe?.default_product_batch || lot.product_batch_label.split('-').slice(0, -2).join('-') || 'FG',
            runNumber: run.run_number,
            manufacturedAt: lot.manufactured_at ?? run.production_date,
            expiryDate: lot.expiry_date,
            quantity: run.actual_output,
            unit: run.recipe?.batch_unit ?? null,
          }}
          onDone={() => setShowLabel(false)}
          doneLabel="Back"
        />
      ) : (
      <div className="space-y-5">
        <div className="grid gap-4 rounded-lg bg-gray-50 p-4 grid-cols-1 sm:grid-cols-2">
          <div><p className="text-xs text-gray-500">Recipe</p><p className="font-semibold text-gray-900">{run.recipe?.name ?? '—'}</p></div>
          <div><p className="text-xs text-gray-500">Status</p><StatusBadge status={run.status} /></div>
          {run.status === 'voided' && (
            <div className="sm:col-span-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600">
              This run is voided. Hub finished goods were reversed. Restore to put the lot back into hub stock.
            </div>
          )}
          <div><p className="text-xs text-gray-500">Date</p><p className="font-semibold text-gray-900">{new Date(run.production_date).toLocaleDateString()}</p></div>
          <div><p className="text-xs text-gray-500">Planned Output</p><p className="font-semibold text-gray-900">{run.planned_output} {run.recipe?.batch_unit}</p></div>
          <div><p className="text-xs text-gray-500">Actual Output</p><p className="font-semibold text-gray-900">{run.actual_output} {run.recipe?.batch_unit}</p></div>
          <div>
            <p className="text-xs text-gray-500">Variants (Planned - Actual)</p>
            <p className="font-semibold text-gray-900">
              {variants > 0 ? '+' : ''}
              {variants.toFixed(2)} {run.recipe?.batch_unit}
            </p>
          </div>
          <div><p className="text-xs text-gray-500">Yield</p>{yieldPct != null ? <YieldBar value={yieldPct} /> : <p className="text-gray-400">—</p>}</div>
          {run.notes && <div className="sm:col-span-2"><p className="text-xs text-gray-500">Notes</p><p className="text-sm text-gray-900">{run.notes}</p></div>}
          {lot && (
            <div className="sm:col-span-2">
              <p className="text-xs text-gray-500">Printable lot</p>
              <p className="font-mono text-sm font-semibold text-gray-900">{lot.product_batch_label}</p>
              <p className="mt-0.5 text-xs text-gray-500">
                EXP {lot.expiry_date ?? '—'} · ink-label packs with this code
              </p>
            </div>
          )}
        </div>
        {(run.materials ?? []).length > 0 && (
          <div>
            <h3 className="mb-2 text-sm font-semibold text-gray-900">Material Usage</h3>
            <div className="overflow-x-auto rounded-lg border border-gray-200">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 py-2 text-left font-semibold text-gray-700">Material</th>
                    <th className="px-4 py-2 text-right font-semibold text-gray-700">Consumed</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {run.materials?.map((m) => (
                    <tr key={m.raw_material_id}>
                      <td className="px-4 py-2 font-medium text-gray-900">{m.material?.name ?? '—'}</td>
                      <td className="px-4 py-2 text-right text-gray-700">{m.quantity_consumed} {m.material?.unit_of_measure}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
      )}
      <div className="mt-6 flex flex-wrap items-center justify-end gap-2">
        {isAdmin && run.status === 'completed' && (
          <button
            type="button"
            onClick={onVoid}
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-sm font-medium text-amber-800 hover:bg-amber-100"
          >
            <Ban size={15} /> Void run
          </button>
        )}
        {isAdmin && run.status === 'voided' && (
          <button
            type="button"
            onClick={onRestore}
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-medium text-emerald-800 hover:bg-emerald-100"
          >
            <RotateCcw size={15} /> Restore run
          </button>
        )}
        {isAdmin && (run.status === 'in_progress' || run.status === 'cancelled') && (
          <button
            type="button"
            onClick={onDelete}
            className="mr-auto inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-4 py-2 text-sm font-medium text-red-700 hover:bg-red-100"
          >
            <Trash2 size={15} /> Delete draft
          </button>
        )}
        {lot && !showLabel && (
          <button
            type="button"
            onClick={() => setShowLabel(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700"
          >
            <Printer size={15} /> Print label
          </button>
        )}
        <button onClick={onClose} className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors">Close</button>
      </div>
    </Modal>
  );
}

// ---- Main Production Page ----
export function Production() {
  const { profile, isAdmin } = useAuth();
  const [tab, setTab] = useState<Tab>('runs');
  const [runs, setRuns] = useState<RunWithDetails[]>([]);
  const [recipes, setRecipes] = useState<RecipeWithIngredients[]>([]);
  const [materials, setMaterials] = useState<RawMaterial[]>([]);
  const [loading, setLoading] = useState(true);

  const [showNewRun, setShowNewRun] = useState(false);
  const [viewRun, setViewRun] = useState<RunWithDetails | null>(null);
  const [editRecipe, setEditRecipe] = useState<Recipe | null>(null);
  const [editIngredients, setEditIngredients] = useState<RecipeIngredient[]>([]);
  const [showRecipeModal, setShowRecipeModal] = useState(false);
  const [dateRange, setDateRange] = useState<DateRange | null>(null);
  const [runAction, setRunAction] = useState<{
    kind: 'void' | 'restore' | 'delete';
    run: RunWithDetails;
  } | null>(null);
  const [confirmText, setConfirmText] = useState('');
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [planPrefill, setPlanPrefill] = useState<{
    recipeId: string;
    quantity: number;
    plannedBatchId: string;
  } | null>(null);

  const handleDateFilterChange = (range: DateRange | null) => {
    setDateRange(range);
  };

  const filteredRuns = dateRange
    ? runs.filter((run) => isDateInRange(run.production_date, dateRange))
    : runs;

  async function loadAll() {
    setLoading(true);
    const [{ data: r }, { data: rec }, { data: mats }] = await Promise.all([
      supabase
        .from('production_runs')
        .select(`*, recipe:recipe_id(*), materials:production_run_materials(*, material:raw_material_id(*)), fg_lot:inventory_lots!production_run_id(product_batch_label, expiry_date, manufactured_at)`)
        .order('created_at', { ascending: false }),
      supabase
        .from('recipes')
        .select(`*, ingredients:recipe_ingredients(*, material:raw_material_id(*))`)
        .order('name'),
      supabase.from('raw_materials').select('*').order('name'),
    ]);
    setRuns(r as RunWithDetails[] ?? []);
    setRecipes(rec as RecipeWithIngredients[] ?? []);
    setMaterials(mats ?? []);
    setLoading(false);
  }

  useEffect(() => { loadAll(); }, []);

  async function deleteRecipe(id: string) {
    if (!confirm('Delete this recipe?')) return;
    const r = recipes.find((x) => x.id === id);
    await supabase.from('recipes').delete().eq('id', id);
    await logActivity({ action: 'deleted', entityType: 'recipe', entityId: id, entityLabel: r?.name ?? id });
    loadAll();
  }

  function openRunAction(kind: 'void' | 'restore' | 'delete', run: RunWithDetails) {
    if (!isAdmin) return;
    setRunAction({ kind, run });
    setConfirmText('');
    setActionError(null);
  }

  async function submitRunAction() {
    if (!isAdmin || !runAction) return;
    const expected = runAction.run.run_number.trim();
    const lotCode = firstFgLot(runAction.run)?.product_batch_label?.trim() ?? '';
    const typed = confirmText.trim();
    if (!voidConfirmMatches(typed, expected, lotCode || null)) {
      setActionError(`Type ${expected}${lotCode ? ` or ${lotCode}` : ''} to confirm`);
      return;
    }

    setActionBusy(true);
    setActionError(null);
    const result =
      runAction.kind === 'void'
        ? await voidProductionRun({ runId: runAction.run.id, confirmText: typed })
        : runAction.kind === 'restore'
          ? await restoreVoidedProductionRun({ runId: runAction.run.id, confirmText: typed })
          : await deleteProductionRun({ runId: runAction.run.id });
    setActionBusy(false);

    if (!result.success) {
      setActionError(result.error ?? 'Action failed');
      return;
    }

    if (viewRun?.id === runAction.run.id) {
      if (runAction.kind === 'delete') {
        setViewRun(null);
      } else {
        setViewRun({
          ...viewRun,
          status: runAction.kind === 'void' ? 'voided' : 'completed',
        });
      }
    }
    setRunAction(null);
    setConfirmText('');
    await loadAll();
  }

  function openEditRecipe(recipe: RecipeWithIngredients) {
    setEditRecipe(recipe);
    setEditIngredients(recipe.ingredients ?? []);
    setShowRecipeModal(true);
  }

  const tabClass = (t: Tab) =>
    `border-b-2 px-1 py-4 text-sm font-medium transition-colors ${
      tab === t ? 'border-emerald-600 text-emerald-600' : 'border-transparent text-gray-500 hover:text-gray-700'
    }`;

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Production</h1>
          <p className="mt-1 text-sm text-gray-500">Manage recipes and production runs with yield tracking</p>
          {isAdmin && (
            <Link
              to="/settings?section=qc"
              className="mt-2 inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 transition-colors"
            >
              <Shield size={14} className="text-indigo-600" aria-hidden />
              QC audit parameters
            </Link>
          )}
        </div>
        {tab === 'runs' && (
          <button onClick={() => setShowNewRun(true)}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors">
            <Plus size={16} /> New Run
          </button>
        )}
        {tab === 'recipes' && (
          <button onClick={() => { setEditRecipe(null); setEditIngredients([]); setShowRecipeModal(true); }}
            className="inline-flex items-center gap-2 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-700 transition-colors">
            <Plus size={16} /> New Recipe
          </button>
        )}
      </div>

      <div className="border-b border-gray-200">
        <nav className="mb-4 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
          <div className="flex gap-6">
            <button className={tabClass('runs')} onClick={() => setTab('runs')}>Production Runs</button>
            <button className={tabClass('recipes')} onClick={() => setTab('recipes')}>Recipes</button>
            <button className={tabClass('planning')} onClick={() => setTab('planning')}>Planning</button>
          </div>
          {tab === 'runs' && (
            <DateFilter
              onFilterChange={handleDateFilterChange}
              hint="Filters production runs by production date."
            />
          )}
        </nav>
      </div>

      {loading ? (
        <div className="flex h-48 items-center justify-center text-gray-400 text-sm">Loading…</div>
      ) : (
        <>
          {tab === 'planning' && (
            <ProductionPlanningPanel
              onStartRun={(opts) => {
                setPlanPrefill(opts);
                setShowNewRun(true);
              }}
            />
          )}
          {tab === 'runs' && (
            <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
              <table className="w-full text-sm">
                <thead className="border-b border-gray-200 bg-gray-50">
                  <tr>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Run #</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Lot</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Recipe</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Date</th>
                    <th className="hidden sm:table-cell px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Planned</th>
                    <th className="px-4 md:px-6 py-3 text-right font-semibold text-gray-700">Actual</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Variants</th>
                    <th className="hidden md:table-cell px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Yield</th>
                    <th className="px-4 md:px-6 py-3 text-left font-semibold text-gray-700">Status</th>
                    <th className="w-16 px-4 md:px-6 py-3" />
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {runs.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-6 py-12 text-center">
                        <FlaskConical className="mx-auto mb-3 text-gray-300" size={40} />
                        <p className="text-gray-400">No production runs yet</p>
                      </td>
                    </tr>
                  ) : filteredRuns.length === 0 ? (
                    <tr>
                      <td colSpan={10} className="px-6 py-12 text-center">
                        <p className="text-gray-500">No runs match this date range.</p>
                        <p className="mt-1 text-sm text-gray-400">Try All time or adjust the filter.</p>
                      </td>
                    </tr>
                  ) : (
                    filteredRuns.map((run) => {
                      const yieldPct = effectiveRunYieldPct(run);
                      return (
                      <tr key={run.id} className="hover:bg-gray-50 transition-colors">
                        <td className="px-4 md:px-6 py-4 font-medium text-gray-900 text-xs sm:text-sm">{run.run_number}</td>
                        <td className="px-4 md:px-6 py-4 font-mono text-xs text-gray-800">
                          {firstFgLot(run)?.product_batch_label ?? '—'}
                        </td>
                        <td className="px-4 md:px-6 py-4 text-gray-700 text-xs sm:text-sm">{run.recipe?.name ?? '—'}</td>
                        <td className="px-4 md:px-6 py-4 text-gray-500 text-xs sm:text-sm">{new Date(run.production_date).toLocaleDateString()}</td>
                        <td className="hidden sm:table-cell px-4 md:px-6 py-4 text-right text-gray-700 text-xs">{run.planned_output}</td>
                        <td className="px-4 md:px-6 py-4 text-right font-medium text-gray-900 text-xs sm:text-sm">{run.actual_output}</td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4">
                          <VariantsBadge planned={run.planned_output} actual={run.actual_output} />
                        </td>
                        <td className="hidden md:table-cell px-4 md:px-6 py-4">{yieldPct != null ? <YieldBar value={yieldPct} /> : <span className="text-gray-400">—</span>}</td>
                        <td className="px-4 md:px-6 py-4"><StatusBadge status={run.status} /></td>
                        <td className="px-4 md:px-6 py-4">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              onClick={() => setViewRun(run)}
                              className="inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-800"
                            >
                              Manage <ChevronRight size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                    })
                  )}
                </tbody>
              </table>
            </div>
          )}

          {tab === 'recipes' && (
            <div className="grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
              {recipes.length === 0 ? (
                <div className="sm:col-span-3 rounded-xl border-2 border-dashed border-gray-200 px-6 py-12 text-center text-gray-400">No recipes yet</div>
              ) : (
                recipes.map((recipe) => (
                  <div key={recipe.id} className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm hover:border-emerald-200 transition-all">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-semibold text-gray-900">{recipe.name}</h3>
                        <p className="mt-0.5 text-xs text-gray-500">Batch: {recipe.standard_batch_size} {recipe.batch_unit}</p>
                      </div>
                      <div className="flex gap-1">
                        <button onClick={() => openEditRecipe(recipe)} className="text-gray-400 hover:text-blue-600 transition-colors p-1"><Edit2 size={15} /></button>
                        <button onClick={() => deleteRecipe(recipe.id)} className="text-gray-400 hover:text-red-600 transition-colors p-1"><Trash2 size={15} /></button>
                      </div>
                    </div>
                    {recipe.description && <p className="mt-2 text-xs text-gray-600 line-clamp-2">{recipe.description}</p>}
                    <div className="mt-3 space-y-1">
                      <p className="text-xs font-semibold text-gray-500">Ingredients ({(recipe.ingredients ?? []).length})</p>
                      {(recipe.ingredients ?? []).slice(0, 4).map((ing) => (
                        <div key={ing.id} className="flex items-center justify-between text-xs text-gray-700">
                          <span>{ing.material?.name ?? ing.raw_material_id}</span>
                          <span className="font-medium">{ing.quantity_required} {ing.material?.unit_of_measure}</span>
                        </div>
                      ))}
                      {(recipe.ingredients ?? []).length > 4 && (
                        <p className="text-xs text-gray-400">+{(recipe.ingredients ?? []).length - 4} more…</p>
                      )}
                    </div>
                    <div className="mt-3 flex items-center justify-between border-t border-gray-100 pt-3">
                      <span className="text-xs text-gray-500">Target yield</span>
                      <span className="text-sm font-bold text-emerald-600">{recipe.target_yield_percentage ?? 100}%</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {showNewRun && (
        <NewRunModal
          recipes={recipes}
          onClose={() => {
            setShowNewRun(false);
            setPlanPrefill(null);
          }}
          onSave={() => {
            setShowNewRun(false);
            setPlanPrefill(null);
            loadAll();
          }}
          profile={profile}
          initialRecipeId={planPrefill?.recipeId}
          initialPlannedOutput={planPrefill?.quantity}
          plannedBatchId={planPrefill?.plannedBatchId}
        />
      )}
      {viewRun && (
        <RunDetailModal
          run={viewRun}
          isAdmin={isAdmin}
          onClose={() => setViewRun(null)}
          onVoid={() => openRunAction('void', viewRun)}
          onRestore={() => openRunAction('restore', viewRun)}
          onDelete={() => openRunAction('delete', viewRun)}
        />
      )}
      {runAction && (
        <Modal
          isOpen
          onClose={() => {
            if (actionBusy) return;
            setRunAction(null);
            setConfirmText('');
            setActionError(null);
          }}
          title={
            runAction.kind === 'void'
              ? `Void ${runAction.run.run_number}`
              : runAction.kind === 'restore'
                ? `Restore ${runAction.run.run_number}`
                : `Delete ${runAction.run.run_number}`
          }
          size="sm"
        >
          <div className="space-y-4">
            <p className="text-sm text-gray-700">
              {runAction.kind === 'void'
                ? 'This removes hub finished goods if they are still at the hub and puts consumed raw materials back. The run and lot stay on record so you can restore later. Blocked if the lot already left the hub.'
                : runAction.kind === 'restore'
                  ? 'This puts hub finished goods back and re-consumes the raw materials recorded on this run.'
                  : 'This permanently deletes the draft run. Completed batches cannot be deleted this way.'}
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-gray-600">
                Type {runAction.run.run_number}
                {firstFgLot(runAction.run)?.product_batch_label
                  ? ` or ${firstFgLot(runAction.run)?.product_batch_label}`
                  : ''}{' '}
                to confirm
              </span>
              <input
                autoFocus
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm font-mono"
                placeholder={runAction.run.run_number}
              />
            </label>
            {actionError && <p className="text-sm text-red-600">{actionError}</p>}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                disabled={actionBusy}
                onClick={() => {
                  setRunAction(null);
                  setConfirmText('');
                  setActionError(null);
                }}
                className="rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={actionBusy || !confirmText.trim()}
                onClick={() => void submitRunAction()}
                className={`rounded-lg px-4 py-2 text-sm font-medium text-white disabled:opacity-60 ${
                  runAction.kind === 'restore'
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : runAction.kind === 'void'
                      ? 'bg-amber-600 hover:bg-amber-700'
                      : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {actionBusy
                  ? 'Working…'
                  : runAction.kind === 'void'
                    ? 'Void run'
                    : runAction.kind === 'restore'
                      ? 'Restore run'
                      : 'Delete draft'}
              </button>
            </div>
          </div>
        </Modal>
      )}
      {showRecipeModal && (
        <RecipeModal
          recipe={editRecipe}
          ingredients={editIngredients}
          materials={materials}
          onClose={() => setShowRecipeModal(false)}
          onSave={() => { setShowRecipeModal(false); loadAll(); }}
        />
      )}
    </div>
  );
}
