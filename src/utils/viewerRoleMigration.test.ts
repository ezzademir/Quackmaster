import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261014120000_073_viewer_role.sql?raw';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const VIEWER = '00000000-0000-0000-0000-0000000000c1';
const STAFF = '00000000-0000-0000-0000-0000000000b1';

const ENV = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL DEFAULT 'pending', is_active boolean NOT NULL DEFAULT true,
    assigned_outlet_id uuid, updated_at timestamptz DEFAULT now(),
    CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY['admin','staff','pending','supervisor'])));
  CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND is_active) $$;
  CREATE TABLE public.storehub_store_map (storehub_store_id text PRIMARY KEY, outlet_id uuid);
  CREATE TABLE public.storehub_product_map (storehub_product_id text PRIMARY KEY, quackmaster_sku text);
  ALTER TABLE public.storehub_store_map ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.storehub_product_map ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Admins write storehub_store_map" ON public.storehub_store_map FOR ALL TO authenticated USING (is_profiles_admin()) WITH CHECK (is_profiles_admin());
  CREATE POLICY "Admins write storehub_product_map" ON public.storehub_product_map FOR ALL TO authenticated USING (is_profiles_admin()) WITH CHECK (is_profiles_admin());
  GRANT USAGE ON SCHEMA public, auth TO authenticated;
  GRANT ALL ON public.storehub_store_map, public.storehub_product_map TO authenticated;
  GRANT SELECT ON public.profiles TO authenticated;
  INSERT INTO public.profiles (id, role) VALUES ('${ADMIN}','admin'), ('${STAFF}','staff');
  INSERT INTO public.storehub_store_map VALUES ('s1', NULL);
  INSERT INTO public.storehub_product_map VALUES ('p1', 'SKU1');
`;

async function setup() {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(MIG);
  return db;
}

async function asUser<T>(db: PGlite, uid: string, sql: string): Promise<T[]> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    return (await db.query<T>(sql)).rows;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('073 viewer role', () => {
  it('admin can assign viewer; viewer reads maps but cannot write them', async () => {
    const db = await setup();
    await db.exec(`INSERT INTO public.profiles (id, role) VALUES ('${VIEWER}','staff')`);
    await db.exec(`SET test.uid = '${ADMIN}'`);
    const res = await db.query<{ r: { success: boolean } }>(
      `SELECT public.admin_set_profile_role_and_outlet('${VIEWER}', 'viewer') AS r`
    );
    expect(res.rows[0].r.success).toBe(true);

    const stores = await asUser<{ storehub_store_id: string }>(db, VIEWER, 'SELECT * FROM public.storehub_store_map');
    const prods = await asUser(db, VIEWER, 'SELECT * FROM public.storehub_product_map');
    expect(stores).toHaveLength(1);
    expect(prods).toHaveLength(1);

    await expect(asUser(db, VIEWER, "INSERT INTO public.storehub_store_map VALUES ('s2', NULL)")).rejects.toThrow();
    const upd = await asUser(db, VIEWER, "UPDATE public.storehub_product_map SET quackmaster_sku='X' RETURNING 1");
    expect(upd).toHaveLength(0);
  });

  it('staff still cannot read the maps; inactive viewer cannot either', async () => {
    const db = await setup();
    expect(await asUser(db, STAFF, 'SELECT * FROM public.storehub_store_map')).toHaveLength(0);
    await db.exec(`INSERT INTO public.profiles (id, role, is_active) VALUES ('${VIEWER}','viewer', false)`);
    expect(await asUser(db, VIEWER, 'SELECT * FROM public.storehub_store_map')).toHaveLength(0);
  });

  it('viewer is not admin', async () => {
    const db = await setup();
    await db.exec(`INSERT INTO public.profiles (id, role) VALUES ('${VIEWER}','viewer'); SET test.uid = '${VIEWER}'`);
    const r = await db.query<{ a: boolean }>('SELECT public.is_profiles_admin() AS a');
    expect(r.rows[0].a).toBe(false);
  });
});
