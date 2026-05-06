import type { Profile } from './auth';

/** Profiles that may operate stock RPCs (matches DB is_authenticated_active_staff: admin | staff). */
export function isActiveOperationalUser(profile: Profile | null | undefined): boolean {
  return profile?.role === 'admin' || profile?.role === 'staff';
}

export function canAdjustSalesJournal(profile: Profile | null | undefined): boolean {
  return profile?.role === 'admin';
}
