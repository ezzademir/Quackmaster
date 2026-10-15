/**
 * After a production-completion RPC, the client used to mark the run cancelled
 * whenever the call reported failure. A committed post whose response was lost
 * is already `completed` with hub FG on hand. Cancelling that row hides the
 * post and invites a second run that consumes raw materials again.
 */
export type ProductionFailureDisposition =
  | 'cancel_in_progress'
  | 'already_posted'
  | 'unknown_leave_open';

export function productionFailureDisposition(opts: {
  statusReadFailed: boolean;
  liveStatus: string | null | undefined;
}): ProductionFailureDisposition {
  if (opts.statusReadFailed) return 'unknown_leave_open';
  const status = String(opts.liveStatus ?? '').toLowerCase().trim();
  if (status === 'completed') return 'already_posted';
  if (status === 'in_progress') return 'cancel_in_progress';
  return 'unknown_leave_open';
}
