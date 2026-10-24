import { describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { pgliteTemplate } from '../test/pgliteTemplate';
import MIG051 from '../../supabase/migrations/20260514140000_051_supervisor_dashboard_recipes.sql?raw';
import MIG062 from '../../supabase/migrations/20260909150000_062_pack1_auth_lockdown.sql?raw';
import MIG071 from '../../supabase/migrations/20261007140000_071_profiles_deactivate.sql?raw';
import MIG084 from '../../supabase/migrations/20261024100000_084_costing_schema.sql?raw';
import MIG085 from '../../supabase/migrations/20261024100100_085_procurement_role.sql?raw';
import MIG087 from '../../supabase/migrations/20261024100150_087_is_profiles_admin_scope_row_security.sql?raw';
import MIG090 from '../../supabase/migrations/20261024100300_090_profile_role_tag_guards.sql?raw';
import RB085 from '../../supabase/rollbacks/085_rollback.sql?raw';
import BREAK_GLASS from '../../supabase/runbooks/090_break_glass_promote_then_demote.sql?raw';
import RB087 from '../../supabase/rollbacks/087_rollback.sql?raw';
import RB090 from '../../supabase/rollbacks/090_rollback.sql?raw';
import LIVE from './__fixtures__/live_profiles_guard_20261024.sql?raw';

const ADMIN = '00000000-0000-0000-0000-0000000000a1';
const ADMIN2 = '00000000-0000-0000-0000-0000000000a2';
const STAFF = '00000000-0000-0000-0000-0000000000a3';
const BUYER_QT = '00000000-0000-0000-0000-0000000000a4';
const BUYER_MH = '00000000-0000-0000-0000-0000000000a5';
const OUTLET = '00000000-0000-0000-0000-0000000000e1';
const NOBODY = '00000000-0000-0000-0000-0000000000ff';

/* ------------------------------------------------------------------------------------------------------------------
   Fixture: the REAL repo SQL wherever it can run on its own, the verbatim live definitions captured 24 Oct 2026 for the rest.
     051  admin_set_profile_role_and_outlet           (extracted from the migration file; asserted equal to the live body)
     062  trg_profiles_enforce_privileged_columns     (asserted equal to the live trigger)
     071  whole file: profiles_enforce_privileged_columns (live body), admin_apply_user_active (deactivate path)
     084  procurement_tags      085  role constraint + role-list patch + user_entities + is_procurement_user + profiles own-only policy
     087  is_profiles_admin     live fixture: get_users_management_data, _append_data_ledger, profiles policies
   ------------------------------------------------------------------------------------------------------------------ */
const between = (src: string, from: string | RegExp, to: string | RegExp, inclusive = true): string => {
  const a = typeof from === 'string' ? src.indexOf(from) : src.search(from);
  if (a < 0) throw new Error(`fixture: start not found: ${from}`);
  const rest = src.slice(a);
  const m = typeof to === 'string' ? rest.indexOf(to) : rest.search(to);
  if (m < 0) throw new Error(`fixture: end not found: ${to}`);
  const endLen = typeof to === 'string' ? to.length : (rest.match(to) as RegExpMatchArray)[0].length;
  return rest.slice(0, inclusive ? m + endLen : m);
};
const liveSection = (name: string): string => between(LIVE, `-- ===== ${name}\n`, /\n\$function\$;\n/).replace(/^-- =====.*\n/, '');
const LIVE_GUARD = liveSection('profiles_enforce_privileged_columns');
const LIVE_RPC = liveSection('admin_set_profile_role_and_outlet');
const LIVE_GUM = liveSection('get_users_management_data');
const LIVE_LEDGER = liveSection('_append_data_ledger');
const LIVE_TRIGGER = between(LIVE, 'CREATE TRIGGER trg_profiles_enforce_privileged_columns', ';\n');
const defOf = (s: string) => s.replace(/;\s*$/, '').trim();

const RPC_051 = between(MIG051, 'CREATE OR REPLACE FUNCTION public.admin_set_profile_role_and_outlet(', '\n$$;');
const TRIGGER_062 = between(MIG062, 'CREATE TRIGGER trg_profiles_enforce_privileged_columns', ';');
const SQL_084_TAGS = between(MIG084, 'CREATE TABLE IF NOT EXISTS public.procurement_tags (', 'ON CONFLICT (tag) DO NOTHING;');
const SQL_085_USER_ENTITIES = between(MIG085, 'ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_role_check;', 'GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_entities TO authenticated;');
const SQL_085_IS_PROC = between(MIG085, 'CREATE OR REPLACE FUNCTION public.is_procurement_user()', '$$;');
const SQL_085_OWN_ONLY = between(MIG085, 'CREATE POLICY profiles_procurement_own_only ON public.profiles', ';');

const ENV = `
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF;
END $$;
CREATE SCHEMA auth;
GRANT USAGE ON SCHEMA auth, public TO authenticated, anon;
-- session-scoped simulation of the PostgREST claims: test.uid (sub) and test.jwt_role (role claim)
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.uid', true), '')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$ SELECT jsonb_build_object('role', nullif(current_setting('test.jwt_role', true), '')) $$;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text);
CREATE TABLE auth.sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid);
CREATE TABLE auth.refresh_tokens (id bigserial PRIMARY KEY, user_id varchar, session_id uuid);
CREATE TABLE public.profiles (id uuid PRIMARY KEY, full_name text NOT NULL DEFAULT '', role text NOT NULL DEFAULT 'pending',
  password_reset_required boolean DEFAULT false, assigned_outlet_id uuid, created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now(), last_login timestamptz,
  CONSTRAINT profiles_role_check CHECK (role IN ('admin', 'staff', 'pending', 'supervisor')));
CREATE TABLE public.pending_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid, email text, status text,
  full_name text, requested_at timestamptz, created_at timestamptz, reviewed_at timestamptz, reviewed_by uuid, rejection_reason text);
CREATE TABLE public.data_ledger (id bigserial PRIMARY KEY, user_id uuid, user_email text, action text, entity_type text,
  entity_id text, module text, operation text, reference_id text, before_data jsonb, after_data jsonb, delta_data jsonb,
  metadata jsonb, created_at timestamptz DEFAULT now(),
  CONSTRAINT data_ledger_operation_check CHECK (operation = ANY (ARRAY['insert','update','delete','event'])));
ALTER TABLE public.data_ledger ENABLE ROW LEVEL SECURITY;
CREATE TABLE public.recipes (id int PRIMARY KEY, name text);
ALTER TABLE public.recipes ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can update recipes" ON public.recipes FOR UPDATE TO authenticated
  USING (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))));
CREATE POLICY "Admins insert recipes" ON public.recipes FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM profiles p WHERE ((p.id = auth.uid()) AND (p.role = 'admin'::text))));
CREATE FUNCTION public.is_profiles_admin() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;
-- the pre-071 shape 071 patches in place (same stub profilesDeactivateMigration.test.ts uses); replaced by the live body below
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
CREATE TABLE public.procurement_exposure_allow (kind text NOT NULL, name text NOT NULL, note text NOT NULL, PRIMARY KEY (kind, name));
`;

// profiles RLS exactly as live (pg_policies, 24 Oct 2026)
const PROFILES_POLICIES = `
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins can update all profiles" ON public.profiles FOR UPDATE TO authenticated USING (public.is_profiles_admin()) WITH CHECK (public.is_profiles_admin());
CREATE POLICY "Admins can view all profiles" ON public.profiles FOR SELECT TO authenticated USING (public.is_profiles_admin());
CREATE POLICY "Users can insert own profile" ON public.profiles FOR INSERT TO authenticated WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE TO authenticated USING (auth.uid() = id) WITH CHECK (auth.uid() = id);
CREATE POLICY "Users can view own profile" ON public.profiles FOR SELECT TO authenticated USING (auth.uid() = id);
GRANT INSERT, SELECT, UPDATE, DELETE ON public.profiles TO authenticated;
`;

const SEED = `
INSERT INTO auth.users VALUES ('${ADMIN}','admin@x'),('${ADMIN2}','admin2@x'),('${STAFF}','staff@x'),('${BUYER_QT}','qt@x'),('${BUYER_MH}','mh@x');
SET quackmaster.bypass_profile_privilege_guard = 'on';
INSERT INTO public.profiles (id, full_name, role) VALUES ('${ADMIN}','Admin','admin'),('${ADMIN2}','Admin 2','admin'),
  ('${STAFF}','Staff','staff'),('${BUYER_QT}','Buyer QT','procurement'),('${BUYER_MH}','Buyer MH','procurement');
SET quackmaster.bypass_profile_privilege_guard = 'off';
INSERT INTO public.user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','quackteow'), ('${BUYER_MH}','merdeka_house');
`;

const STEPS: [string, string][] = [
  ['ENV', ENV],
  ['071', MIG071],
  ['051 rpc', RPC_051],
  ['live fixture', `${LIVE_GUARD};\n${LIVE_GUM};\n${LIVE_LEDGER};\nREVOKE ALL ON FUNCTION public._append_data_ledger(text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb) FROM PUBLIC, anon, authenticated;`],
  ['062 trigger', `DROP TRIGGER IF EXISTS trg_profiles_enforce_privileged_columns ON public.profiles;\n${TRIGGER_062};`],
  ['084 tags', SQL_084_TAGS],
  ['087', MIG087],
  ['085 pieces', `${SQL_085_USER_ENTITIES}\n${SQL_085_IS_PROC}\n${SQL_085_OWN_ONLY};`],
  ['policies', PROFILES_POLICIES],
  ['grants', `GRANT SELECT ON public.profiles TO anon; GRANT EXECUTE ON FUNCTION public.admin_set_profile_role_and_outlet(uuid,text,uuid) TO authenticated;
              GRANT EXECUTE ON FUNCTION public.get_users_management_data() TO authenticated;`],
  // Supabase default privileges hand new public tables to the client roles in full (incl. TRUNCATE, REFERENCES, TRIGGER); 090 must take them back
  ['default privileges', `GRANT ALL ON public.user_entities TO authenticated, anon;`],
  ['seed', SEED],
  // what the functions looked like BEFORE 090 (compared with the live capture)
  ['pre-090 defs', `CREATE TABLE zz_pre AS SELECT p.proname, pg_get_functiondef(p.oid) AS def FROM pg_proc p
                      WHERE p.pronamespace = 'public'::regnamespace AND p.proname IN ('profiles_enforce_privileged_columns','admin_set_profile_role_and_outlet','get_users_management_data','_append_data_ledger');`],
  ['090', MIG090],
];

const db = pgliteTemplate(async (pg) => {
  for (const [n, sql] of STEPS) {
    try {
      await pg.exec(sql);
    } catch (e) {
      throw new Error(`${n}: ${(e as Error).message}`);
    }
  }
});

/** Run fn as a signed-in client (auth.uid() = uid, role authenticated). uid '' = no uid. */
async function as<T>(pg: PGlite, uid: string, fn: () => Promise<T>, role: 'authenticated' | 'anon' = 'authenticated'): Promise<T> {
  await pg.exec(`SELECT set_config('test.uid', '${uid}', false); SET ROLE ${role};`);
  try {
    return await fn();
  } finally {
    await pg.exec(`RESET ROLE; SELECT set_config('test.uid', '', false);`);
  }
}
const rows = async (pg: PGlite, sql: string) => (await pg.query<Record<string, unknown>>(sql)).rows;
const one = async (pg: PGlite, sql: string) => (await rows(pg, sql))[0];
const err = async (p: Promise<unknown>) => {
  try {
    await p;
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};
const roleOf = async (pg: PGlite, id: string) => String((await one(pg, `select role from profiles where id='${id}'`)).role);
const tagsOf = async (pg: PGlite, id: string) => (await rows(pg, `select procurement_tag t from user_entities where user_id='${id}' order by 1`)).map((r) => r.t);
const ledger = (pg: PGlite, action?: string) =>
  rows(pg, `select action, entity_type, entity_id, module, operation, before_data b, after_data a, metadata m, user_id from data_ledger ${action ? `where action='${action}'` : ''} order by id`);
const setRole = (pg: PGlite, target: string, role: string, outlet = 'NULL') =>
  one(pg, `select admin_set_profile_role_and_outlet('${target}', '${role}', ${outlet}) r`).then((x) => x.r as Record<string, unknown>);
const setTags = (pg: PGlite, target: string, tags: string[]) =>
  one(pg, `select admin_set_procurement_tags('${target}', ARRAY[${tags.map((t) => `'${t}'`).join(',')}]::text[]) r`).then((x) => x.r as Record<string, unknown>);
const asService = async <T>(pg: PGlite, fn: () => Promise<T>) => {
  await pg.exec(`SELECT set_config('test.jwt_role','service_role',false)`);
  try { return await fn(); } finally { await pg.exec(`SELECT set_config('test.jwt_role','',false)`); }
};
const count = async (pg: PGlite) => ((await one(pg, 'select count(*)::int n from user_entities')).n as number);
const GRANT_WRITES = `GRANT INSERT, UPDATE, DELETE ON public.user_entities TO authenticated`;

describe('090 fixture is the real thing', () => {
  it('the 051 RPC, the 062 trigger and the 071 guard equal the live definitions captured read-only on 24 Oct 2026', async () => {
    const pg = await db();
    const pre = Object.fromEntries((await rows(pg, 'select proname, def from zz_pre')).map((r) => [r.proname as string, String(r.def)]));
    expect(defOf(pre.profiles_enforce_privileged_columns)).toBe(defOf(LIVE_GUARD));
    expect(defOf(pre.get_users_management_data)).toBe(defOf(LIVE_GUM));
    expect(defOf(pre._append_data_ledger)).toBe(defOf(LIVE_LEDGER));
    expect(defOf(TRIGGER_062).replace(/\s+/g, ' ')).toBe(defOf(LIVE_TRIGGER).replace(/ ON public\.profiles/, ' ON public.profiles').replace(/\s+/g, ' ').replace('EXECUTE FUNCTION profiles_enforce_privileged_columns()', 'EXECUTE FUNCTION public.profiles_enforce_privileged_columns()'));
  });
  it('051 + the 085 role-list patch gives an RPC that differs from live only by the role list', async () => {
    const pg = await db();
    const pre = String((await one(pg, `select def from zz_pre where proname='admin_set_profile_role_and_outlet'`)).def);
    // zz_pre was taken after 085's DO block patched the RPC; undo the patch and the text equals the live capture
    expect(pre).toContain(`'supervisor', 'procurement'`);
    expect(defOf(pre.replace(`'supervisor', 'procurement'`, `'supervisor'`))).toBe(defOf(LIVE_RPC).replace(/\s+$/, ''));
  });
  it('profiles has exactly the live trigger before 090 and 090 adds its two', async () => {
    const pg = await db();
    expect((await rows(pg, `select tgname from pg_trigger where tgrelid='public.profiles'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname))
      .toEqual(['trg_profiles_enforce_privileged_columns', 'trg_profiles_role_audit', 'trg_profiles_role_guard']);
    expect((await rows(pg, `select tgname from pg_trigger where tgrelid='public.user_entities'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname))
      .toEqual(['trg_user_entities_audit_del', 'trg_user_entities_audit_ins', 'trg_user_entities_audit_upd', 'trg_user_entities_guard']);
  });
});

describe('090 nobody edits their own role or tags (procurement and plain staff), RPC and direct table update', () => {
  for (const [label, actor] of [['procurement', BUYER_QT], ['plain staff', STAFF]] as const) {
    it(`${label}: own role via the RPC is refused`, async () => {
      const pg = await db();
      const before = await roleOf(pg, actor);
      for (const r of ['admin', 'staff', 'procurement', 'supervisor']) {
        const res = await as(pg, actor, () => setRole(pg, actor, r, r === 'supervisor' ? `'${OUTLET}'` : 'NULL'));
        expect(res).toMatchObject({ success: false, error: 'forbidden' });
      }
      expect(await roleOf(pg, actor)).toBe(before);
      expect(await ledger(pg, 'role_changed')).toEqual([]);
    });
    it(`${label}: own tags via the RPC are refused`, async () => {
      const pg = await db();
      const before = await tagsOf(pg, actor);
      const res = await as(pg, actor, () => setTags(pg, actor, ['quackteow', 'merdeka_house']));
      expect(res).toMatchObject({ success: false, error: 'forbidden' });
      expect(await tagsOf(pg, actor)).toEqual(before);
      expect(await ledger(pg, 'tags_changed')).toEqual([]);
    });
    it(`${label}: own role and outlet by direct table update are refused (own-row UPDATE policy exists, the trigger refuses)`, async () => {
      const pg = await db();
      const before = await roleOf(pg, actor);
      for (const set of [`role='admin'`, `role='staff'`, `role='procurement'`, `assigned_outlet_id='${OUTLET}'`, `role='supervisor', assigned_outlet_id='${OUTLET}'`]) {
        if (set === `role='${before}'`) continue;   // writing the role you already have is not a change
        expect(await as(pg, actor, () => err(pg.exec(`UPDATE profiles SET ${set} WHERE id='${actor}'`))), set).toMatch(/cannot change|only an admin|42501/i);
      }
      expect(await roleOf(pg, actor)).toBe(before);
      expect(await one(pg, `select assigned_outlet_id from profiles where id='${actor}'`)).toEqual({ assigned_outlet_id: null });
      expect(await ledger(pg, 'role_changed')).toEqual([]);
    });
    it(`${label}: own tags by direct table write are refused: no write grant, and the trigger refuses even if one is added back`, async () => {
      const pg = await db();
      const before = await tagsOf(pg, actor);
      const writes = [
        `INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${actor}', 'merdeka_house')`,
        `INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${actor}', 'quackteow')`,
        `UPDATE user_entities SET procurement_tag='merdeka_house' WHERE user_id='${actor}'`,
        `DELETE FROM user_entities WHERE user_id='${actor}'`,
      ];
      for (const w of writes) expect(await as(pg, actor, () => err(pg.exec(w))), w).toMatch(/permission denied/i);
      await pg.exec(GRANT_WRITES);                       // defense in depth: a future GRANT must not reopen it
      for (const w of writes.filter((x) => x.startsWith('INSERT'))) expect(await as(pg, actor, () => err(pg.exec(w))), w).toMatch(/only an admin|row-level security|42501/i);
      for (const w of writes.filter((x) => !x.startsWith('INSERT'))) await as(pg, actor, () => err(pg.exec(w)));   // RLS hides other rows: refused or no-op
      expect(await tagsOf(pg, actor)).toEqual(before);
      expect(await ledger(pg, 'tags_changed')).toEqual([]);
    });
    it(`${label}: cannot change another user's role or tags either`, async () => {
      const pg = await db();
      expect(await as(pg, actor, () => setRole(pg, BUYER_MH, 'admin'))).toMatchObject({ success: false, error: 'forbidden' });
      expect(await as(pg, actor, () => setTags(pg, BUYER_MH, ['quackteow']))).toMatchObject({ success: false, error: 'forbidden' });
      await as(pg, actor, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${BUYER_MH}'`)));   // RLS hides the row (no-op) or the trigger refuses
      expect(await roleOf(pg, BUYER_MH)).toBe('procurement');
      expect(await tagsOf(pg, BUYER_MH)).toEqual(['merdeka_house']);
    });
  }
  it('anon cannot call either RPC or write tags', async () => {
    const pg = await db();
    expect(await as(pg, '', () => err(pg.exec(`select admin_set_procurement_tags('${BUYER_QT}', ARRAY['quackteow'])`)), 'anon')).toMatch(/permission denied/i);
    expect(await as(pg, '', () => err(pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','merdeka_house')`)), 'anon')).toMatch(/permission denied/i);
  });
});

describe('090 an admin cannot change their own role or tags either', () => {
  it('RPC: own role and own tags are refused; role unchanged', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => setRole(pg, ADMIN, 'staff'))).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await as(pg, ADMIN, () => setTags(pg, ADMIN, ['quackteow']))).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await roleOf(pg, ADMIN)).toBe('admin');
  });
  it('direct table update of own role / outlet is refused (the gap the old trigger left open for admins), even with another admin present', async () => {
    const pg = await db();
    for (const set of [`role='staff'`, `role='procurement'`, `assigned_outlet_id='${OUTLET}'`]) {
      expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET ${set} WHERE id='${ADMIN}'`))), set).toMatch(/cannot change your own/i);
    }
    expect(await roleOf(pg, ADMIN)).toBe('admin');
  });
  it('direct own tags: no write grant; with one added back the trigger still refuses the admin\'s own row', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${ADMIN}','quackteow')`)))).toMatch(/permission denied/i);
    await pg.exec(GRANT_WRITES);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${ADMIN}','quackteow')`)))).toMatch(/cannot change your own/i);
    expect(await tagsOf(pg, ADMIN)).toEqual([]);
  });
  it('direct tag writes by an admin on someone else: still refused for a non-procurement target, and an admin cannot UPDATE user_id', async () => {
    const pg = await db();
    await pg.exec(GRANT_WRITES);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${STAFF}','quackteow')`)))).toMatch(/only be assigned to a procurement user/i);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE user_entities SET user_id='${STAFF}' WHERE user_id='${BUYER_QT}'`)))).toMatch(/procurement user|user_id cannot be changed/i);
    expect(await tagsOf(pg, STAFF)).toEqual([]);
  });
});

describe('090 admin success and the ledger (old and new values, allowed operations only)', () => {
  it('admin sets a role: one ledger entry with old and new role, the admin as actor', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => setRole(pg, STAFF, 'procurement'))).toMatchObject({ success: true, role: 'procurement' });
    expect(await roleOf(pg, STAFF)).toBe('procurement');
    expect(await ledger(pg, 'role_changed')).toEqual([{
      action: 'role_changed', entity_type: 'profile', entity_id: STAFF, module: 'users', operation: 'update', user_id: ADMIN,
      b: { role: 'staff', assigned_outlet_id: null, tags: [] }, a: { role: 'procurement', assigned_outlet_id: null, tags: [] },
      m: { source: 'profiles_trigger', tags_cleared: [] },
    }]);
  });
  it('supervisor outlet change is ledgered with the old and new outlet', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setRole(pg, STAFF, 'supervisor', `'${OUTLET}'`));
    const l = await ledger(pg, 'role_changed');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ b: { role: 'staff', assigned_outlet_id: null }, a: { role: 'supervisor', assigned_outlet_id: OUTLET } });
  });
  it('tags: admin assigns, replaces and shrinks the set; each change is ledgered with the old and new full tag list; unchanged writes nothing', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setRole(pg, STAFF, 'procurement'));
    expect(await as(pg, ADMIN, () => setTags(pg, STAFF, ['quackteow']))).toMatchObject({ success: true, old_tags: [], tags: ['quackteow'], unchanged: false });
    expect(await as(pg, ADMIN, () => setTags(pg, STAFF, ['merdeka_house', 'quackteow']))).toMatchObject({ success: true, old_tags: ['quackteow'], tags: ['merdeka_house', 'quackteow'] });
    expect(await as(pg, ADMIN, () => setTags(pg, STAFF, ['merdeka_house']))).toMatchObject({ success: true, old_tags: ['merdeka_house', 'quackteow'], tags: ['merdeka_house'] });
    expect(await as(pg, ADMIN, () => setTags(pg, STAFF, ['merdeka_house']))).toMatchObject({ success: true, unchanged: true });
    expect(await tagsOf(pg, STAFF)).toEqual(['merdeka_house']);
    const l = (await ledger(pg, 'tags_changed')).filter((x) => x.entity_id === STAFF);
    expect(l.map((x) => [x.b, x.a, (x.m as { change: string }).change])).toEqual([
      [{ tags: [] }, { tags: ['quackteow'] }, 'added'],
      [{ tags: ['quackteow'] }, { tags: ['merdeka_house', 'quackteow'] }, 'added'],
      [{ tags: ['merdeka_house', 'quackteow'] }, { tags: ['merdeka_house'] }, 'removed'],
    ]);
    expect(l.every((x) => x.operation === 'update' && x.user_id === ADMIN && x.module === 'users')).toBe(true);
  });
  it('the guards also audit the direct-table admin path: role update by an admin on another user', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${BUYER_MH}'`)))).toBeNull();
    const l = await ledger(pg, 'role_changed');
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ entity_id: BUYER_MH, user_id: ADMIN, b: { role: 'procurement', tags: ['merdeka_house'] }, a: { role: 'staff', tags: [] } });
  });
  it('every ledger row written uses an allowed operation (a bad one would be swallowed and lose the row)', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setRole(pg, STAFF, 'procurement'));
    await as(pg, ADMIN, () => setTags(pg, STAFF, ['quackteow', 'merdeka_house']));
    await as(pg, ADMIN, () => setRole(pg, STAFF, 'staff'));
    const ops = (await rows(pg, 'select distinct operation o from data_ledger')).map((r) => r.o);
    expect(ops.length).toBeGreaterThan(0);
    for (const o of ops) expect(['insert', 'update', 'delete', 'event']).toContain(o);
    expect(await one(pg, `select count(*)::int n from data_ledger where action in ('role_changed','tags_changed')`)).toEqual({ n: 4 });
  });
});

describe('090 RPC validation', () => {
  it('tags: not signed in, unknown tag, none, not a procurement user, no such user; names are normalised and de-duplicated', async () => {
    const pg = await db();
    expect(await setTags(pg, BUYER_QT, ['quackteow'])).toMatchObject({ success: false, error: 'unauthenticated' });
    expect(await as(pg, ADMIN, () => setTags(pg, BUYER_QT, ['quackteow', 'nope']))).toMatchObject({ success: false, error: 'unknown_tag', unknown_tags: ['nope'] });
    expect(await as(pg, ADMIN, () => setTags(pg, BUYER_QT, []))).toMatchObject({ success: false, error: 'tags_required' });
    expect(await as(pg, ADMIN, () => one(pg, `select admin_set_procurement_tags('${BUYER_QT}', NULL) r`).then((x) => x.r))).toMatchObject({ success: false, error: 'tags_required' });
    expect(await as(pg, ADMIN, () => setTags(pg, STAFF, ['quackteow']))).toMatchObject({ success: false, error: 'not_procurement' });
    expect(await as(pg, ADMIN, () => setTags(pg, NOBODY, ['quackteow']))).toMatchObject({ success: false, error: 'not_found' });
    expect(await as(pg, ADMIN, () => setTags(pg, BUYER_QT, [' QuackTeow ', 'quackteow', 'MERDEKA_HOUSE']))).toMatchObject({ success: true, tags: ['merdeka_house', 'quackteow'] });
    expect(await tagsOf(pg, BUYER_QT)).toEqual(['merdeka_house', 'quackteow']);
  });
  it('a procurement user with no tag can exist (role first, tags second) and sees nothing', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setRole(pg, STAFF, 'procurement'));
    expect(await tagsOf(pg, STAFF)).toEqual([]);
  });
  it('get_users_management_data returns entity_tags for each user to an admin and nothing to anyone else', async () => {
    const pg = await db();
    const d = await as(pg, ADMIN, () => one(pg, 'select get_users_management_data() d')).then((x) => x.d as { approved: { id: string; entity_tags: string[]; is_active: boolean }[] });
    const by = Object.fromEntries(d.approved.map((u) => [u.id, u]));
    expect(by[BUYER_QT].entity_tags).toEqual(['quackteow']);
    expect(by[BUYER_MH].entity_tags).toEqual(['merdeka_house']);
    expect(by[STAFF].entity_tags).toEqual([]);
    expect(by[ADMIN].is_active).toBe(true);            // the rest of the live shape is untouched
    for (const uid of [STAFF, BUYER_QT]) {
      expect(await as(pg, uid, () => one(pg, 'select get_users_management_data() d'))).toEqual({ d: expect.objectContaining({ error: 'forbidden' }) });
    }
  });
});

describe('090 leaving procurement clears the tags, ledgered with old and new values', () => {
  it('RPC: procurement -> staff clears a two-tag set; removals and the role change are all ledgered', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setTags(pg, BUYER_QT, ['quackteow', 'merdeka_house']));
    await pg.exec('DELETE FROM data_ledger');
    expect(await as(pg, ADMIN, () => setRole(pg, BUYER_QT, 'staff'))).toMatchObject({ success: true });
    expect(await tagsOf(pg, BUYER_QT)).toEqual([]);
    const t = await ledger(pg, 'tags_changed');
    expect(t).toHaveLength(1);       // one statement, one entry per user, with the exact list before and after
    expect(t[0]).toMatchObject({ b: { tags: ['merdeka_house', 'quackteow'] }, a: { tags: [] }, user_id: ADMIN,
      m: { change: 'removed', tags_removed: ['merdeka_house', 'quackteow'], tags_added: [] } });
    const r = await ledger(pg, 'role_changed');
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ b: { role: 'procurement', tags: ['merdeka_house', 'quackteow'] }, a: { role: 'staff', tags: [] }, m: { tags_cleared: ['merdeka_house', 'quackteow'] } });
  });
  it('direct admin table update to supervisor clears too; an outlet change that stays procurement does not', async () => {
    const pg = await db();
    await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET assigned_outlet_id='${OUTLET}' WHERE id='${BUYER_MH}'`)));
    expect(await tagsOf(pg, BUYER_MH)).toEqual(['merdeka_house']);
    await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET role='supervisor' WHERE id='${BUYER_MH}'`)));
    expect(await tagsOf(pg, BUYER_MH)).toEqual([]);
    expect((await ledger(pg, 'tags_changed')).filter((x) => x.entity_id === BUYER_MH)).toHaveLength(1);
  });
  it('a service-role role change clears and ledgers as the system actor', async () => {
    const pg = await db();
    await asService(pg, () => pg.exec(`UPDATE profiles SET role='pending' WHERE id='${BUYER_QT}'`));
    expect(await tagsOf(pg, BUYER_QT)).toEqual([]);
    const t = await ledger(pg, 'tags_changed');
    expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ user_id: null, b: { tags: ['quackteow'] }, a: { tags: [] }, m: { change: 'removed' } });
  });
});

describe('090 the last active admin cannot be demoted, deactivated or removed (no lock-out)', () => {
  const apply = (pg: PGlite, actor: string, target: string, active: boolean) =>
    one(pg, `select public.admin_apply_user_active('${actor}','${target}',${active},'test') r`).then((x) => x.r as Record<string, unknown>);
  const bypass = (pg: PGlite, sql: string) => pg.exec(`SET quackmaster.bypass_profile_privilege_guard='on'; ${sql}; SET quackmaster.bypass_profile_privilege_guard='off';`);

  it('two admins: one may demote the other through the RPC; then the remaining one is protected on every path', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => setRole(pg, ADMIN2, 'staff'))).toMatchObject({ success: true });
    // ADMIN is now the only active admin
    expect(await as(pg, ADMIN, () => setRole(pg, ADMIN, 'staff'))).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`)))).toMatch(/cannot change your own|last_active_admin/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`)))).toMatch(/last_active_admin/);
    // service role / owner direct writes (no uid): the last-admin rule is not skipped
    for (const sql of [`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`, `UPDATE profiles SET role='pending' WHERE id='${ADMIN}'`,
      `UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`, `DELETE FROM profiles WHERE id='${ADMIN}'`]) {
      expect(await asService(pg, () => err(pg.exec(sql))), sql).toMatch(/last_active_admin/);
      expect(await err(bypass(pg, sql)), `bypass flag: ${sql}`).toMatch(/last_active_admin/);
    }
    expect(await roleOf(pg, ADMIN)).toBe('admin');
    expect(await one(pg, `select is_active from profiles where id='${ADMIN}'`)).toEqual({ is_active: true });
  });
  it('via deactivate: an admin deactivates the other admin (allowed), then nobody can deactivate the one left', async () => {
    const pg = await db();
    expect(await apply(pg, ADMIN, ADMIN2, false)).toMatchObject({ success: true });
    expect(await apply(pg, ADMIN2, ADMIN, false)).toMatchObject({ success: false, error: 'forbidden' });   // inactive admin cannot act
    expect(await apply(pg, ADMIN, ADMIN, false)).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET is_active=false, deactivated_at=now() WHERE id='${ADMIN}'`)))).toMatch(/last_active_admin/);
    expect(await one(pg, `select is_active from profiles where id='${ADMIN}'`)).toEqual({ is_active: true });
  });
  it('the 071 RPC counts inactive admins as admins; the trigger counts only ACTIVE ones, so an inactive admin cannot make a demotion look safe', async () => {
    const pg = await db();
    await apply(pg, ADMIN, ADMIN2, false);            // ADMIN2 is an inactive admin
    // the RPC's own check (role = 'admin', any state) would let this through; the trigger refuses
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`)))).toMatch(/last_active_admin/);
    expect(await roleOf(pg, ADMIN)).toBe('admin');
  });
  it('reactivating restores the freedom to demote; a non-last admin can be demoted or deactivated directly', async () => {
    const pg = await db();
    await apply(pg, ADMIN, ADMIN2, false);
    await apply(pg, ADMIN, ADMIN2, true);
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await one(pg, `select is_active from profiles where id='${ADMIN}'`)).toEqual({ is_active: false });
  });
});

describe('090 H1: user_entities grants (REVOKE ALL, then SELECT only)', () => {
  const priv = async (pg: PGlite, role: string) => Object.fromEntries(await Promise.all(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'].map(async (p) =>
    [p, (await one(pg, `select has_table_privilege('${role}','public.user_entities','${p}') b`)).b])));
  it('the fixture starts with Supabase-style default privileges (so the test can see a partial revoke)', async () => {
    const pg = await db();
    await pg.exec(`CREATE TABLE zz_probe (x int); GRANT ALL ON zz_probe TO authenticated`);
    expect(await one(pg, `select has_table_privilege('authenticated','zz_probe','TRUNCATE') b`)).toEqual({ b: true });
    // the pre-090 snapshot kept in the template: re-granting ALL and re-applying 090 ends at SELECT only
    await pg.exec(`GRANT ALL ON public.user_entities TO authenticated, anon, PUBLIC`);
    expect((await priv(pg, 'authenticated')).TRUNCATE).toBe(true);
    await pg.exec(MIG090);
    expect((await priv(pg, 'authenticated')).TRUNCATE).toBe(false);
  });
  it('after 090 authenticated holds SELECT and nothing else; anon and PUBLIC hold nothing (no TRUNCATE, REFERENCES or TRIGGER either)', async () => {
    const pg = await db();
    expect(await priv(pg, 'authenticated')).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
    expect(Object.values(await priv(pg, 'anon')).some(Boolean)).toBe(false);
    expect(await rows(pg, `select a.grantee::regrole::text g, a.privilege_type p from pg_class c, aclexplode(c.relacl) a where c.oid='public.user_entities'::regclass and a.grantee = 0`)).toEqual([]);
  });
  it('a signed-in client cannot TRUNCATE the table, and it is still there with its rows afterwards', async () => {
    const pg = await db();
    for (const uid of [ADMIN, BUYER_QT, STAFF]) {
      expect(await as(pg, uid, () => err(pg.exec('TRUNCATE public.user_entities')))).toMatch(/permission denied/);
    }
    expect(await as(pg, ADMIN, () => err(pg.exec('TRUNCATE public.user_entities')), 'authenticated')).not.toBeNull();
    expect(await count(pg)).toBe(2);
  });
  it('the 090 text states REVOKE ALL (PUBLIC, anon, authenticated) then GRANT SELECT, and no INSERT/UPDATE/DELETE grant', () => {
    expect(MIG090).toMatch(/REVOKE ALL ON public\.user_entities FROM PUBLIC, anon, authenticated;\s*GRANT SELECT ON public\.user_entities TO authenticated;/);
    expect(MIG090).not.toMatch(/GRANT (INSERT|UPDATE|DELETE|ALL|TRUNCATE)[^;]*user_entities/i);
  });
  it('the rollback gives back 085\'s explicit write grants but not TRUNCATE/REFERENCES/TRIGGER', async () => {
    const pg = await db();
    await pg.exec(RB090);
    expect(await priv(pg, 'authenticated')).toEqual({ SELECT: true, INSERT: true, UPDATE: true, DELETE: true, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
  });
});

describe('090 H2: a failed ledger insert rolls the change back (fail closed); the shared helper is untouched', () => {
  const BREAK = `ALTER TABLE data_ledger ADD CONSTRAINT zz_ledger_down CHECK (action NOT IN ('role_changed','tags_changed')) NOT VALID`;
  const snapshot = async (pg: PGlite) => ({
    roles: await rows(pg, `select id, role, assigned_outlet_id from profiles order by id`),
    tags: await rows(pg, `select user_id, procurement_tag from user_entities order by 1, 2`),
    ledger: await count2(pg),
  });
  const count2 = async (pg: PGlite) => (await one(pg, `select count(*)::int n from data_ledger`)).n as number;

  it('the role RPC, a direct admin update and a service-role update all fail and change nothing when the ledger insert fails', async () => {
    const pg = await db();
    await pg.exec(BREAK);
    const before = await snapshot(pg);
    expect(await as(pg, ADMIN, () => err(setRole(pg, STAFF, 'admin')))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET role='supervisor', assigned_outlet_id='${OUTLET}' WHERE id='${STAFF}'`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${STAFF}'`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await snapshot(pg)).toEqual(before);
  });
  it('admin_set_procurement_tags (add, replace, shrink) fails and changes nothing when the ledger insert fails', async () => {
    const pg = await db();
    await pg.exec(BREAK);
    const before = await snapshot(pg);
    for (const tags of [['quackteow', 'merdeka_house'], ['merdeka_house']]) {   // add one / replace (an unchanged set writes nothing)
      expect(await as(pg, ADMIN, () => err(setTags(pg, BUYER_QT, tags))), tags.join()).toMatch(/zz_ledger_down|data_ledger/);
    }
    expect(await snapshot(pg)).toEqual(before);
    expect(await tagsOf(pg, BUYER_QT)).toEqual(['quackteow']);
  });
  it('direct admin writes to user_entities, and clearing tags by moving a user away from procurement, roll back too', async () => {
    const pg = await db();
    await pg.exec(BREAK);
    const before = await snapshot(pg);
    expect(await as(pg, ADMIN, () => err(pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`)))).toMatch(/permission denied/);   // no client write grant (H1); the next lines re-add it to reach the trigger
    await pg.exec(GRANT_WRITES);
    expect(await as(pg, ADMIN, () => err(pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await as(pg, ADMIN, () => err(pg.exec(`INSERT INTO user_entities (user_id, procurement_tag) VALUES ('${BUYER_QT}','merdeka_house')`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await as(pg, ADMIN, () => err(setRole(pg, BUYER_QT, 'staff')))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${BUYER_MH}'`)))).toMatch(/zz_ledger_down|data_ledger/);
    expect(await snapshot(pg)).toEqual(before);
    expect(await roleOf(pg, BUYER_QT)).toBe('procurement');
    expect(await tagsOf(pg, BUYER_MH)).toEqual(['merdeka_house']);
  });
  it('with the ledger healthy the same calls succeed (the breakage above is what stops them)', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => setTags(pg, BUYER_QT, ['quackteow', 'merdeka_house']))).toMatchObject({ success: true });
    expect(await as(pg, ADMIN, () => setRole(pg, STAFF, 'admin'))).toMatchObject({ success: true });
    expect((await ledger(pg)).map((x) => x.entity_id).sort()).toEqual([BUYER_QT, STAFF].sort());
  });
  it('the shared _append_data_ledger is untouched (still the verbatim live definition that swallows a failure) and 090 audit paths do not call it', async () => {
    const pg = await db();
    const d = String((await one(pg, `select pg_get_functiondef('public._append_data_ledger(text,text,text,text,text,text,jsonb,jsonb,jsonb,jsonb)'::regprocedure) d`)).d);
    expect(defOf(d)).toBe(defOf(LIVE_LEDGER));
    expect(MIG090).not.toMatch(/PERFORM public\._append_data_ledger/);
    expect(MIG090.match(/INSERT INTO public\.data_ledger/g)?.length).toBe(3);   // role/outlet, tags, direct is_active
    expect(MIG090).toMatch(/Ledger \(fail closed\)/);
  });
});

describe('090 hardening: pg_temp last, 087 pre-check, whole-function overwrite documented', () => {
  it('every new SECURITY DEFINER function pins search_path = public, pg_temp (pg_temp last)', async () => {
    const pg = await db();
    const fns = ['profiles_guard_role_change', 'profiles_audit_role_change', 'user_entities_guard_write', 'user_entities_audit_write', 'admin_set_procurement_tags'];
    const got = await rows(pg, `select proname, prosecdef, proconfig from pg_proc where pronamespace='public'::regnamespace and proname = any(array[${fns.map((f) => `'${f}'`).join(',')}]) order by 1`);
    expect(got.map((g) => g.proname)).toEqual([...fns].sort());
    for (const g of got) {
      expect(g.prosecdef, String(g.proname)).toBe(true);
      expect(g.proconfig, String(g.proname)).toEqual(['search_path=public, pg_temp']);
    }
    expect(MIG090.match(/SET search_path = public AS/g)).toBeNull();
  });
  it('090 refuses to apply when 087 is not applied (is_profiles_admin without SET row_security = off), and applies once 087 is back', async () => {
    const pg = await db();
    await pg.exec(RB090);
    await pg.exec(RB087);                       // the live (pre-087) is_profiles_admin
    expect(await err(pg.exec(MIG090))).toMatch(/090 depends on 087/);
    await pg.exec(MIG087);
    expect(await err(pg.exec(MIG090))).toBeNull();
  });
  it('the 087 check is the first thing after the 085 check: nothing was created by the refused run', async () => {
    const pg = await db();
    await pg.exec(RB090);
    await pg.exec(RB087);
    await err(pg.exec(MIG090));
    expect((await rows(pg, `select proname from pg_proc where proname in ('profiles_guard_role_change','admin_set_procurement_tags')`)).length).toBe(0);
  });
  it('the headers say 090_rollback overwrites get_users_management_data whole, and that 090 needs 087', () => {
    expect(RB090).toMatch(/OVERWRITES get_users_management_data\(\) WHOLE/);
    expect(RB090).toMatch(/does not reverse the 090 patch/);
    expect(MIG090.slice(0, MIG090.indexOf('*/'))).toMatch(/OVERWRITING THE WHOLE FUNCTION/);
    expect(MIG090.slice(0, MIG090.indexOf('*/'))).toMatch(/087 \(is_profiles_admin\)/);
  });
});

describe('085_rollback refuses to run while 090 is live', () => {
  it('raises with an instruction to run 090_rollback first, and changes nothing', async () => {
    const pg = await db();
    const before = await one(pg, `select (select count(*) from pg_proc where pronamespace='public'::regnamespace)::int f, (select count(*) from pg_trigger where not tgisinternal)::int t, to_regclass('public.user_entities') is not null ue`);
    const msg = await err(pg.exec(RB085));
    expect(msg).toMatch(/085_rollback refused: migration 090 is still live/);
    expect(msg).toMatch(/090_rollback\.sql first/);
    const after = await one(pg, `select (select count(*) from pg_proc where pronamespace='public'::regnamespace)::int f, (select count(*) from pg_trigger where not tgisinternal)::int t, to_regclass('public.user_entities') is not null ue`);
    expect(after).toEqual(before);
    expect(after.ue).toBe(true);
  });
  it('refuses when only part of 090 remains (any one 090 function is enough)', async () => {
    const pg = await db();
    await pg.exec('DROP FUNCTION public.admin_set_procurement_tags(uuid, text[]);');
    expect(await err(pg.exec(RB085))).toMatch(/refused/);
  });
  it('after 090_rollback the guard stays silent (this fixture has no purchase_orders, so the rest of 085_rollback is exercised by costingProcurementMigration.test.ts)', async () => {
    const pg = await db();
    await pg.exec(RB090);
    expect(String(await err(pg.exec(RB085)))).not.toMatch(/085_rollback refused/);
  });
  it('the guard is the first statement after the header comments, and the header says so', () => {
    const body = RB085.split('\n').filter((l) => !l.startsWith('--')).join('\n').trimStart();
    expect(body.startsWith('DO $$ BEGIN')).toBe(true);
    expect(body.slice(0, 700)).toMatch(/migration 090 is still live/);
    expect(RB085).toMatch(/GUARD: refuses to run while 090 is live/);
  });
});

describe('090 break-glass: lost or locked only admin (rollback, then promote, then re-apply)', () => {
  const only = async () => {
    const pg = await db();
    await as(pg, ADMIN, () => setRole(pg, ADMIN2, 'staff'));      // ADMIN is now the only active admin; assume nobody can sign in as them
    return pg;
  };
  const triggers = async (pg: PGlite, tbl: string) => (await rows(pg, `select tgname from pg_trigger where tgrelid='public.${tbl}'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname);
  const activeAdmins = async (pg: PGlite) => ((await one(pg, `select count(*)::int n from profiles where role='admin' and is_active`)).n as number);
  it('with 090 live the lost only admin cannot be demoted, deactivated or deleted by anyone, service_role included', async () => {
    const pg = await only();
    for (const sql of [`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`, `UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`, `DELETE FROM profiles WHERE id='${ADMIN}'`]) {
      expect(await asService(pg, () => err(pg.exec(sql))), sql).toMatch(/last_active_admin/);
    }
    expect(await activeAdmins(pg)).toBe(1);
  });
  it('rollback 090, then promote the replacement and demote the lost account as service_role: works, with the 062/071 guard still in place and no trigger dropped', async () => {
    const pg = await only();
    const triggersBefore = await triggers(pg, 'profiles');
    await pg.exec(RB090);
    expect(await triggers(pg, 'profiles')).toEqual(['trg_profiles_enforce_privileged_columns']);
    expect(await asService(pg, () => err(pg.exec(`BEGIN; UPDATE profiles SET role='admin' WHERE id='${STAFF}'; UPDATE profiles SET role='staff', is_active=false, deactivated_at=now() WHERE id='${ADMIN}'; COMMIT;`)))).toBeNull();
    expect(await roleOf(pg, STAFF)).toBe('admin');
    expect(await roleOf(pg, ADMIN)).toBe('staff');
    expect(await activeAdmins(pg)).toBe(1);
    // the untouched 062/071 protection still holds: a non-admin signed-in user cannot promote themselves
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${BUYER_QT}'`)))).toMatch(/cannot change/);
    // re-apply: the guard is back, the new admin is the protected last one, and the audit works again
    expect(await err(pg.exec(MIG090))).toBeNull();
    expect(await triggers(pg, 'profiles')).toEqual(triggersBefore);
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${STAFF}'`)))).toMatch(/last_active_admin/);
    expect(await as(pg, STAFF, () => setRole(pg, BUYER_MH, 'staff'))).toMatchObject({ success: true });
    expect((await ledger(pg, 'role_changed')).length).toBeGreaterThanOrEqual(2);
  });
  it('the role changes made while 090 is off are not ledgered (the runbook says to record them by hand)', async () => {
    const pg = await only();
    await pg.exec(RB090);
    await pg.exec('DELETE FROM data_ledger');
    await asService(pg, () => pg.exec(`UPDATE profiles SET role='admin' WHERE id='${STAFF}'`));
    expect(await ledger(pg, 'role_changed')).toEqual([]);
  });
  it('a service_role promote of a replacement is already allowed with 090 live (then the lost admin can be demoted without any rollback)', async () => {
    const pg = await only();
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${STAFF}'`)))).toBeNull();
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await activeAdmins(pg)).toBe(1);
  });
  const NIL = '00000000-0000-0000-0000-000000000000';
  const snippet = (replacement: string, lost: string) => BREAK_GLASS.replace(NIL, replacement).replace(NIL, lost);
  // psql -v ON_ERROR_STOP=1 / the SQL editor end the session on a failed batch, which rolls the open transaction back; the test does that explicitly
  const run = async (pg: PGlite, sql: string) => { const e = await err(pg.exec(sql)); if (e) await pg.exec('ROLLBACK'); return e; };
  const admins = async (pg: PGlite) => (await rows(pg, `select id from profiles where role='admin' and is_active order by id`)).map((r) => r.id);

  it('PRIMARY path (090 live, no rollback): the copy-paste snippet promotes the replacement, demotes+deactivates the lost admin, and every step is ledgered', async () => {
    const pg = await only();
    await pg.exec('DELETE FROM data_ledger');
    expect(await run(pg, snippet(STAFF, ADMIN))).toBeNull();
    expect(await admins(pg)).toEqual([STAFF]);
    expect(await roleOf(pg, ADMIN)).toBe('staff');
    expect(await one(pg, `select is_active a from profiles where id='${ADMIN}'`)).toEqual({ a: false });
    expect((await ledger(pg)).map((x) => `${x.action}:${x.entity_id}:${x.user_id}:${(x.m as Record<string, unknown>).actor}`).sort()).toEqual(
      [`role_changed:${STAFF}:null:system`, `role_changed:${ADMIN}:null:system`, `deactivated:${ADMIN}:null:system`].sort());
    // 090 stays live: the new admin is now the protected last one
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${STAFF}'`)))).toMatch(/last_active_admin/);
    expect(await triggers(pg, 'profiles')).toEqual(['trg_profiles_enforce_privileged_columns', 'trg_profiles_role_audit', 'trg_profiles_role_guard']);
  });
  it('the snippet ends its transaction cleanly (the service_role claim does not outlive it)', async () => {
    const pg = await only();
    await run(pg, snippet(STAFF, ADMIN));
    expect(await one(pg, `select coalesce(current_setting('request.jwt.claim.role', true), '') r`)).toEqual({ r: '' });
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${BUYER_QT}'`)))).toMatch(/cannot change|only an admin/);
  });
  it('a typo in the replacement id changes NOTHING (zero admins is impossible): the lost admin stays admin and active', async () => {
    const pg = await only();
    await pg.exec('DELETE FROM data_ledger');
    const typo = '00000000-0000-0000-0000-0000000000ee';
    expect(await run(pg, snippet(typo, ADMIN))).toMatch(/replacement .* must exist/);
    expect(await admins(pg)).toEqual([ADMIN]);
    expect(await ledger(pg)).toEqual([]);
    expect(await one(pg, `select coalesce(current_setting('request.jwt.claim.role', true), '') r`)).toEqual({ r: '' });
  });
  it('refuses a procurement or pending replacement, a lost id that is not an admin, equal ids, and the untouched placeholders', async () => {
    const pg = await only();
    expect(await run(pg, snippet(BUYER_QT, ADMIN))).toMatch(/not procurement, not pending|must exist, be active/);
    expect(await run(pg, snippet(STAFF, STAFF))).toMatch(/set two different real profile ids|must exist and currently be an admin/);
    expect(await run(pg, snippet(STAFF, ADMIN2))).toMatch(/must exist and currently be an admin/);   // ADMIN2 was demoted by the fixture helper
    expect(await run(pg, BREAK_GLASS)).toMatch(/set two different real profile ids/);
    expect(await admins(pg)).toEqual([ADMIN]);
    expect(await roleOf(pg, BUYER_QT)).toBe('procurement');
  });
  it('an inactive replacement is refused', async () => {
    const pg = await only();
    await asService(pg, () => pg.exec(`UPDATE profiles SET is_active=false WHERE id='${STAFF}'`));
    expect(await run(pg, snippet(STAFF, ADMIN))).toMatch(/must exist, be active/);
    expect(await admins(pg)).toEqual([ADMIN]);
  });
  it('the post-condition is the safety net with 090 OFF (no last-admin guard): a failing check aborts the whole thing; the same file still works', async () => {
    const pg = await only();
    await pg.exec(RB090);
    await pg.exec('DELETE FROM data_ledger');
    // sabotage: a trigger that stops the promote from sticking would leave zero admins; the in-transaction check must abort the demotion too
    await pg.exec(`CREATE FUNCTION zz_undo() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.role='admin' AND OLD.role<>'admin' THEN NEW.role := OLD.role; END IF; RETURN NEW; END $$;
      CREATE TRIGGER zz_undo BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION zz_undo();`);
    expect(await run(pg, snippet(STAFF, ADMIN))).toMatch(/no active admin would remain/);
    expect(await admins(pg)).toEqual([ADMIN]);
    await pg.exec('DROP TRIGGER zz_undo ON profiles');
    expect(await run(pg, snippet(STAFF, ADMIN))).toBeNull();
    expect(await admins(pg)).toEqual([STAFF]);
    expect(await ledger(pg, 'role_changed')).toEqual([]);                  // 090 is off: no ledger, hence the hand-written rows
  });
  it('the hand-written ledger row from the rollback header is accepted by data_ledger', async () => {
    const pg = await only();
    const tpl = RB090.split('\n').filter((l) => /^--\s+(INSERT INTO|VALUES|jsonb_build_object)/.test(l)).map((l) => l.replace(/^-- ?/, '')).join('\n');
    const sql = tpl.replace(/<profile id>/g, STAFF).replace('<old>', 'staff').replace('<new>', 'admin').replace('<who / why>', 'break-glass test').replace(/--.*$/gm, '');
    await pg.exec('DELETE FROM data_ledger');
    expect(await err(pg.exec(sql))).toBeNull();
    expect(await ledger(pg)).toMatchObject([{ action: 'role_changed', entity_id: STAFF, operation: 'update', m: { source: 'break_glass_manual' } }]);
  });
  it('the wording: PRIMARY = promote then demote with 090 live, rollback = FALLBACK ONLY, only on Ezzad\'s word, no trigger drop, hand-written ledger rows, one batch', () => {
    const head = MIG090.slice(0, MIG090.indexOf('*/'));
    expect(head).toMatch(/BREAK-GLASS/);
    expect(head).toMatch(/ONLY on Ezzad's explicit word/);
    expect(head).toMatch(/never improvise a\s+trigger drop/);
    expect(head).toMatch(/PRIMARY path, with 090 STILL LIVE[\s\S]*no rollback[\s\S]*FALLBACK ONLY[\s\S]*090_rollback\.sql[\s\S]*re-apply this file/);
    expect(head).toMatch(/ABORTS EVERYTHING/);
    expect(head).toMatch(/at least one active admin remains/);
    expect(head).toMatch(/NO last-admin guard and NO ledger/);
    expect(head).toMatch(/write the ledger rows by hand/);
    expect(head).toMatch(/psql -v ON_ERROR_STOP=1/);
    expect(head).not.toMatch(/Recovery means deliberately dropping the trigger/);
    expect(RB090).toMatch(/FALLBACK ONLY[\s\S]*PRIMARY path needs NO rollback[\s\S]*ONLY on Ezzad's explicit word, no trigger drop[\s\S]*WRITE THE LEDGER ROWS BY HAND/);
    expect(RB090).toMatch(/RUN AS ONE BATCH/);
    expect(BREAK_GLASS).toMatch(/ONLY on Ezzad's explicit word/);
    expect(BREAK_GLASS).toMatch(/ONE batch/);
    expect(BREAK_GLASS).toMatch(/RAISE EXCEPTION 'break-glass: no active admin would remain; nothing was changed'/);
  });
});

describe('090 H10: no admin deactivates their own row (any path); another admin still can; direct changes are ledgered fail-closed', () => {
  const apply = (pg: PGlite, actor: string, target: string, active: boolean) =>
    one(pg, `select public.admin_apply_user_active('${actor}','${target}',${active},'test') r`).then((x) => x.r as Record<string, unknown>);
  const active = async (pg: PGlite, id: string) => (await one(pg, `select is_active a from profiles where id='${id}'`)).a;

  it('(a) with two admins, a direct UPDATE deactivating your own row is refused (and leaves nothing behind)', async () => {
    const pg = await db();
    await pg.exec('DELETE FROM data_ledger');
    for (const sql of [`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`, `UPDATE profiles SET is_active=false, deactivated_at=now(), deactivated_by='${ADMIN}' WHERE id='${ADMIN}'`]) {
      expect(await as(pg, ADMIN, () => err(pg.exec(sql))), sql).toMatch(/cannot deactivate your own account/);
    }
    expect(await active(pg, ADMIN)).toBe(true);
    expect(await ledger(pg)).toEqual([]);
  });
  it('(a) the bypass flag does not skip it, and neither does the RPC path (own id)', async () => {
    const pg = await db();
    const sql = `SET quackmaster.bypass_profile_privilege_guard='on'; UPDATE profiles SET is_active=false WHERE id='${ADMIN}'; SET quackmaster.bypass_profile_privilege_guard='off'`;
    expect(await as(pg, ADMIN, () => err(pg.exec(sql)))).toMatch(/cannot deactivate your own account/);
    await pg.exec(`SET quackmaster.bypass_profile_privilege_guard='off'`);
    expect(await apply(pg, ADMIN, ADMIN, false)).toMatchObject({ success: false, error: 'invalid_target' });
    expect(await active(pg, ADMIN)).toBe(true);
  });
  it('(a) multi-row UPDATE containing your own row is refused as a whole', async () => {
    const pg = await db();
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id in ('${ADMIN}','${STAFF}')`)))).toMatch(/cannot deactivate your own account/);
    expect(await active(pg, STAFF)).toBe(true);
  });
  it('(b) another admin deactivating that admin still works, directly and through the RPC, and the direct change is ledgered', async () => {
    const pg = await db();
    await pg.exec('DELETE FROM data_ledger');
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE profiles SET is_active=false, deactivated_at=now() WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await active(pg, ADMIN)).toBe(false);
    const l = await ledger(pg, 'deactivated');
    expect(l.length).toBe(1);
    expect(l[0]).toMatchObject({ entity_type: 'profile', entity_id: ADMIN, module: 'users', operation: 'update', user_id: ADMIN2, b: { is_active: true }, a: { is_active: false }, m: { source: 'profiles_trigger' } });
    await asService(pg, () => pg.exec(`UPDATE profiles SET is_active=true, deactivated_at=null WHERE id='${ADMIN}'`));   // service_role maintenance, then the RPC path
    await pg.exec('DELETE FROM data_ledger');
    expect(await apply(pg, ADMIN2, ADMIN, false)).toMatchObject({ success: true });
    const r = await ledger(pg, 'deactivated');
    expect(r.length).toBe(1);                                               // the RPC writes its own row; the trigger does not double it
    expect(r[0].m).toMatchObject({ source: 'admin_set_user_active' });
  });
  it('a non-admin cannot deactivate anyone, and the last-admin guard still comes first for the sole admin', async () => {
    const pg = await db();
    expect(await as(pg, STAFF, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${STAFF}'`)))).toMatch(/cannot change|privileged|only an admin|permission/i);
    expect(await active(pg, STAFF)).toBe(true);
    await as(pg, ADMIN, () => setRole(pg, ADMIN2, 'staff'));
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`)))).toMatch(/last_active_admin/);
  });
  it('service_role maintenance is unchanged: it can deactivate and reactivate a non-last admin (ledgered as system)', async () => {
    const pg = await db();
    await pg.exec('DELETE FROM data_ledger');
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN2}'`)))).toBeNull();
    expect(await asService(pg, () => err(pg.exec(`UPDATE profiles SET is_active=true WHERE id='${ADMIN2}'`)))).toBeNull();
    expect((await ledger(pg)).map((x) => [x.action, x.user_id, x.m])).toEqual([
      ['deactivated', null, { source: 'profiles_trigger', actor: 'system' }],
      ['reactivated', null, { source: 'profiles_trigger', actor: 'system' }]]);
  });
  it('signup, last_login / full_name updates and other non-role/non-active updates write nothing and are not blocked', async () => {
    const pg = await db();
    await pg.exec('DELETE FROM data_ledger');
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET last_login=now(), full_name='A' WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await as(pg, STAFF, () => err(pg.exec(`UPDATE profiles SET last_login=now() WHERE id='${STAFF}'`)))).toBeNull();
    await pg.exec(`INSERT INTO auth.users (id, email) VALUES ('${NOBODY}', 'n@x.test') ON CONFLICT DO NOTHING`);
    expect(await as(pg, NOBODY, () => err(pg.exec(`INSERT INTO profiles (id, full_name, role) VALUES ('${NOBODY}','N','admin')`)))).toBeNull();
    expect(await ledger(pg)).toEqual([]);
  });
  it('an auth.users cascade (delete of a non-last admin) is unchanged and the last admin is still protected', async () => {
    const pg = await db();
    expect(await err(pg.exec(`DELETE FROM profiles WHERE id='${ADMIN2}'`))).toBeNull();
    expect(await err(pg.exec(`DELETE FROM profiles WHERE id='${ADMIN}'`))).toMatch(/last_active_admin/);
  });
  it('fail closed: with the ledger broken, a direct deactivation by another admin is rolled back', async () => {
    const pg = await db();
    await pg.exec(`ALTER TABLE data_ledger ADD CONSTRAINT zz_ledger_down2 CHECK (action NOT IN ('deactivated','reactivated')) NOT VALID`);
    expect(await as(pg, ADMIN2, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`)))).toMatch(/zz_ledger_down2|data_ledger/);
    expect(await active(pg, ADMIN)).toBe(true);
    expect(MIG090).toMatch(/H10: a direct is_active change/);
  });
  it('the header documents it, and the rollback removes it (the 071 behaviour is back: no self-deactivation guard, no direct ledger)', async () => {
    expect(MIG090.slice(0, MIG090.indexOf('*/'))).toMatch(/cannot deactivate their OWN row on any path/);
    const pg = await db();
    await pg.exec(RB090);
    await pg.exec('DELETE FROM data_ledger');
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET is_active=false WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await ledger(pg)).toEqual([]);
  });
});

describe('090 rollback (exact restore) and order independence', () => {
  const triggers = async (pg: PGlite, t: string) => (await rows(pg, `select tgname from pg_trigger where tgrelid='public.${t}'::regclass and not tgisinternal order by 1`)).map((r) => r.tgname);
  const defs = async (pg: PGlite) => Object.fromEntries((await rows(pg, `select proname, pg_get_functiondef(oid) def from pg_proc where pronamespace='public'::regnamespace`)).map((r) => [r.proname as string, String(r.def)]));

  it('after the rollback the profiles guard, its trigger and get_users_management_data equal the live capture; 090 objects are gone; grants are back', async () => {
    const pg = await db();
    await pg.exec(RB090);
    const d = await defs(pg);
    expect(defOf(d.profiles_enforce_privileged_columns)).toBe(defOf(LIVE_GUARD));
    expect(defOf(d.get_users_management_data)).toBe(defOf(LIVE_GUM));
    for (const f of ['profiles_guard_role_change', 'profiles_audit_role_change', 'user_entities_guard_write', 'user_entities_audit_write', 'admin_set_procurement_tags']) expect(d[f], f).toBeUndefined();
    expect(await triggers(pg, 'profiles')).toEqual(['trg_profiles_enforce_privileged_columns']);
    expect(await triggers(pg, 'user_entities')).toEqual([]);
    expect(await one(pg, `select count(*)::int n from procurement_exposure_allow where name='admin_set_procurement_tags'`)).toEqual({ n: 0 });
    expect(await one(pg, `select has_table_privilege('authenticated','public.user_entities','INSERT') i, has_table_privilege('authenticated','public.user_entities','DELETE') d`)).toEqual({ i: true, d: true });
    expect(await one(pg, `select pg_get_triggerdef(oid) t from pg_trigger where tgname='trg_profiles_enforce_privileged_columns'`)).toEqual({ t: expect.stringContaining('BEFORE INSERT OR UPDATE ON public.profiles') });
  });
  it('after the rollback behaviour is the old behaviour (an admin can edit their own role directly again; no tag audit)', async () => {
    const pg = await db();
    await pg.exec(RB090);
    expect(await as(pg, ADMIN, () => err(pg.exec(`UPDATE profiles SET role='staff' WHERE id='${ADMIN}'`)))).toBeNull();
    expect(await roleOf(pg, ADMIN)).toBe('staff');
    await pg.exec('DELETE FROM data_ledger');
    await pg.exec(`DELETE FROM user_entities WHERE user_id='${BUYER_QT}'`);
    expect(await ledger(pg)).toEqual([]);
    // the 062/071 protection for non-admins is still there
    expect(await as(pg, BUYER_QT, () => err(pg.exec(`UPDATE profiles SET role='admin' WHERE id='${BUYER_QT}'`)))).toMatch(/cannot change/);
  });
  it('rollback is independent of 085: it runs cleanly if user_entities and the allow table are already gone, and twice in a row', async () => {
    const pg = await db();
    await pg.exec(`DROP TABLE user_entities CASCADE; DROP TABLE procurement_exposure_allow;`);
    await pg.exec(RB090);
    await pg.exec(RB090);
    expect(await triggers(pg, 'profiles')).toEqual(['trg_profiles_enforce_privileged_columns']);
  });
  it('apply, roll back, apply again: the migration is re-runnable and leaves one of each trigger', async () => {
    const pg = await db();
    await pg.exec(RB090);
    await pg.exec(MIG090);
    await pg.exec(MIG090);
    expect(await triggers(pg, 'profiles')).toEqual(['trg_profiles_enforce_privileged_columns', 'trg_profiles_role_audit', 'trg_profiles_role_guard']);
    expect(await triggers(pg, 'user_entities')).toEqual(['trg_user_entities_audit_del', 'trg_user_entities_audit_ins', 'trg_user_entities_audit_upd', 'trg_user_entities_guard']);
    expect(await as(pg, ADMIN, () => setTags(pg, BUYER_QT, ['quackteow', 'merdeka_house']))).toMatchObject({ success: true });
  });
  it('090 refuses to apply without 085 (user_entities missing)', async () => {
    const pg = await db();
    await pg.exec(RB090);
    await pg.exec(`DROP TABLE user_entities CASCADE`);
    expect(await err(pg.exec(MIG090))).toMatch(/depends on 085/);
  });
});

describe('090 files: documented order, snapshot, pre-apply requirement, version stamp', () => {
  const files = import.meta.glob('../../supabase/migrations/*.sql', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const stamps = Object.keys(files).map((f) => /\/(\d{14})_(\d+)_/.exec(f)).filter(Boolean).map((m) => [m![2], m![1]]);
  it('is stamped after 088 and before any 089', () => {
    const st = Object.fromEntries(stamps);
    expect(st['090'] > st['088']).toBe(true);
    if (st['089']) expect(st['089'] > st['090']).toBe(true);
  });
  it('the pre-apply checklist names every item Clive asked for', () => {
    const head = MIG090.slice(0, MIG090.indexOf('*/'));
    expect(head).toMatch(/BYPASSRLS/);
    expect(head).toMatch(/no TRUNCATE|NO privilege at all[^\n]*TRUNCATE/);
    expect(head).toMatch(/'email' line exactly once/);
    expect(head).toMatch(/data_ledger ACCEPTS the new rows/);
    expect(head).toMatch(/REVERSE-ORDER|reverse-order ROLLBACK REHEARSAL/i);
    expect(head).toMatch(/exactly 32 untagged purchase orders/);
  });
  it('the migration header documents apply order, rollback order, the live snapshot, the seeded-copy JWT run and the scope', () => {
    const head = MIG090.slice(0, MIG090.indexOf('*/'));
    expect(head).toMatch(/APPLY ORDER: 084, 085, 087, 088, 090, then 089/);
    expect(head).toMatch(/ROLLBACK ORDER[^\n]*089 -> 090 -> 088 -> 087 -> 085 -> 084/);
    expect(head).toMatch(/SNAPSHOT/);
    expect(head).toMatch(/SEEDED COPY[\s\S]*REAL JWTs/);
    expect(head).toMatch(/bill void\/reverse route is a separate PR/);
  });
  it('the rollback header documents its order and that it is independent of 084/085/087/088', () => {
    const head = RB090.slice(0, 900);
    expect(head).toMatch(/089 -> 090 -> 088 -> 087 -> 085 -> 084/);
    expect(head).toMatch(/Independent of 084\/085\/087\/088/);
    expect(RB090).toContain(defOf(LIVE_GUARD));
    expect(RB090).toContain(defOf(LIVE_GUM));
  });
  it('the new client-executable definer function is allow-listed with a reason; the trigger functions are revoked from clients', () => {
    expect(MIG090).toMatch(/procurement_exposure_allow[^;]*'function', 'admin_set_procurement_tags'/s);
    for (const f of ['profiles_guard_role_change', 'profiles_audit_role_change', 'user_entities_guard_write', 'user_entities_audit_write']) {
      expect(MIG090, f).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${f}\\(\\) FROM PUBLIC, anon, authenticated`));
    }
  });
});
