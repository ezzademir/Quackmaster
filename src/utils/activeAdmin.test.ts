import { describe, expect, it } from 'vitest';
import { isActiveAdmin } from '../../supabase/functions/_shared/activeAdmin';

describe('isActiveAdmin (Edge function admin guard)', () => {
  it('accepts only an active admin', () => {
    expect(isActiveAdmin({ role: 'admin', is_active: true })).toBe(true);
  });
  it('refuses deactivated admins, non-admins and missing profiles', () => {
    expect(isActiveAdmin({ role: 'admin', is_active: false })).toBe(false);
    expect(isActiveAdmin({ role: 'admin', is_active: null })).toBe(false);
    expect(isActiveAdmin({ role: 'admin' })).toBe(false);
    expect(isActiveAdmin({ role: 'staff', is_active: true })).toBe(false);
    expect(isActiveAdmin({ role: 'pending', is_active: true })).toBe(false);
    expect(isActiveAdmin(null)).toBe(false);
    expect(isActiveAdmin(undefined)).toBe(false);
  });
});
