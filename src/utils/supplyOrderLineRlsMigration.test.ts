import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG from '../../supabase/migrations/20261125110000_095_supply_order_lines_pending_only.sql?raw';
import RB from '../../supabase/rollbacks/095_rollback.sql?raw';

const STAFF = '00000000-0000-0000-0000-0000000000b1';
const SUPERVISOR = '00000000-0000-0000-0000-0000000000d1';
const HUB = '00000000-0000-0000-0000-0000000000c1';
const PENDING = '00000000-0000-0000-0000-0000000000e1';
const DISPATCHED = '00000000-0000-0000-0000-0000000000e2';
const RECEIVED = '00000000-0000-0000-0000-0000000000e3';

const ENV = `
  DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  END $$;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
    SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
  CREATE TABLE public.profiles (id uuid PRIMARY KEY, role text NOT NULL, is_active boolean NOT NULL DEFAULT true);
  CREATE FUNCTION public.is_authenticated_active_staff() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    SELECT auth.uid() IS NOT NULL AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.id = auth.uid() AND p.role IN ('admin', 'staff') AND p.is_active
    ) $$;
  CREATE TABLE public.supply_orders (
    id uuid PRIMARY KEY,
    status text NOT NULL
  );
  CREATE TABLE public.hub_inventory (id uuid PRIMARY KEY);
  CREATE TABLE public.supply_order_lines (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    supply_order_id uuid NOT NULL REFERENCES public.supply_orders(id),
    hub_inventory_id uuid NOT NULL REFERENCES public.hub_inventory(id),
    product_batch text,
    quantity numeric NOT NULL CHECK (quantity > 0)
  );
  ALTER TABLE public.supply_order_lines ENABLE ROW LEVEL SECURITY;
  CREATE POLICY "Authenticated users can view supply order lines"
    ON public.supply_order_lines FOR SELECT TO authenticated
    USING (true);
  CREATE POLICY "Staff can insert supply order lines"
    ON public.supply_order_lines FOR INSERT TO authenticated
    WITH CHECK (public.is_authenticated_active_staff());
  CREATE POLICY "Staff can delete supply order lines"
    ON public.supply_order_lines FOR DELETE TO authenticated
    USING (public.is_authenticated_active_staff());
  GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
  GRANT SELECT, INSERT, DELETE ON public.supply_orders, public.hub_inventory, public.supply_order_lines, public.profiles TO authenticated;
  INSERT INTO public.profiles VALUES ('${STAFF}', 'staff', true), ('${SUPERVISOR}', 'supervisor', true);
  INSERT INTO public.hub_inventory VALUES ('${HUB}');
  INSERT INTO public.supply_orders VALUES
    ('${PENDING}', 'pending'),
    ('${DISPATCHED}', 'dispatched'),
    ('${RECEIVED}', 'received');
  INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity) VALUES
    ('${PENDING}', '${HUB}', 'KT', 2),
    ('${DISPATCHED}', '${HUB}', 'KT', 5),
    ('${RECEIVED}', '${HUB}', 'KT', 3);
`;

const setup = pgliteTemplate(async (db) => {
  await db.exec(ENV);
  await db.exec(MIG);
});

async function asStaff(db: PGlite, sql: string): Promise<boolean> {
  await db.exec(`SET test.uid = '${STAFF}'; SET ROLE authenticated;`);
  try {
    await db.exec(sql);
    return true;
  } catch {
    return false;
  } finally {
    await db.exec('RESET ROLE;');
  }
}

async function lineCount(db: PGlite, orderId: string): Promise<number> {
  const result = await db.query<{ n: number }>(
    `SELECT count(*)::int n FROM public.supply_order_lines WHERE supply_order_id = '${orderId}'`
  );
  return result.rows[0].n;
}

describe('095 supply order lines stay fixed after dispatch', () => {
  it('lets staff add and remove lines only while the order is pending', async () => {
    const db = await setup();

    expect(await asStaff(
      db,
      `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
       VALUES ('${PENDING}', '${HUB}', 'KT', 1)`
    )).toBe(true);
    expect(await lineCount(db, PENDING)).toBe(2);

    expect(await asStaff(
      db,
      `DELETE FROM public.supply_order_lines WHERE supply_order_id = '${PENDING}'`
    )).toBe(true);
    expect(await lineCount(db, PENDING)).toBe(0);

    expect(await asStaff(
      db,
      `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
       VALUES ('${DISPATCHED}', '${HUB}', 'KT', 100)`
    )).toBe(false);
    expect(await asStaff(
      db,
      `DELETE FROM public.supply_order_lines WHERE supply_order_id = '${DISPATCHED}'`
    )).toBe(true);
    expect(await lineCount(db, DISPATCHED)).toBe(1);

    expect(await asStaff(
      db,
      `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
       VALUES ('${RECEIVED}', '${HUB}', 'KT', 100)`
    )).toBe(false);
    await asStaff(db, `DELETE FROM public.supply_order_lines WHERE supply_order_id = '${RECEIVED}'`);
    expect(await lineCount(db, RECEIVED)).toBe(1);
  });

  it('still refuses a supervisor, and the table owner can write a dispatched line', async () => {
    const db = await setup();
    await db.exec(`SET test.uid = '${SUPERVISOR}'; SET ROLE authenticated;`);
    let inserted = true;
    try {
      await db.exec(
        `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
         VALUES ('${PENDING}', '${HUB}', 'KT', 1)`
      );
    } catch {
      inserted = false;
    } finally {
      await db.exec('RESET ROLE;');
    }
    expect(inserted).toBe(false);

    await db.exec(
      `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
       VALUES ('${DISPATCHED}', '${HUB}', 'KT', 4)`
    );
    expect(await lineCount(db, DISPATCHED)).toBe(2);
  });

  it('rollback restores the open staff policies', async () => {
    const db = await setup();
    await db.exec(RB);
    expect(await asStaff(
      db,
      `INSERT INTO public.supply_order_lines (supply_order_id, hub_inventory_id, product_batch, quantity)
       VALUES ('${DISPATCHED}', '${HUB}', 'KT', 9)`
    )).toBe(true);
    expect(await lineCount(db, DISPATCHED)).toBe(2);
  });
});
