/** Normalise the admin_approve_registration RPC payload; anything but explicit success is a failure. */
export function parseApproveResult(data: unknown): { ok: true } | { ok: false; message: string } {
  const d = (data ?? null) as { success?: unknown; error?: unknown; message?: unknown } | null;
  if (d && d.success === true) return { ok: true };
  const msg = (d && typeof d.message === 'string' && d.message) || (d && typeof d.error === 'string' && d.error) || 'No confirmation from server';
  return { ok: false, message: msg };
}

/**
 * True only when PostgREST/Postgres cannot see admin_approve_registration yet
 * (migration 072 not applied). Other RPC failures must not fall back.
 */
export function isMissingApproveRpc(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  if (error.code === 'PGRST202' || error.code === '42883') return true;
  return /could not find the function/i.test(error.message ?? '') && /admin_approve_registration/i.test(error.message ?? '');
}
