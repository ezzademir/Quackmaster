import { describe, expect, it } from 'vitest';
import USERS_TSX from '../pages/Users.tsx?raw';
import { ASSIGNABLE_ROLES, isAssignableRole, roleDraftFromRole, roleRpcArgs } from './userRoleDraft';

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
    expect(USERS_TSX).toMatch(/roleRpcArgs\(target\.id, r, outletDraft\)/);
  });
});
