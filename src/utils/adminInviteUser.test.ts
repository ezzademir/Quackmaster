import { describe, expect, it } from 'vitest';
import {
  handleInviteUser,
  INVITE_REDIRECT_TO,
  normaliseEmail,
  type InviteDeps,
} from '../../supabase/functions/admin_invite_user/core';

function makeDeps(over: Partial<InviteDeps> = {}) {
  const calls = { invite: [] as unknown[][], ledger: [] as Record<string, unknown>[] };
  const deps: InviteDeps = {
    getCaller: async (jwt) => (jwt === 'good' ? { id: 'admin-1', email: 'boss@x.com' } : null),
    getProfile: async () => ({ role: 'admin', is_active: true }),
    invite: async (...args) => {
      calls.invite.push(args);
      return { userId: 'new-1', error: null };
    },
    writeLedger: async (row) => {
      calls.ledger.push(row);
      return null;
    },
    ...over,
  };
  return { deps, calls };
}
const body = { email: '  New.Staff@Example.com ', fullName: ' Ali ' };

describe('admin_invite_user', () => {
  it('401 without or with an invalid bearer token', async () => {
    const { deps, calls } = makeDeps();
    expect((await handleInviteUser(deps, null, body)).status).toBe(401);
    expect((await handleInviteUser(deps, 'sb_publishable_x', body)).status).toBe(401);
    expect((await handleInviteUser(deps, 'Bearer bad', body)).status).toBe(401);
    expect(calls.invite).toHaveLength(0);
  });
  it('403 for non-admins, deactivated admins and missing profiles', async () => {
    for (const p of [{ role: 'staff', is_active: true }, { role: 'admin', is_active: false }, null]) {
      const { deps, calls } = makeDeps({ getProfile: async () => p });
      expect((await handleInviteUser(deps, 'Bearer good', body)).status).toBe(403);
      expect(calls.invite).toHaveLength(0);
    }
  });
  it('500 when the profile lookup errors', async () => {
    const { deps } = makeDeps({ getProfile: async () => { throw new Error('db down'); } });
    expect((await handleInviteUser(deps, 'Bearer good', body)).status).toBe(500);
  });
  it('400 on bad email or missing name', async () => {
    const { deps, calls } = makeDeps();
    expect((await handleInviteUser(deps, 'Bearer good', { email: 'nope', fullName: 'A' })).status).toBe(400);
    expect((await handleInviteUser(deps, 'Bearer good', { email: 'a@b.co', fullName: '  ' })).status).toBe(400);
    expect((await handleInviteUser(deps, 'Bearer good', null)).status).toBe(400);
    expect(calls.invite).toHaveLength(0);
  });
  it('invites with normalised email, name metadata and the Pages redirect, and writes a ledger row', async () => {
    const { deps, calls } = makeDeps();
    const r = await handleInviteUser(deps, 'Bearer good', body);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ success: true, userId: 'new-1', ledger_written: true });
    expect(calls.invite[0]).toEqual(['new.staff@example.com', 'Ali', INVITE_REDIRECT_TO]);
    expect(calls.ledger[0]).toMatchObject({ action: 'invited', entity_id: 'new-1', user_id: 'admin-1' });
    expect(calls.ledger[0].after_data).toMatchObject({ role: 'pending' });
  });
  it('409 when the email is already registered, 502 on other auth errors', async () => {
    const dup = makeDeps({ invite: async () => ({ userId: null, error: { message: 'A user with this email address has already been registered', status: 422 } }) });
    expect((await handleInviteUser(dup.deps, 'Bearer good', body)).status).toBe(409);
    const other = makeDeps({ invite: async () => ({ userId: null, error: { message: 'smtp failed', status: 500 } }) });
    expect((await handleInviteUser(other.deps, 'Bearer good', body)).status).toBe(502);
    expect(dup.calls.ledger).toHaveLength(0);
  });
  it('still succeeds when the ledger write fails', async () => {
    const { deps } = makeDeps({ writeLedger: async () => 'rls' });
    const r = await handleInviteUser(deps, 'Bearer good', body);
    expect(r.status).toBe(200);
    expect(r.body.ledger_written).toBe(false);
  });
  it('normaliseEmail', () => {
    expect(normaliseEmail(' A@B.CO ')).toBe('a@b.co');
    expect(normaliseEmail('a b@c.co')).toBeNull();
    expect(normaliseEmail(42)).toBeNull();
  });
});
