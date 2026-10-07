import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261007150000_072_admin_approve_registration.sql?raw';
import { parseApproveResult } from './approveResult';

const ADM = '00000000-0000-0000-0000-0000000000a1';
const U1 = '00000000-0000-0000-0000-0000000000c1';
const U2 = '00000000-0000-0000-0000-0000000000c2';
const ENV = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, updated_at timestamptz);
  CREATE TABLE public.pending_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid UNIQUE, status text,
    reviewed_by uuid, reviewed_at timestamptz, updated_at timestamptz);
  CREATE TABLE public.ledger (action text, entity_id text);
  CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql AS
    $$ SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') $$;
  CREATE FUNCTION public._append_data_ledger(a text, e text, id text, m text, o text, r text, b jsonb, af jsonb, d jsonb, md jsonb)
    RETURNS void LANGUAGE sql AS $$ INSERT INTO public.ledger VALUES (a, id) $$;
  INSERT INTO public.profiles VALUES ('${ADM}','admin',now()),('${U1}','pending',now()),('${U2}','pending',now());
  INSERT INTO public.pending_registrations (user_id, status) VALUES ('${U1}','pending'),('${U2}','approved');
`;
async function setup(uid = ADM) {
  const pg = new PGlite();
  await pg.exec(ENV);
  await pg.exec(MIG);
  await pg.exec(`SELECT set_config('test.uid', '${uid}', false)`);
  return pg;
}
const approve = async (pg: PGlite, u: string) =>
  (await pg.query<{ r: Record<string, unknown> }>('select public.admin_approve_registration($1) r', [u])).rows[0].r;
const state = async (pg: PGlite, u: string) =>
  (await pg.query(`select p.role, r.status, r.reviewed_by from profiles p left join pending_registrations r on r.user_id=p.id where p.id='${u}'`)).rows[0];

describe('072 admin_approve_registration', () => {
  it('approves atomically: role staff + registration approved + ledger', async () => {
    const pg = await setup();
    expect(await approve(pg, U1)).toMatchObject({ success: true, role: 'staff' });
    expect(await state(pg, U1)).toEqual({ role: 'staff', status: 'approved', reviewed_by: ADM });
    expect((await pg.query('select * from ledger')).rows).toEqual([{ action: 'approved', entity_id: U1 }]);
  });
  it('non-admin forbidden, nothing changes', async () => {
    const pg = await setup(U2);
    expect(await approve(pg, U1)).toMatchObject({ success: false, error: 'forbidden' });
    expect(await state(pg, U1)).toMatchObject({ role: 'pending', status: 'pending' });
  });
  it('refuses non-pending registration (the April state) instead of half-applying', async () => {
    const pg = await setup();
    expect(await approve(pg, U2)).toMatchObject({ success: false, error: 'invalid_status' });
    expect(await state(pg, U2)).toMatchObject({ role: 'pending', status: 'approved' });
  });
  it('profile not pending → refused; registration untouched', async () => {
    const pg = await setup();
    await pg.exec(`UPDATE profiles SET role='staff' WHERE id='${U1}'`);
    expect(await approve(pg, U1)).toMatchObject({ success: false, error: 'invalid_profile_state' });
    expect(await state(pg, U1)).toMatchObject({ status: 'pending' });
  });
  it('0-row profile update (e.g. guard/RLS regression) rolls back the registration too', async () => {
    const pg = await setup();
    await pg.exec(`CREATE FUNCTION public.block() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
      CREATE TRIGGER block BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.block();`);
    await expect(approve(pg, U1)).rejects.toThrow(/approve_profile_update_failed/);
    expect(await state(pg, U1)).toMatchObject({ role: 'pending', status: 'pending' });
  });
  it('self / missing registration', async () => {
    const pg = await setup();
    expect(await approve(pg, ADM)).toMatchObject({ error: 'invalid_target' });
    await pg.exec(`INSERT INTO profiles VALUES ('00000000-0000-0000-0000-0000000000c3','pending',now())`);
    expect(await approve(pg, '00000000-0000-0000-0000-0000000000c3')).toMatchObject({ error: 'registration_not_found' });
  });
});

describe('parseApproveResult', () => {
  it('only explicit success is ok', () => {
    expect(parseApproveResult({ success: true })).toEqual({ ok: true });
    expect(parseApproveResult({ success: false, message: 'x' })).toEqual({ ok: false, message: 'x' });
    expect(parseApproveResult(null)).toEqual({ ok: false, message: 'No confirmation from server' });
    expect(parseApproveResult({ error: 'forbidden' })).toEqual({ ok: false, message: 'forbidden' });
  });
});
