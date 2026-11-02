import { describe, expect, it } from 'vitest';
import {
  BAN_FOREVER, UNBAN, handleSetUserActive, type ApplyResult, type SetUserActiveDeps,
} from '../../supabase/functions/admin_set_user_active/core';

const ADMIN = '11111111-1111-1111-1111-111111111111';
const TARGET = '22222222-2222-2222-2222-222222222222';

function deps(o: { caller?: string | null; apply?: ApplyResult | ApplyResult[]; banErr?: string | null } = {}) {
  const calls: string[] = [];
  const applies = Array.isArray(o.apply) ? [...o.apply] : null;
  const d: SetUserActiveDeps = {
    getCaller: async () => (o.caller === null ? null : { id: o.caller ?? ADMIN }),
    applyActive: async (_a, _t, active) => {
      calls.push(`apply ${active}`);
      return applies ? applies.shift() ?? { success: true } : (o.apply as ApplyResult) ?? { success: true, sessions_revoked: 2 };
    },
    setBan: async (_t, dur) => {
      calls.push(`ban ${dur}`);
      return o.banErr ?? null;
    },
  };
  return { d, calls };
}
const H = 'Bearer jwt';

describe('admin_set_user_active handler', () => {
  it('401 without bearer / invalid session', async () => {
    expect((await handleSetUserActive(deps().d, null, {})).status).toBe(401);
    expect((await handleSetUserActive(deps({ caller: null }).d, H, { userId: TARGET, active: false })).status).toBe(401);
  });
  it('400 on bad input and on self', async () => {
    expect((await handleSetUserActive(deps().d, H, { userId: 'x', active: false })).status).toBe(400);
    expect((await handleSetUserActive(deps().d, H, { userId: TARGET })).status).toBe(400);
    const s = deps();
    const r = await handleSetUserActive(s.d, H, { userId: ADMIN, active: false });
    expect(r.status).toBe(400);
    expect(s.calls).toEqual([]);
  });
  it('deactivate: DB first then ban forever', async () => {
    const s = deps();
    const r = await handleSetUserActive(s.d, H, { userId: TARGET, active: false });
    expect(r).toEqual({ status: 200, body: { success: true, is_active: false, sessions_revoked: 2 } });
    expect(s.calls).toEqual(['apply false', `ban ${BAN_FOREVER}`]);
  });
  it('deactivate: RPC refusal maps status and never bans (last admin / forbidden)', async () => {
    for (const [error, status] of [['last_admin', 409], ['forbidden', 403], ['not_found', 404]] as const) {
      const s = deps({ apply: { success: false, error } });
      expect((await handleSetUserActive(s.d, H, { userId: TARGET, active: false })).status).toBe(status);
      expect(s.calls).toEqual(['apply false']);
    }
  });
  it('deactivate: ban failure rolls the profile back', async () => {
    const s = deps({ banErr: 'auth down' });
    const r = await handleSetUserActive(s.d, H, { userId: TARGET, active: false });
    expect(r.status).toBe(502);
    expect(s.calls).toEqual(['apply false', `ban ${BAN_FOREVER}`, 'apply true']);
  });
  it('reactivate: unban first then DB; DB failure re-bans', async () => {
    const ok = deps();
    expect((await handleSetUserActive(ok.d, H, { userId: TARGET, active: true })).status).toBe(200);
    expect(ok.calls).toEqual([`ban ${UNBAN}`, 'apply true']);
    const bad = deps({ apply: { success: false, error: 'forbidden' } });
    expect((await handleSetUserActive(bad.d, H, { userId: TARGET, active: true })).status).toBe(403);
    expect(bad.calls).toEqual([`ban ${UNBAN}`, 'apply true', `ban ${BAN_FOREVER}`]);
  });
});
