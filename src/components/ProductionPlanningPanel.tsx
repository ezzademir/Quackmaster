import { useCallback, useEffect, useState } from 'react';
import { supabase } from '../utils/supabase';
import { useAuth } from '../utils/auth';

interface Resource {
  id: string;
  name: string;
  daily_capacity_units: number;
  notes: string | null;
}

interface PlannedBatch {
  id: string;
  recipe_id: string;
  resource_id: string | null;
  planned_start: string;
  planned_quantity: number;
  status: string;
  notes: string | null;
  recipe?: { name: string } | null;
  resource?: { name: string } | null;
}

interface RecipeOpt {
  id: string;
  name: string;
}

interface Props {
  onStartRun?: (opts: { recipeId: string; quantity: number; plannedBatchId: string }) => void;
}

export function ProductionPlanningPanel({ onStartRun }: Props) {
  const { isAdmin } = useAuth();
  const [resources, setResources] = useState<Resource[]>([]);
  const [batches, setBatches] = useState<PlannedBatch[]>([]);
  const [recipes, setRecipes] = useState<RecipeOpt[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<string | null>(null);

  const [resName, setResName] = useState('');
  const [resCap, setResCap] = useState('100');
  const [pbRecipe, setPbRecipe] = useState('');
  const [pbResource, setPbResource] = useState('');
  const [pbQty, setPbQty] = useState('100');
  const [pbStart, setPbStart] = useState(() => new Date().toISOString().slice(0, 16));

  const load = useCallback(async () => {
    setLoading(true);
    const [{ data: res }, { data: pb }, { data: rec }] = await Promise.all([
      supabase.from('production_resources').select('*').order('name'),
      supabase
        .from('planned_batches')
        .select('*, recipe:recipe_id(name), resource:resource_id(name)')
        .order('planned_start', { ascending: true }),
      supabase.from('recipes').select('id, name').order('name'),
    ]);
    setResources((res ?? []) as Resource[]);
    setBatches((pb ?? []) as PlannedBatch[]);
    setRecipes((rec ?? []) as RecipeOpt[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function addResource() {
    if (!isAdmin) return;
    const cap = parseFloat(resCap);
    if (!resName.trim() || !Number.isFinite(cap) || cap <= 0) {
      setMessage('Enter resource name and positive daily capacity.');
      return;
    }
    const { error } = await supabase.from('production_resources').insert({
      name: resName.trim(),
      daily_capacity_units: cap,
    });
    if (error) setMessage(error.message);
    else {
      setResName('');
      setMessage(null);
      void load();
    }
  }

  async function addBatch() {
    if (!isAdmin) return;
    const qty = parseFloat(pbQty);
    if (!pbRecipe || !Number.isFinite(qty) || qty <= 0) {
      setMessage('Select a recipe and positive quantity.');
      return;
    }
    const { error } = await supabase.from('planned_batches').insert({
      recipe_id: pbRecipe,
      resource_id: pbResource || null,
      planned_start: new Date(pbStart).toISOString(),
      planned_quantity: qty,
      status: 'draft',
    });
    if (error) setMessage(error.message);
    else {
      setMessage(null);
      void load();
    }
  }

  async function setStatus(id: string, status: string) {
    if (!isAdmin) return;
    const { error } = await supabase.from('planned_batches').update({ status, updated_at: new Date().toISOString() }).eq('id', id);
    if (error) setMessage(error.message);
    else void load();
  }

  if (loading) return <div className="py-8 text-center text-sm text-gray-400">Loading planning…</div>;

  return (
    <div className="space-y-6">
      {message && <p className="rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-900">{message}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">Production resources</h3>
          <ul className="mt-3 space-y-2 text-sm">
            {resources.length === 0 ? (
              <li className="text-gray-400">No resources yet.</li>
            ) : (
              resources.map((r) => (
                <li key={r.id} className="flex justify-between rounded-lg border border-gray-100 px-3 py-2">
                  <span className="font-medium text-gray-900">{r.name}</span>
                  <span className="tabular-nums text-gray-600">{r.daily_capacity_units}/day</span>
                </li>
              ))
            )}
          </ul>
          {isAdmin && (
            <div className="mt-4 flex flex-wrap gap-2">
              <input
                value={resName}
                onChange={(e) => setResName(e.target.value)}
                placeholder="Resource name"
                className="rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <input
                type="number"
                min={0}
                step="0.01"
                value={resCap}
                onChange={(e) => setResCap(e.target.value)}
                placeholder="Daily capacity"
                className="w-32 rounded-lg border border-gray-300 px-3 py-2 text-sm"
              />
              <button type="button" onClick={() => void addResource()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
                Add
              </button>
            </div>
          )}
        </div>

        <div className="rounded-xl border border-gray-200 bg-white p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-gray-900">Schedule planned batch</h3>
          {isAdmin ? (
            <div className="mt-3 grid gap-2">
              <select value={pbRecipe} onChange={(e) => setPbRecipe(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Recipe…</option>
                {recipes.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <select value={pbResource} onChange={(e) => setPbResource(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm">
                <option value="">Resource (optional)…</option>
                {resources.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
              <input type="datetime-local" value={pbStart} onChange={(e) => setPbStart(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <input type="number" min={0} step="0.01" value={pbQty} onChange={(e) => setPbQty(e.target.value)} className="rounded-lg border border-gray-300 px-3 py-2 text-sm" />
              <button type="button" onClick={() => void addBatch()} className="rounded-lg bg-emerald-600 px-3 py-2 text-sm font-medium text-white">
                Create draft plan
              </button>
            </div>
          ) : (
            <p className="mt-2 text-sm text-gray-500">Admin can create plans; staff can view and start released batches.</p>
          )}
        </div>
      </div>

      <div className="overflow-x-auto rounded-xl border border-gray-200 bg-white shadow-sm">
        <table className="w-full min-w-[640px] text-sm">
          <thead className="border-b bg-gray-50 text-left">
            <tr>
              <th className="px-4 py-2 font-semibold text-gray-700">When</th>
              <th className="px-4 py-2 font-semibold text-gray-700">Recipe</th>
              <th className="px-4 py-2 font-semibold text-gray-700">Resource</th>
              <th className="px-4 py-2 text-right font-semibold text-gray-700">Qty</th>
              <th className="px-4 py-2 font-semibold text-gray-700">Status</th>
              <th className="px-4 py-2 font-semibold text-gray-700">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {batches.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-gray-400">
                  No planned batches.
                </td>
              </tr>
            ) : (
              batches.map((b) => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-4 py-2 tabular-nums text-gray-700">{new Date(b.planned_start).toLocaleString()}</td>
                  <td className="px-4 py-2 font-medium text-gray-900">{b.recipe?.name ?? '—'}</td>
                  <td className="px-4 py-2 text-gray-600">{b.resource?.name ?? '—'}</td>
                  <td className="px-4 py-2 text-right tabular-nums">{b.planned_quantity}</td>
                  <td className="px-4 py-2 capitalize text-gray-700">{b.status}</td>
                  <td className="px-4 py-2">
                    <div className="flex flex-wrap gap-1">
                      {isAdmin && b.status === 'draft' && (
                        <button type="button" onClick={() => void setStatus(b.id, 'scheduled')} className="rounded border px-2 py-1 text-xs">
                          Schedule
                        </button>
                      )}
                      {isAdmin && b.status === 'scheduled' && (
                        <button type="button" onClick={() => void setStatus(b.id, 'released')} className="rounded border px-2 py-1 text-xs">
                          Release
                        </button>
                      )}
                      {b.status === 'released' && onStartRun && (
                        <button
                          type="button"
                          onClick={() =>
                            onStartRun({
                              recipeId: b.recipe_id,
                              quantity: Number(b.planned_quantity),
                              plannedBatchId: b.id,
                            })
                          }
                          className="rounded bg-emerald-600 px-2 py-1 text-xs font-medium text-white"
                        >
                          Start run
                        </button>
                      )}
                      {isAdmin && b.status !== 'cancelled' && (
                        <button type="button" onClick={() => void setStatus(b.id, 'cancelled')} className="rounded border px-2 py-1 text-xs text-red-700">
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
