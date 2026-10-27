/** Page and feature catalog. Keep keys in sync with the profile_access migration. */

export const GRANTABLE_PAGES = [
  { key: 'overview', label: 'Dashboard', path: '/', group: 'Overview' },
  { key: 'procurement', label: 'Procurement', path: '/procurement', group: 'Hub' },
  { key: 'production', label: 'Production', path: '/production', group: 'Hub' },
  { key: 'inventory', label: 'Inventory', path: '/inventory', group: 'Hub' },
  { key: 'distribution', label: 'Distribution', path: '/distribution', group: 'Hub' },
  { key: 'sales', label: 'Outlet sales', path: '/sales', group: 'Outlets' },
  { key: 'waste', label: 'Waste', path: '/waste', group: 'Outlets' },
  { key: 'stock-take', label: 'Stock take', path: '/stock-take', group: 'Outlets' },
  { key: 'genealogy', label: 'Lot trace', path: '/genealogy', group: 'Find' },
  { key: 'pos-compare', label: 'SHPOS vs QMERP', path: '/pos-compare', group: 'POS' },
  { key: 'audit', label: 'Stock audit', path: '/audit', group: 'Stock integrity' },
  { key: 'reconciliation', label: 'Reconciliation', path: '/reconciliation', group: 'Stock integrity' },
] as const;

export const FEATURES = [
  { key: 'sales.void', label: 'Void a sale', page: 'sales', hint: 'Manual sales. StoreHub voids stay admin-only.' },
  {
    key: 'sales.replace',
    label: 'Replace a sale',
    page: 'sales',
    hint: 'Also turns on Void a sale, because replace voids the original.',
  },
  { key: 'procurement.cancel_po', label: 'Cancel or delete a purchase order', page: 'procurement' },
  { key: 'production.void_run', label: 'Void, restore, or delete a production run', page: 'production' },
  { key: 'production.qc_override', label: 'Post a production run when QC warns', page: 'production' },
  { key: 'production.plan', label: 'Create and change production plans', page: 'production' },
  { key: 'distribution.hard_delete', label: 'Delete a supply order', page: 'distribution' },
] as const;

export type GrantablePageKey = (typeof GRANTABLE_PAGES)[number]['key'];
export type FeatureKey = (typeof FEATURES)[number]['key'];

export interface ProfileAccess {
  pages: GrantablePageKey[];
  features: FeatureKey[];
}

const PAGE_KEYS = new Set<string>(GRANTABLE_PAGES.map((page) => page.key));
const FEATURE_KEYS = new Set<string>(FEATURES.map((feature) => feature.key));

const STAFF_PAGES: GrantablePageKey[] = [
  'overview',
  'procurement',
  'production',
  'inventory',
  'distribution',
  'sales',
  'waste',
  'stock-take',
  'genealogy',
];

const SUPERVISOR_PAGES: GrantablePageKey[] = ['sales', 'waste', 'stock-take'];

export function isGrantablePage(value: string): value is GrantablePageKey {
  return PAGE_KEYS.has(value);
}

export function isFeatureKey(value: string): value is FeatureKey {
  return FEATURE_KEYS.has(value);
}

export function featurePage(key: FeatureKey): GrantablePageKey {
  const feature = FEATURES.find((item) => item.key === key);
  if (!feature) {
    throw new Error(`Unknown feature ${key}`);
  }
  return feature.page;
}

export function emptyAccess(): ProfileAccess {
  return { pages: [], features: [] };
}

/** Used when the access RPC is not deployed yet, so existing roles keep today's pages. */
export function defaultAccessForRole(role: string | null | undefined): ProfileAccess {
  if (role === 'staff') return { pages: [...STAFF_PAGES], features: [] };
  if (role === 'supervisor') return { pages: [...SUPERVISOR_PAGES], features: [] };
  return emptyAccess();
}

export function presetAccess(preset: 'staff' | 'supervisor'): ProfileAccess {
  switch (preset) {
    case 'staff':
      return defaultAccessForRole('staff');
    case 'supervisor':
      return defaultAccessForRole('supervisor');
    default: {
      const unreachable: never = preset;
      return unreachable;
    }
  }
}

export function parseAccessPayload(data: unknown): ProfileAccess {
  const payload = data as { pages?: unknown; features?: unknown } | null;
  const pages = Array.isArray(payload?.pages)
    ? payload.pages.filter((key): key is GrantablePageKey => typeof key === 'string' && isGrantablePage(key))
    : [];
  const features = Array.isArray(payload?.features)
    ? payload.features.filter((key): key is FeatureKey => typeof key === 'string' && isFeatureKey(key))
    : [];
  return { pages, features: featuresForPages(features, pages) };
}

export function featuresForPages(features: readonly FeatureKey[], pages: readonly GrantablePageKey[]): FeatureKey[] {
  const allowed = new Set(pages);
  const next = features.filter((key) => allowed.has(featurePage(key)));
  if (next.includes('sales.replace') && !next.includes('sales.void') && allowed.has('sales')) {
    next.push('sales.void');
  }
  return next;
}

export function canAccessPage(
  role: string | null | undefined,
  pages: readonly string[],
  page: GrantablePageKey
): boolean {
  if (role === 'admin') return true;
  return pages.includes(page);
}

export function canUseFeature(
  role: string | null | undefined,
  features: readonly string[],
  feature: FeatureKey
): boolean {
  if (role === 'admin') return true;
  return features.includes(feature);
}

/** First screen after sign-in. Null when the user has no assigned page. */
export function resolveHomePath(role: string | null | undefined, pages: readonly string[]): string | null {
  if (role === 'admin' || pages.includes('overview')) return '/';
  if (role === 'supervisor' && pages.includes('stock-take')) return '/stock-take';
  for (const page of GRANTABLE_PAGES) {
    if (pages.includes(page.key)) return page.path;
  }
  return null;
}
