/**
 * Audit A-09: production_run_materials must be saved before a run is completed,
 * otherwise the FG lot is credited with no raw-material deduction.
 * On insert failure, roll back the just-created run (delete; fall back to cancelled).
 */
type DbError = { message: string } | null;

export interface RunMaterialRow {
  production_run_id: string;
  raw_material_id: string;
  quantity_consumed: number;
}

/** Minimal client surface (supabase-js compatible) so this can be unit tested. */
export interface MaterialsClient {
  from(table: string): {
    insert(rows: RunMaterialRow[]): PromiseLike<{ error: DbError }>;
    delete(): { eq(col: string, val: string): PromiseLike<{ error: DbError }> };
    update(v: { status: string }): { eq(col: string, val: string): PromiseLike<{ error: DbError }> };
  };
}

export type SaveMaterialsResult =
  | { ok: true }
  | { ok: false; error: string; rolledBack: 'deleted' | 'cancelled' | 'failed' };

export async function saveRunMaterialsOrRollback(
  client: MaterialsClient,
  runId: string,
  rows: RunMaterialRow[],
): Promise<SaveMaterialsResult> {
  if (rows.length === 0) return { ok: true };
  const { error } = await client.from('production_run_materials').insert(rows);
  if (!error) return { ok: true };

  const msg = `Failed to save run materials: ${error.message}. Run was not completed.`;
  await client.from('production_run_materials').delete().eq('production_run_id', runId);
  const del = await client.from('production_runs').delete().eq('id', runId);
  if (!del.error) return { ok: false, error: msg, rolledBack: 'deleted' };
  const upd = await client.from('production_runs').update({ status: 'cancelled' }).eq('id', runId);
  return { ok: false, error: msg, rolledBack: upd.error ? 'failed' : 'cancelled' };
}
