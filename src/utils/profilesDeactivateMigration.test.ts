import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261007140000_071_profiles_deactivate.sql?raw';

const A1 = '00000000-0000-0000-0000-0000000000a1';
const A2 = '00000000-0000-0000-0000-0000000000a2';
const S1 = '00000000-0000-0000-0000-0000000000b1';

// Minimal Supabase-like environment + the live pre-071 definitions that 071 rewrites.
const ENV = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT '{}'::jsonb $$;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
  CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
  CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar, session_id uuid);
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text NOT NULL DEFAULT '', role text NOT NULL DEFAULT 'pending',
    password_reset_required boolean DEFAULT false, assigned_outlet_id uuid, created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(), last_login timestamptz);
  CREATE TABLE public.pending_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, email text, status text);
  CREATE TABLE public.data_ledger (id bigserial PRIMARY KEY, user_id uuid, user_email text, action text, entity_type text,
    entity_id text, module text, operation text, reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb,
    metadata jsonb, created_at timestamptz DEFAULT now());
  CREATE TABLE public.recipes (id int PRIMARY KEY, name text);
  ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Admins can update recipes" ON public.recipes FOR UPDATE TO authenticated
    USING (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))));
  CREATE POLICY "Admins insert recipes" ON public.recipes FOR INSERT TO authenticated
    WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))));
  CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
  CREATE FUNCTION public.get_users_management_data() RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$
  DECLARE is_admin boolean; approved jsonb;
  BEGIN
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin') INTO is_admin;
    IF NOT COALESCE(is_admin, false) THEN RETURN jsonb_build_object('error', 'forbidden'); END IF;
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id', s.id, 'password_reset_required', s.password_reset_required, 'role', s.role) ORDER BY s.id), '[]'::jsonb)
    INTO approved
    FROM (SELECT p.id, p.role, p.password_reset_required, p.created_at FROM public.profiles p WHERE p.role <> 'pending') s;
    RETURN jsonb_build_object('approved', approved);
  END $f$;
`;

async function setup() {
  const pg = new PGlite();
  await pg.exec(ENV);
  await pg.exec(MIG);
  await pg.exec(`
    CREATE TRIGGER trg_profiles_enforce_privileged_columns BEFORE INSERT OR UPDATE ON public.profiles
      FOR EACH ROW EXECUTE FUNCTION public.profiles_enforce_privileged_columns();
    INSERT INTO auth.users VALUES ('${A1}','a1@x'),('${A2}','a2@x'),('${S1}','s1@x');
    SET quackmaster.bypass_profile_privilege_guard = 'on';
    INSERT INTO public.profiles (id, full_name, role) VALUES ('${A1}','Admin One','admin'),('${A2}','Admin Two','admin'),('${S1}','Staff One','staff');
    SET quackmaster.bypass_profile_privilege_guard = 'off';
    INSERT INTO auth.sessions (user_id) VALUES ('${S1}'),('${S1}'),('${A1}');
    INSERT INTO auth.refresh_tokens (user_id) VALUES ('${S1}'),('${A1}');`);
  return pg;
}
const apply = async (pg: PGlite, actor: string, target: string, active: boolean) =>
  (await pg.query<{ r: Record<string, unknown> }>(`select public.admin_apply_user_active($1,$2,$3,'test') r`, [actor, target, active])).rows[0].r;
const asUser = (pg: PGlite, uid: string) => pg.exec(`SELECT set_config('test.uid', '${uid}', false)`);

describe('071 profiles deactivate', () => {
  it('deactivate: profile inactive, sessions revoked, ledger row; history row kept', async () => {
    const pg = await setup();
    expect(await apply(pg, A1, S1, false)).toMatchObject({ success: true, is_active: false, sessions_revoked: 2 });
    const p = (await pg.query<{ is_active: boolean; deactivated_by: string; full_name: string }>(
      `select is_active, deactivated_by, full_name from profiles where id='${S1}'`)).rows[0];
    expect(p).toEqual({ is_active: false, deactivated_by: A1, full_name: 'Staff One' });
    expect((await pg.query(`select 1 from auth.sessions where user_id='${S1}'`)).rows).toHaveLength(0);
    expect((await pg.query(`select 1 from auth.refresh_tokens where user_id='${S1}'`)).rows).toHaveLength(0);
    expect((await pg.query(`select 1 from auth.sessions where user_id='${A1}'`)).rows).toHaveLength(1);
    const l = (await pg.query<{ action: string; user_id: string }>(`select action, user_id from data_ledger`)).rows;
    expect(l).toEqual([{ action: 'deactivated', user_id: A1 }]);
  });
  it('reactivate reverses; repeat is unchanged', async () => {
    const pg = await setup();
    await apply(pg, A1, S1, false);
    expect(await apply(pg, A1, S1, true)).toMatchObject({ success: true, is_active: true });
    expect((await pg.query(`select is_active, deactivated_at from profiles where id='${S1}'`)).rows[0]).toEqual({ is_active: true, deactivated_at: null });
    expect(await apply(pg, A1, S1, true)).toMatchObject({ success: true, unchanged: true });
  });
  it('cannot deactivate self or the last active admin; inactive admin cannot act', async () => {
    const pg = await setup();
    expect(await apply(pg, A1, A1, false)).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await apply(pg, A1, A2, false)).toMatchObject({ success: true });
    expect(await apply(pg, A2, A1, false)).toMatchObject({ success: false, error: 'forbidden' }); // A2 inactive
    expect(await apply(pg, S1, A1, false)).toMatchObject({ success: false, error: 'forbidden' }); // staff
    // A1 is now the only active admin: re-activate A2 then try to remove A1 via A2 → allowed; then last-admin guard
    await apply(pg, A1, A2, true);
    expect(await apply(pg, A2, A1, false)).toMatchObject({ success: true });
    await asUser(pg, A2);
    expect(await apply(pg, A1, A2, false)).toMatchObject({ success: false, error: 'forbidden' });
  });
  it('last active admin guard', async () => {
    const pg = await setup();
    await apply(pg, A1, A2, false); // A2 inactive → A1 only active admin
    await pg.exec(`SET quackmaster.bypass_profile_privilege_guard='on'; UPDATE profiles SET role='admin' WHERE id='${S1}'; SET quackmaster.bypass_profile_privilege_guard='off';`);
    expect(await apply(pg, S1, A1, false)).toMatchObject({ success: true }); // S1 (admin) removes A1, S1 remains
    await apply(pg, S1, A2, true);
    await apply(pg, A2, S1, false);
    // now A2 sole active admin; nobody else active admin to act, and A2 cannot target self
    expect(await apply(pg, A2, A2, false)).toMatchObject({ error: 'invalid_target' });
    await pg.exec(`SET quackmaster.bypass_profile_privilege_guard='on'; UPDATE profiles SET is_active=true WHERE id='${A1}'; SET quackmaster.bypass_profile_privilege_guard='off';`);
    expect(await apply(pg, A1, A2, false)).toMatchObject({ success: true });
    await pg.exec(`SET quackmaster.bypass_profile_privilege_guard='on'; UPDATE profiles SET role='admin', is_active=true WHERE id='${S1}'; SET quackmaster.bypass_profile_privilege_guard='off';`);
    await apply(pg, A1, S1, false);
    expect(await apply(pg, S1, A1, false)).toMatchObject({ error: 'forbidden' });
  });
  it('helpers + inline policies require an active profile', async () => {
    const pg = await setup();
    await asUser(pg, A1);
    expect((await pg.query<{ v: boolean }>('select public.is_profiles_admin() v')).rows[0].v).toBe(true);
    expect((await pg.query<{ v: boolean }>('select public.is_authenticated_active_staff() v')).rows[0].v).toBe(true);
    await apply(pg, A2, A1, false);
    expect((await pg.query<{ v: boolean }>('select public.is_profiles_admin() v')).rows[0].v).toBe(false);
    expect((await pg.query<{ v: boolean }>('select public.is_authenticated_active_staff() v')).rows[0].v).toBe(false);
    const pol = (await pg.query<{ q: string | null; w: string | null }>(
      `select qual q, with_check w from pg_policies where tablename='recipes' order by policyname`)).rows;
    expect(pol[0].q).toContain('p.is_active');
    expect(pol[1].w).toContain('p.is_active');
  });
  it('privileged guard: non-admin cannot flip is_active', async () => {
    const pg = await setup();
    await asUser(pg, S1);
    await expect(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${A1}'`)).rejects.toThrow(/active status/);
  });
  it('get_users_management_data exposes is_active; inactive admin forbidden', async () => {
    const pg = await setup();
    await asUser(pg, A1);
    const r = (await pg.query<{ r: { approved: Array<{ is_active: boolean }> } }>('select public.get_users_management_data() r')).rows[0].r;
    expect(r.approved.every((u) => u.is_active === true)).toBe(true);
    await apply(pg, A2, A1, false);
    const f = (await pg.query<{ r: { error?: string } }>('select public.get_users_management_data() r')).rows[0].r;
    expect(f.error).toBe('forbidden');
  });
  it('RPC not executable by anon/authenticated; migration re-run is safe', async () => {
    const pg = await setup();
    const g = (await pg.query<{ a: boolean; u: boolean; s: boolean }>(`select
      has_function_privilege('anon','public.admin_apply_user_active(uuid,uuid,boolean,text)','EXECUTE') a,
      has_function_privilege('authenticated','public.admin_apply_user_active(uuid,uuid,boolean,text)','EXECUTE') u,
      has_function_privilege('service_role','public.admin_apply_user_active(uuid,uuid,boolean,text)','EXECUTE') s`)).rows[0];
    expect(g).toEqual({ a: false, u: false, s: true });
    await pg.exec(MIG);
    const pol = (await pg.query<{ q: string }>(`select qual q from pg_policies where policyname='Admins can update recipes'`)).rows[0].q;
    expect(pol.match(/p\.is_active/g)).toHaveLength(1);
  });
});
