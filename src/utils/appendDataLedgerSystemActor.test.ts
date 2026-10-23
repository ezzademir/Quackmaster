import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import LIVE_PRE086 from '../../supabase/tests/fixtures/append_data_ledger_live_pre086.sql?raw';
import MIG086 from '../../supabase/migrations/20261023183956_086_append_data_ledger_system_actor.sql?raw';

const USER = '00000000-0000-0000-0000-0000000000aa';
const SIG = 'public._append_data_ledger(text, text, text, text, text, text, jsonb, jsonb, jsonb, jsonb)';

async function base(pg: PGlite) {
  await pg.exec(`
    DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN; END IF;
    END $$;
    CREATE SCHEMA auth;
    CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
    INSERT INTO auth.users VALUES ('${USER}', 'staff@example.com');
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT NULLIF(current_setting('test.uid', true), '')::uuid $$;
    CREATE TABLE public.data_ledger (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, user_email text,
      action text, entity_type text, entity_id text, module text, operation text, reference_id text,
      before_data jsonb, after_data jsonb, delta_data jsonb, metadata jsonb, created_at timestamptz DEFAULT now());
  `);
  await pg.exec(LIVE_PRE086);
}

const preDb = pgliteTemplate(base);
const postDb = pgliteTemplate(async (pg) => {
  await base(pg);
  await pg.exec(MIG086);
});

const call = (meta = `'{"k":1}'::jsonb`) =>
  `SELECT public._append_data_ledger('posted','sales_journal','j1','sales','event',NULL,NULL,'{"a":1}'::jsonb,NULL,${meta})`;

async function rows(pg: PGlite) {
  return (await pg.query<Record<string, unknown>>(
    `SELECT user_id, user_email, action, entity_type, entity_id, module, operation, reference_id, before_data, after_data, delta_data, metadata FROM data_ledger ORDER BY created_at`,
  )).rows;
}

async function attrs(pg: PGlite) {
  return (await pg.query<Record<string, unknown>>(`
    SELECT p.prosecdef, p.proconfig, pg_get_userbyid(p.proowner) AS owner, p.prorettype::regtype::text AS ret,
           l.lanname, pg_get_function_arguments(p.oid) AS args,
           has_function_privilege('anon', p.oid, 'EXECUTE') AS anon_x,
           has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_x,
           has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc_x,
           (SELECT count(*) FROM aclexplode(p.proacl) a WHERE a.grantee = 0) AS public_grants
    FROM pg_proc p JOIN pg_language l ON l.oid = p.prolang WHERE p.oid = '${SIG}'::regprocedure`)).rows[0];
}

describe('086 _append_data_ledger system actor', () => {
  it('pre-086 (live) silently writes nothing without a signed-in user — the gap', async () => {
    const pg = await preDb();
    await pg.exec(`SET test.uid = ''; ${call()}`);
    expect(await rows(pg)).toHaveLength(0);
  });

  it('writes a system row when auth.uid() is NULL', async () => {
    const pg = await postDb();
    await pg.exec(`SET test.uid = ''; ${call()}; ${call('NULL')}`);
    const r = await rows(pg);
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ user_id: null, user_email: '', action: 'posted', entity_id: 'j1', metadata: { k: 1, actor: 'system' } });
    expect(r[1].metadata).toEqual({ actor: 'system' });
  });

  it('caller metadata cannot override actor=system for a no-user row', async () => {
    const pg = await postDb();
    await pg.exec(`SET test.uid = ''; ${call(`'{"actor":"someone"}'::jsonb`)}`);
    expect((await rows(pg))[0].metadata).toEqual({ actor: 'system' });
  });

  it('signed-in rows are identical before and after 086', async () => {
    const a = await preDb();
    const b = await postDb();
    for (const pg of [a, b]) await pg.exec(`SET test.uid = '${USER}'; ${call()}; ${call('NULL')}`);
    const ra = await rows(a);
    expect(ra).toHaveLength(2);
    expect(ra[0]).toMatchObject({ user_id: USER, user_email: 'staff@example.com', metadata: { k: 1 } });
    expect(ra[1].metadata).toBeNull();
    expect(await rows(b)).toEqual(ra);
  });

  it('keeps SECURITY DEFINER, search_path, owner, signature and grants exactly as live', async () => {
    const a = await attrs(await preDb());
    const b = await attrs(await postDb());
    expect(b).toEqual(a);
    expect(b).toMatchObject({ prosecdef: true, proconfig: ['search_path=public'], ret: 'void', lanname: 'plpgsql',
      anon_x: false, auth_x: false, svc_x: true, public_grants: 0 });
  });

  it('a ledger failure still only warns and never aborts the caller', async () => {
    const pg = await postDb();
    await pg.exec(`ALTER TABLE data_ledger ADD CONSTRAINT no_posted CHECK (action <> 'posted'); SET test.uid = '';`);
    await expect(pg.exec(call())).resolves.toBeDefined();
    expect(await rows(pg)).toHaveLength(0);
  });
});
