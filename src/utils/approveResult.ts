/** Normalise the admin_approve_registration RPC payload; anything but explicit success is a failure. */
export function parseApproveResult(data: unknown): { ok: true } | { ok: false; message: string } {
  const d = (data ?? null) as { success?: unknown; error?: unknown; message?: unknown } | null;
  if (d && d.success === true) return { ok: true };
  const msg = (d && typeof d.message === 'string' && d.message) || (d && typeof d.error === 'string' && d.error) || 'No confirmation from server';
  return { ok: false, message: msg };
}
