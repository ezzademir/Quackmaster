/** Pure admin guard shared by Edge functions (no Deno / npm imports so it can be unit tested). */

export interface CallerProfile {
  role?: string | null;
  is_active?: boolean | null;
}

/**
 * Mirrors public.is_profiles_admin(): role = 'admin' AND is_active.
 * A missing profile, a non-admin role, or a deactivated admin is refused.
 */
export function isActiveAdmin(profile: CallerProfile | null | undefined): boolean {
  return profile?.role === "admin" && profile.is_active === true;
}
