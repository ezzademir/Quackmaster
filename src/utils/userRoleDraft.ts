/**
 * Role choices on the Users screen. Kept pure so the "opened and saved keeps the role" rule is unit-tested.
 * The database (admin_set_profile_role_and_outlet) is the real authority on which roles may be assigned.
 */
export const ASSIGNABLE_ROLES = [
  { value: 'staff', label: 'Staff' },
  { value: 'admin', label: 'Admin' },
  { value: 'supervisor', label: 'Outlet supervisor' },
  { value: 'procurement', label: 'Procurement' },
] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]['value'];

/**
 * The role shown in the drawer when a user is opened. It is the user's CURRENT role, normalised, never a guess:
 * the old code turned every role it did not know ('procurement') into 'staff', so opening a procurement user and
 * pressing Save silently demoted them. A role this screen cannot assign is returned as-is; the select shows it as
 * "current" and the RPC refuses to re-save it (invalid_role) instead of changing it.
 */
export function roleDraftFromRole(role: string | null | undefined): string {
  const r = String(role ?? '').toLowerCase().trim();
  return r || 'staff';
}

export function isAssignableRole(role: string): role is AssignableRole {
  return ASSIGNABLE_ROLES.some((o) => o.value === role);
}

/** Arguments for admin_set_profile_role_and_outlet. Only a supervisor carries an outlet. */
export function roleRpcArgs(targetId: string, role: string, outletId: string) {
  return {
    p_target_user_id: targetId,
    p_role: role,
    p_assigned_outlet_id: role === 'supervisor' ? outletId.trim() : null,
  };
}
