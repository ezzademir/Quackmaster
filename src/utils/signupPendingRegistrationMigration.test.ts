import { describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import MIG from '../../supabase/migrations/20261007130000_070_signup_pending_registration_trigger.sql?raw';

const SCHEMA = `
  CREATE SCHEMA auth;
  CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, created_at timestamptz DEFAULT now());
  CREATE TABLE public.profiles (id uuid PRIMARY KEY REFERENCES auth.users(id), full_name text NOT NULL DEFAULT '', role text NOT NULL DEFAULT 'pending');
  CREATE TABLE public.pending_registrations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
    email text NOT NULL, full_name text NOT NULL, requested_at timestamptz DEFAULT now(),
    status text DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')));
  -- live (pre-070) trigger function + trigger
  CREATE FUNCTION public.handle_new_user() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
  BEGIN INSERT INTO public.profiles (id, full_name, role) VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name',''), 'pending') ON CONFLICT (id) DO NOTHING; RETURN NEW; END $$;
  CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
`;
const U = (n: number) => `00000000-0000-0000-0000-00000000000${n}`;

async function setup() {
  const pg = new PGlite();
  await pg.exec(SCHEMA);
  // pre-migration state: hidden pending user, approved user, admin
  await pg.exec(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES
    ('${U(1)}','hidden@x.com','{"full_name":"Hidden"}'),
    ('${U(2)}','ok@x.com','{"full_name":"Ok"}'),
    ('${U(3)}','admin@x.com','{}');
    INSERT INTO public.pending_registrations (user_id,email,full_name,status) VALUES ('${U(2)}','ok@x.com','Ok','approved');
    UPDATE public.profiles SET role='admin' WHERE id='${U(3)}';`);
  await pg.exec(MIG);
  return pg;
}
const regs = async (pg: PGlite) =>
  (await pg.query<{ user_id: string; status: string; email: string; full_name: string }>(
    'select user_id, status, email, full_name from public.pending_registrations order by user_id')).rows;

describe('070 sign-up pending registration trigger', () => {
  it('backfills hidden pending users only; leaves approved and non-pending alone', async () => {
    const pg = await setup();
    expect(await regs(pg)).toEqual([
      { user_id: U(1), status: 'pending', email: 'hidden@x.com', full_name: 'Hidden' },
      { user_id: U(2), status: 'approved', email: 'ok@x.com', full_name: 'Ok' },
    ]);
  });
  it('new auth user gets profile(pending) + pending_registrations(pending) server-side', async () => {
    const pg = await setup();
    await pg.exec(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES ('${U(4)}','new@x.com','{"full_name":"  New  ","role":"admin"}')`);
    const p = (await pg.query<{ role: string; full_name: string }>(`select role, full_name from public.profiles where id='${U(4)}'`)).rows[0];
    expect(p).toEqual({ role: 'pending', full_name: 'New' }); // metadata role ignored
    expect((await regs(pg)).find((r) => r.user_id === U(4))).toMatchObject({ status: 'pending', email: 'new@x.com' });
  });
  it('idempotent: migration re-run and pre-existing rows do not fail or duplicate', async () => {
    const pg = await setup();
    await pg.exec(MIG);
    await pg.exec(`INSERT INTO public.pending_registrations (user_id,email,full_name) SELECT '${U(5)}','x','x' WHERE false`);
    expect(await regs(pg)).toHaveLength(2);
  });
  it('missing metadata name → empty string (NOT NULL satisfied)', async () => {
    const pg = await setup();
    await pg.exec(`INSERT INTO auth.users (id,email,raw_user_meta_data) VALUES ('${U(6)}','n@x.com',NULL)`);
    expect((await regs(pg)).find((r) => r.user_id === U(6))).toMatchObject({ full_name: '', status: 'pending' });
  });
});
