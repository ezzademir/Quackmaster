import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261014130000_074_tighten_adjustments_ledger_writes.sql?raw';

const U = {
  admin: '00000000-0000-0000-0000-0000000000a1',
  staff: '00000000-0000-0000-0000-0000000000b1',
  supervisor: '00000000-0000-0000-0000-0000000000d1',
  pending: '00000000-0000-0000-0000-0000000000e1',
  viewer: '00000000-0000-0000-0000-0000000000c1',
};

const ENV = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, is_active boolean NOT NULL DEFAULT true);
  CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT EXISTS (SELECT 1 FROM public.profiles WHERE id = auth.uid() AND role = 'admin' AND is_active) $$;
  CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = auth.uid() AND p.role IN ('admin','staff') AND p.is_active) $$;
  CREATE TABLE public.inventory_adjustments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), status text DEFAULT 'pending', created_by uuid);
  CREATE TABLE public.data_ledger (id bigserial PRIMARY KEY, user_id uuid, action text);
  ALTER TABLE public.inventory_adjustments ENABLE ROW LEVEL SECURITY;
  ALTER TABLE public.data_ledger ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Authenticated users can view inventory_adjustments" ON public.inventory_adjustments FOR SELECT TO authenticated USING (true);
  CREATE POLICY "Authenticated users can manage inventory adjustments" ON public.inventory_adjustments FOR ALL TO authenticated USING (true) WITH CHECK (true);
  CREATE POLICY "Authenticated users can insert own inventory_adjustments" ON public.inventory_adjustments FOR INSERT TO authenticated WITH CHECK (created_by = auth.uid());
  CREATE POLICY "Admins can update inventory_adjustments" ON public.inventory_adjustments FOR UPDATE TO authenticated USING (is_profiles_admin()) WITH CHECK (is_profiles_admin());
  CREATE POLICY "Authenticated users can insert ledger rows" ON public.data_ledger FOR INSERT TO authenticated WITH CHECK (true);
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
  GRANT ALL ON public.inventory_adjustments, public.data_ledger TO authenticated, anon;
  GRANT USAGE, SELECT ON SEQUENCE public.data_ledger_id_seq TO authenticated;
  INSERT INTO public.profiles VALUES
    ('${U.admin}','admin',true), ('${U.staff}','staff',true), ('${U.supervisor}','supervisor',true),
    ('${U.pending}','pending',true), ('${U.viewer}','viewer',true);
`;

async function setup() {
  const db = new PGlite();
  await db.exec(ENV);
  await db.exec(MIG);
  return db;
}

async function tryAs(db: PGlite, uid: string, sql: string): Promise<boolean> {
  await db.exec(`SET test.uid = '${uid}'; SET ROLE authenticated;`);
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

describe('074 tighten writes', () => {
  it('data_ledger insert: admin/staff/supervisor yes, pending/viewer no, no spoofing', async () => {
    const db = await setup();
    for (const r of ['admin', 'staff', 'supervisor'] as const)
      expect(await tryAs(db, U[r], `INSERT INTO public.data_ledger (user_id, action) VALUES ('${U[r]}','x')`)).toBe(true);
    for (const r of ['pending', 'viewer'] as const)
      expect(await tryAs(db, U[r], `INSERT INTO public.data_ledger (user_id, action) VALUES ('${U[r]}','x')`)).toBe(false);
    expect(await tryAs(db, U.staff, `INSERT INTO public.data_ledger (user_id, action) VALUES ('${U.admin}','x')`)).toBe(false);
  });

  it('inventory_adjustments: only active admin/staff insert own; no one deletes; non-admin cannot update', async () => {
    const db = await setup();
    for (const r of ['admin', 'staff'] as const)
      expect(await tryAs(db, U[r], `INSERT INTO public.inventory_adjustments (created_by) VALUES ('${U[r]}')`)).toBe(true);
    for (const r of ['supervisor', 'pending', 'viewer'] as const)
      expect(await tryAs(db, U[r], `INSERT INTO public.inventory_adjustments (created_by) VALUES ('${U[r]}')`)).toBe(false);
    await tryAs(db, U.pending, `DELETE FROM public.inventory_adjustments`);
    await tryAs(db, U.staff, `UPDATE public.inventory_adjustments SET status='applied'`);
    const r = await db.query<{ n: number; applied: number }>(
      `SELECT count(*)::int n, count(*) FILTER (WHERE status='applied')::int applied FROM public.inventory_adjustments`
    );
    expect(r.rows[0]).toEqual({ n: 2, applied: 0 });
  });

  it('anon has no table privileges', async () => {
    const db = await setup();
    const r = await db.query<{ ok: boolean }>(`SELECT has_table_privilege('anon','public.data_ledger','INSERT') ok`);
    expect(r.rows[0].ok).toBe(false);
  });
});
