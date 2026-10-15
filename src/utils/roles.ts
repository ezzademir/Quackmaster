/** Role helpers shared by route guards (kept in sync with supabase/functions/sync_storehub_sales). */
export type AppRole = 'admin' | 'staff' | 'supervisor' | 'pending' | 'viewer';

export const VIEWER_HOME = '/pos-compare';
const VIEWER_PATHS = new Set([VIEWER_HOME, '/required-password-reset']);

export function normalizeRole(role: string | null | undefined): string {
  return String(role ?? '').toLowerCase().trim();
}

/** POS compare is open to admins and the read-only viewer role. */
export function canViewPosCompare(role: string | null | undefined): boolean {
  const r = normalizeRole(role);
  return r === 'admin' || r === 'viewer';
}

/** Viewer accounts are confined to POS compare (plus forced password reset). */
export function isViewerAllowedPath(path: string): boolean {
  return VIEWER_PATHS.has(path);
}

/** Edge function sync_storehub_sales: which roles may run which action. `sync` writes and stays admin-only. */
export function storehubActionAllowed(role: string | null | undefined, action: string): boolean {
  const r = normalizeRole(role);
  if (r === 'admin') return true;
  if (r === 'viewer') return action === 'status' || action === 'catalog' || action === 'report';
  return false;
}
