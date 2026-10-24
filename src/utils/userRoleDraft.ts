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

// ---------------------------------------------------------------- business tags (procurement users)
/** The tags a procurement user can be assigned (procurement_tags rows; the database rejects any other). */
export const PROCUREMENT_TAG_OPTIONS = [
  { value: 'merdeka_house', short: 'MH', label: 'Merdeka House' },
  { value: 'quackteow', short: 'QT', label: 'Quackteow' },
] as const;

/** Tags as shown on the user: normalised, de-duplicated, stable order. Only a procurement user carries tags. */
export function normaliseTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  return Array.from(new Set(tags.map((t) => String(t ?? '').toLowerCase().trim()).filter(Boolean))).sort();
}

export function tagsDraftFromUser(role: string | null | undefined, tags: unknown): string[] {
  return roleDraftFromRole(role) === 'procurement' ? normaliseTags(tags) : [];
}

export function tagShort(tag: string): string {
  return PROCUREMENT_TAG_OPTIONS.find((o) => o.value === tag)?.short ?? tag;
}

/** "MH, QT" for the list and drawer; '—' when none. */
export function tagsLabel(tags: unknown): string {
  const t = normaliseTags(tags);
  return t.length ? t.map(tagShort).join(', ') : '—';
}

export interface RoleSavePlan {
  error: string | null;
  /** call admin_set_profile_role_and_outlet */
  callRole: boolean;
  /** call admin_set_procurement_tags (always AFTER the role call, so a new procurement user exists first) */
  callTags: boolean;
  tags: string[];
}

/**
 * What Save does for a user, from what they have now and what the drawer holds. The screen only helps; the database
 * (trigger + RPCs) is the authority and refuses self-edits, non-admins, unknown tags and an empty tag set.
 *  - procurement needs one or more tags (checked here for a clear message and again in the database);
 *  - leaving procurement sends no tags: the database clears them and ledgers the old and new values;
 *  - nothing is sent for a part that did not change.
 */
export function planRoleSave(
  current: { role: string | null | undefined; assignedOutletId?: string | null; tags?: unknown },
  draft: { role: string; outletId: string; tags: string[] }
): RoleSavePlan {
  const curRole = roleDraftFromRole(current.role);
  const tags = normaliseTags(draft.tags);
  if (draft.role === 'supervisor' && !draft.outletId.trim()) {
    return { error: 'Supervisors need an assigned outlet.', callRole: false, callTags: false, tags: [] };
  }
  if (draft.role === 'procurement' && tags.length < 1) {
    return { error: 'Pick at least one business tag (MH and/or QT) for a procurement user.', callRole: false, callTags: false, tags };
  }
  const outletChanged = draft.role === 'supervisor' && (current.assignedOutletId ?? '') !== draft.outletId.trim();
  const callRole = draft.role !== curRole || outletChanged;
  const curTags = curRole === 'procurement' ? normaliseTags(current.tags) : [];
  const callTags = draft.role === 'procurement' && (draft.role !== curRole || tags.join(',') !== curTags.join(','));
  if (!callRole && !callTags) {
    return { error: 'Nothing to change.', callRole: false, callTags: false, tags: draft.role === 'procurement' ? tags : [] };
  }
  return { error: null, callRole, callTags, tags: draft.role === 'procurement' ? tags : [] };
}

const SAVE_ERRORS: Record<string, string> = {
  last_active_admin: 'This is the last active admin. Make another admin first.',
  forbidden: 'Only an admin can change roles and business tags.',
  invalid_target: 'You cannot change your own role or business tags.',
  not_procurement: 'Business tags can only be set on a procurement user.',
  tags_required: 'Pick at least one business tag.',
  unknown_tag: 'That business tag does not exist.',
};

/** A message for an RPC/trigger error code or text; falls back to the server message. */
export function saveErrorText(codeOrText: string | null | undefined, serverMessage?: string | null): string {
  const raw = String(codeOrText ?? '');
  for (const [code, text] of Object.entries(SAVE_ERRORS)) if (raw.includes(code)) return text;
  return serverMessage || raw || 'Could not save';
}
