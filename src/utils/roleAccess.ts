/**
 * Route + nav access for restricted roles. Pure so it can be unit-tested.
 * RLS is the real enforcement; this only keeps the UI from showing screens
 * whose data a role cannot read.
 */
export type AppRole = 'admin' | 'staff' | 'pending' | 'supervisor' | 'procurement';

export interface RoleNavItem {
  path: string;
  label: string;
  key: 'pos' | 'receiving' | 'bills' | 'suppliers' | 'sales' | 'waste' | 'stock-take';
}

export const PROCUREMENT_NAV: RoleNavItem[] = [
  { path: '/procurement', label: 'Purchase orders', key: 'pos' },
  { path: '/receiving', label: 'Receiving', key: 'receiving' },
  { path: '/bills', label: 'Bills', key: 'bills' },
  { path: '/suppliers', label: 'Suppliers', key: 'suppliers' },
];

export const SUPERVISOR_NAV: RoleNavItem[] = [
  { path: '/sales', label: 'Sales', key: 'sales' },
  { path: '/waste', label: 'Waste', key: 'waste' },
  { path: '/stock-take', label: 'Stock take', key: 'stock-take' },
];

const ALWAYS = ['/required-password-reset'];

/** null = unrestricted (admin / staff see the full nav). */
export function navForRole(role: string | null | undefined): RoleNavItem[] | null {
  const r = String(role ?? '').toLowerCase().trim();
  if (r === 'procurement') return PROCUREMENT_NAV;
  if (r === 'supervisor') return SUPERVISOR_NAV;
  return null;
}

export function homePathForRole(role: string | null | undefined): string {
  const nav = navForRole(role);
  if (!nav) return '/';
  return String(role).toLowerCase().trim() === 'supervisor' ? '/stock-take' : nav[0].path;
}

export function isPathAllowedForRole(role: string | null | undefined, pathname: string): boolean {
  const nav = navForRole(role);
  if (!nav) return true;
  if (ALWAYS.includes(pathname)) return true;
  const r = String(role).toLowerCase().trim();
  return nav.some((n) =>
    // procurement page has sub-routes (/procurement/...); supervisor paths are exact
    r === 'procurement' ? pathname === n.path || pathname.startsWith(`${n.path}/`) : pathname === n.path
  );
}
