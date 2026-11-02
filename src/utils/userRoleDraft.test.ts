import { describe, expect, it } from 'vitest';
import USERS_TSX from '../pages/Users.tsx?raw';
import {
  ASSIGNABLE_ROLES,
  PROCUREMENT_TAG_OPTIONS,
  isAssignableRole,
  normaliseTags,
  planRoleSave,
  roleDraftFromRole,
  roleRpcArgs,
  saveErrorText,
  tagsDraftFromUser,
  tagsLabel,
  userAfterSave,
} from './userRoleDraft';

const TARGET = '00000000-0000-0000-0000-0000000000a4';

describe('Users screen role draft', () => {
  it('offers Procurement in the role list', () => {
    expect(ASSIGNABLE_ROLES.map((o) => o.value)).toEqual(['staff', 'admin', 'supervisor', 'procurement']);
    expect(ASSIGNABLE_ROLES.find((o) => o.value === 'procurement')?.label).toBe('Procurement');
  });

  it.each(['admin', 'staff', 'supervisor', 'procurement', ' Procurement ', 'PROCUREMENT'])(
    'opening a "%s" user shows their current role, so Save keeps it',
    (role) => {
      const draft = roleDraftFromRole(role);
      expect(draft).toBe(role.toLowerCase().trim());
      expect(isAssignableRole(draft)).toBe(true);
      // what Save sends to admin_set_profile_role_and_outlet
      expect(roleRpcArgs(TARGET, draft, '').p_role).toBe(role.toLowerCase().trim());
    }
  );

  it('opened and saved: a procurement user is sent as procurement, never staff, and carries no outlet', () => {
    expect(roleRpcArgs(TARGET, roleDraftFromRole('procurement'), 'ignored-outlet')).toEqual({
      p_target_user_id: TARGET,
      p_role: 'procurement',
      p_assigned_outlet_id: null,
    });
  });

  it('only a supervisor carries an outlet', () => {
    expect(roleRpcArgs(TARGET, 'supervisor', ' o1 ').p_assigned_outlet_id).toBe('o1');
    expect(roleRpcArgs(TARGET, 'admin', 'o1').p_assigned_outlet_id).toBeNull();
  });

  it('a role this screen cannot assign is kept as-is (the RPC refuses it), never guessed as staff', () => {
    expect(roleDraftFromRole('viewer')).toBe('viewer');
    expect(isAssignableRole('viewer')).toBe(false);
  });

  it('missing role falls back to staff only when there is no role at all', () => {
    expect(roleDraftFromRole(null)).toBe('staff');
    expect(roleDraftFromRole('')).toBe('staff');
  });

  it('Users.tsx uses the helper at every place it opens a user and has no role-coercion ternary left', () => {
    expect(USERS_TSX.match(/setRoleDraft\(roleDraftFromRole\(user\.role\)\)/g)?.length).toBe(2);   // desktop table + mobile list
    expect(USERS_TSX).not.toMatch(/rl === 'admin' \? 'admin'/);
    expect(USERS_TSX).not.toMatch(/as 'admin' \| 'staff' \| 'supervisor'/);
    expect(USERS_TSX).toMatch(/ASSIGNABLE_ROLES\.map/);
    expect(USERS_TSX).toMatch(/roleRpcArgs\(target\.id, roleDraft, outletDraft\)/);
  });
});

describe('Users screen business tags (procurement users)', () => {
  const proc = { role: 'procurement', assignedOutletId: null, tags: ['merdeka_house'] };

  it('offers MH and QT, the two tags the database knows', () => {
    expect(PROCUREMENT_TAG_OPTIONS.map((o) => [o.short, o.value])).toEqual([['MH', 'merdeka_house'], ['QT', 'quackteow']]);
  });

  it('opening a procurement user shows their tags; any other role opens with none', () => {
    expect(tagsDraftFromUser('procurement', ['quackteow', 'merdeka_house', 'quackteow'])).toEqual(['merdeka_house', 'quackteow']);
    expect(tagsDraftFromUser('staff', ['quackteow'])).toEqual([]);
    expect(tagsLabel(['quackteow', 'merdeka_house'])).toBe('MH, QT');
    expect(tagsLabel([])).toBe('—');
    expect(normaliseTags(null)).toEqual([]);
  });

  it('procurement needs one or more tags before Save sends anything', () => {
    for (const cur of [{ role: 'staff' }, proc]) {
      const plan = planRoleSave(cur, { role: 'procurement', outletId: '', tags: [] });
      expect(plan).toMatchObject({ callRole: false, callTags: false });
      expect(plan.error).toMatch(/at least one business tag/i);
    }
  });

  it('staff -> procurement sends the role first, then the tags', () => {
    expect(planRoleSave({ role: 'staff' }, { role: 'procurement', outletId: '', tags: ['quackteow', 'merdeka_house'] }))
      .toEqual({ error: null, callRole: true, callTags: true, tags: ['merdeka_house', 'quackteow'] });
  });

  it('opened and saved with no change sends nothing (the role is never re-written or demoted)', () => {
    expect(planRoleSave(proc, { role: roleDraftFromRole('procurement'), outletId: '', tags: ['merdeka_house'] }))
      .toMatchObject({ error: 'Nothing to change.', callRole: false, callTags: false });
  });

  it('a procurement user whose tags change keeps the role and only sends the tags', () => {
    expect(planRoleSave(proc, { role: 'procurement', outletId: '', tags: ['merdeka_house', 'quackteow'] }))
      .toEqual({ error: null, callRole: false, callTags: true, tags: ['merdeka_house', 'quackteow'] });
  });

  it('leaving procurement sends the role and NO tags (the database clears them and ledgers old and new)', () => {
    for (const to of ['staff', 'admin']) {
      expect(planRoleSave(proc, { role: to, outletId: '', tags: ['merdeka_house'] }))
        .toEqual({ error: null, callRole: true, callTags: false, tags: [] });
    }
    expect(planRoleSave(proc, { role: 'supervisor', outletId: 'o1', tags: ['merdeka_house'] }))
      .toEqual({ error: null, callRole: true, callTags: false, tags: [] });
    expect(planRoleSave(proc, { role: 'supervisor', outletId: '', tags: [] }).error).toMatch(/outlet/i);
  });

  it('database refusals are shown in plain words', () => {
    expect(saveErrorText('last_active_admin')).toMatch(/last active admin/i);
    expect(saveErrorText('profiles: last_active_admin: cannot demote')).toMatch(/last active admin/i);
    expect(saveErrorText('invalid_target')).toMatch(/your own/i);
    expect(saveErrorText('something else', 'Server said no')).toBe('Server said no');
  });

  it('Users.tsx never writes user_entities or profiles.role from the client; it uses the 085/090 RPCs and shows the server error', () => {
    expect(USERS_TSX).not.toMatch(/from\(\s*['"]user_entities['"]\s*\)/);
    expect(USERS_TSX).not.toMatch(/from\(\s*['"]profiles['"]\s*\)[\s\S]{0,240}\.update\(\s*\{[^}]*\brole\s*:/);
    expect(USERS_TSX).toMatch(/admin_set_profile_role_and_outlet/);
    expect(USERS_TSX).toMatch(/admin_set_procurement_tags/);
    expect(USERS_TSX).toMatch(/saveErrorText\(/);
    expect(USERS_TSX).toMatch(/setRoleNotice\(\{ tone: 'err'/);
  });

  it('Users.tsx: tag checkboxes for procurement, tags in list and drawer, tags RPC after the role RPC, no client-side role ledger write', () => {
    expect(USERS_TSX).toMatch(/PROCUREMENT_TAG_OPTIONS\.map/);
    expect(USERS_TSX).toMatch(/roleDraft === 'procurement' &&/);
    expect(USERS_TSX).toMatch(/tagsLabel\(user\.entity_tags\)/);
    expect(USERS_TSX).toMatch(/tagsLabel\(drawerApproved\.entity_tags\)/);
    expect(USERS_TSX).toMatch(/entity_tags: normaliseTags\(p\.entity_tags\)/);
    expect(USERS_TSX.indexOf("'admin_set_profile_role_and_outlet'")).toBeGreaterThan(-1);
    expect(USERS_TSX.indexOf("'admin_set_profile_role_and_outlet'")).toBeLessThan(USERS_TSX.indexOf("'admin_set_procurement_tags'"));
    expect(USERS_TSX).not.toMatch(/role_change:\s*true/);                 // the database audits role changes now
    expect(USERS_TSX.match(/setTagsDraft\(tagsDraftFromUser\(user\.role, user\.entity_tags\)\)/g)?.length).toBe(2);
  });
});

describe('Users screen partial save (role saved, tags failed) and deadlock message', () => {
  const opened = { id: 'u1', role: 'staff', assigned_outlet_id: null, entity_tags: [] as string[] };

  it('after a partial save the drawer user shows the role the database holds (procurement, no tags yet), never the old role', () => {
    const shown = userAfterSave(opened, { role: 'procurement', outletId: '', tags: [] });
    expect(shown).toMatchObject({ id: 'u1', role: 'procurement', assigned_outlet_id: null, entity_tags: [] });
    expect(opened.role).toBe('staff');                                  // input not mutated
  });
  it('after a full save the drawer shows role, outlet and tags; other roles carry no tags and only supervisors an outlet', () => {
    expect(userAfterSave(opened, { role: 'procurement', outletId: 'o1', tags: ['quackteow', 'merdeka_house'] }))
      .toMatchObject({ role: 'procurement', assigned_outlet_id: null, entity_tags: ['merdeka_house', 'quackteow'] });
    expect(userAfterSave(opened, { role: 'supervisor', outletId: 'o1', tags: ['quackteow'] }))
      .toMatchObject({ role: 'supervisor', assigned_outlet_id: 'o1', entity_tags: [] });
  });
  it('a retry after a partial save sends only the tags (the role is already procurement)', () => {
    const afterPartial = userAfterSave(opened, { role: 'procurement', outletId: '', tags: [] });
    expect(planRoleSave({ role: afterPartial.role, assignedOutletId: afterPartial.assigned_outlet_id, tags: afterPartial.entity_tags },
      { role: 'procurement', outletId: '', tags: ['merdeka_house'] })).toEqual({ error: null, callRole: false, callTags: true, tags: ['merdeka_house'] });
  });
  it('a deadlock (code or text) becomes a plain retry message, not "deadlock detected"', () => {
    for (const raw of ['40P01 deadlock detected', 'deadlock detected', '40P01']) {
      expect(saveErrorText(raw)).toMatch(/try again/i);
      expect(saveErrorText(raw)).not.toMatch(/deadlock detected/i);
    }
  });
  it('Users.tsx: a partial save refreshes the drawer, says so plainly, keeps the ticked tags, and passes the error code on', () => {
    expect(USERS_TSX).toMatch(/const showPartialSave = async \(reason: string\)/);
    expect(USERS_TSX).toMatch(/userAfterSave\(drawer\.user, \{ role: roleDraft, outletId: outletDraft, tags: \[\] \}\)/);
    expect(USERS_TSX).toMatch(/The role was saved, but the business tags were not: \$\{reason\} Press Save again to retry the tags\./);
    expect(USERS_TSX.match(/await showPartialSave\(/g)?.length).toBe(2);      // RPC "success: false" and a thrown error
    expect(USERS_TSX).toMatch(/'code' in error/);
    expect(USERS_TSX).not.toMatch(/if \(roleSaved\) await loadUsers\(\);/);   // the old half-refresh is gone
  });
});
