import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2";

const STOREHUB_HOST = "https://api.storehubhq.com";
const MIN_INTERVAL_MS = 350;
const TZ = "Asia/Kuala_Lumpur";
const MAX_TXNS = 5000;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowHeaders = req.headers.get("Access-Control-Request-Headers") ??
    "authorization, content-type, x-client-info, apikey, x-storehub-cron-token";
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, req: Request, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
    },
  });
}

function malaysiaDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function todayMy(): string {
  return malaysiaDate(new Date());
}

interface ShStore {
  id: string;
  name?: string;
}

interface ShProduct {
  id: string;
  name?: string;
  sku?: string;
  isParentProduct?: boolean;
}

interface ShItem {
  productId?: string;
  quantity?: number;
  itemType?: string;
}

interface ShTxn {
  refId?: string;
  invoiceNumber?: string;
  storeId?: string;
  transactionType?: string;
  transactionTime?: string;
  isCancelled?: boolean;
  channel?: string;
  items?: ShItem[];
}

class StoreHubClient {
  private lastCall = 0;
  constructor(
    private readonly storeName: string,
    private readonly apiToken: string,
  ) {}

  private authHeader(): string {
    return `Basic ${btoa(`${this.storeName}:${this.apiToken}`)}`;
  }

  private async throttle() {
    const wait = MIN_INTERVAL_MS - (Date.now() - this.lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
  }

  async get<T>(path: string): Promise<T> {
    await this.throttle();
    const res = await fetch(`${STOREHUB_HOST}${path}`, {
      headers: {
        Authorization: this.authHeader(),
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`StoreHub ${path} ${res.status}: ${text.slice(0, 400)}`);
    }
    return (await res.json()) as T;
  }
}

function storehubConfigured(): boolean {
  return Boolean(
    Deno.env.get("STOREHUB_STORE_NAME")?.trim() &&
      Deno.env.get("STOREHUB_API_TOKEN")?.trim(),
  );
}

function makeAdminClient(): SupabaseClient {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceKey) {
    throw new Error("Missing Supabase configuration");
  }
  return createClient(supabaseUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

async function requireAdminOrCron(
  req: Request,
): Promise<{ ok: true; fromCron: boolean; userId: string | null } | { ok: false; res: Response }> {
  const cronHeader = req.headers.get("x-storehub-cron-token")?.trim() ?? "";
  if (cronHeader) {
    const admin = makeAdminClient();
    const { data, error } = await admin
      .from("storehub_sync_settings")
      .select("cron_token")
      .eq("id", 1)
      .maybeSingle();
    if (error) {
      return { ok: false, res: jsonResponse({ error: error.message }, req, 500) };
    }
    if (data?.cron_token && data.cron_token === cronHeader) {
      return { ok: true, fromCron: true, userId: null };
    }
    return { ok: false, res: jsonResponse({ error: "Invalid cron token" }, req, 403) };
  }

  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return { ok: false, res: jsonResponse({ error: "Missing or invalid Authorization header" }, req, 401) };
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!supabaseUrl || !anonKey) {
    return { ok: false, res: jsonResponse({ error: "Missing Supabase configuration" }, req, 500) };
  }

  const jwt = authHeader.replace(/^Bearer\s+/i, "");
  const userClient = createClient(supabaseUrl, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: authHeader } },
  });
  const {
    data: { user: caller },
    error: callerErr,
  } = await userClient.auth.getUser(jwt);
  if (callerErr || !caller) {
    return { ok: false, res: jsonResponse({ error: "Invalid session" }, req, 401) };
  }

  const admin = makeAdminClient();
  const { data: profile, error: profileErr } = await admin
    .from("profiles")
    .select("role")
    .eq("id", caller.id)
    .maybeSingle();
  if (profileErr) {
    return { ok: false, res: jsonResponse({ error: `Profile check failed: ${profileErr.message}` }, req, 500) };
  }
  if (String(profile?.role ?? "").toLowerCase() !== "admin") {
    return { ok: false, res: jsonResponse({ error: "Forbidden: admin only" }, req, 403) };
  }
  return { ok: true, fromCron: false, userId: caller.id };
}

async function recordFail(
  admin: SupabaseClient,
  args: {
    refId: string;
    invoice?: string;
    outletId?: string | null;
    error: string;
    payload: Record<string, unknown>;
    runId: string;
  },
) {
  await admin.from("storehub_sync_events").upsert(
    {
      ref_id: args.refId,
      invoice_number: args.invoice ?? null,
      event_type: "fail",
      status: "failed",
      outlet_id: args.outletId ?? null,
      error: args.error,
      payload: args.payload,
      sync_run_id: args.runId,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "ref_id" },
  );
}

async function handleCatalog(sh: StoreHubClient) {
  const stores = await sh.get<ShStore[]>("/stores");
  const products = await sh.get<ShProduct[]>("/products");
  return {
    stores: (Array.isArray(stores) ? stores : []).map((s) => ({
      id: s.id,
      name: s.name ?? s.id,
    })),
    products: (Array.isArray(products) ? products : []).map((p) => ({
      id: p.id,
      name: p.name ?? "",
      sku: p.sku ?? "",
      isParentProduct: Boolean(p.isParentProduct),
    })),
  };
}

async function fetchTransactions(
  sh: StoreHubClient,
  storeId: string,
  from: string,
  to: string,
): Promise<ShTxn[]> {
  const qs = new URLSearchParams({
    from,
    to,
    storeId,
    includeOnline: "true",
  });
  const rows = await sh.get<ShTxn[]>(`/transactions?${qs.toString()}`);
  return Array.isArray(rows) ? rows : [];
}

async function processTxn(
  admin: SupabaseClient,
  txn: ShTxn,
  storeMap: Map<string, string>,
  productMap: Map<string, string>,
  runId: string,
): Promise<"ingested" | "cancelled" | "return" | "failed" | "skipped"> {
  const refRaw = String(txn.refId ?? "").trim();
  if (!UUID_RE.test(refRaw)) {
    return "skipped";
  }

  const type = String(txn.transactionType ?? "Sale");
  if (type === "Return") {
    await admin.rpc("ingest_storehub_return_flag", {
      p_ref_id: refRaw,
      p_invoice_number: txn.invoiceNumber ?? null,
      p_payload: {
        storeId: txn.storeId,
        channel: txn.channel,
        transactionTime: txn.transactionTime,
      },
      p_sync_run_id: runId,
    });
    return "return";
  }

  if (txn.isCancelled) {
    const { data, error } = await admin.rpc("ingest_storehub_cancel", {
      p_ref_id: refRaw,
      p_sync_run_id: runId,
    });
    if (error) {
      await recordFail(admin, {
        refId: refRaw,
        invoice: txn.invoiceNumber,
        error: error.message,
        payload: { step: "cancel" },
        runId,
      });
      return "failed";
    }
    const payload = data as { success?: boolean; skipped?: boolean; error?: string } | null;
    if (payload?.error) {
      await recordFail(admin, {
        refId: refRaw,
        invoice: txn.invoiceNumber,
        error: payload.error,
        payload: { step: "cancel" },
        runId,
      });
      return "failed";
    }
    return payload?.skipped ? "skipped" : "cancelled";
  }

  const storeId = String(txn.storeId ?? "").trim();
  const outletId = storeMap.get(storeId);
  if (!outletId) {
    await recordFail(admin, {
      refId: refRaw,
      invoice: txn.invoiceNumber,
      error: "unmapped_store",
      payload: { storeId, channel: txn.channel },
      runId,
    });
    return "failed";
  }

  const qtyBySku = new Map<string, number>();
  for (const item of txn.items ?? []) {
    if (String(item.itemType ?? "Item") !== "Item") continue;
    const pid = String(item.productId ?? "").trim();
    const sku = productMap.get(pid);
    const qty = Number(item.quantity ?? 0);
    if (!pid || qty <= 0) continue;
    if (!sku) {
      await recordFail(admin, {
        refId: refRaw,
        invoice: txn.invoiceNumber,
        outletId,
        error: "unmapped_sku",
        payload: { productId: pid, quantity: qty, channel: txn.channel },
        runId,
      });
      return "failed";
    }
    qtyBySku.set(sku, (qtyBySku.get(sku) ?? 0) + qty);
  }

  if (qtyBySku.size === 0) {
    return "skipped";
  }

  const lines = [...qtyBySku.entries()].map(([sku, quantity]) => ({ sku, quantity }));
  const businessDate = malaysiaDate(new Date(txn.transactionTime ?? Date.now()));
  const channel = txn.channel ?? "OFFLINE_PAYMENTS";
  const notes = `StoreHub ${txn.invoiceNumber ?? refRaw} · ${channel}`;

  const { data, error } = await admin.rpc("ingest_storehub_sale", {
    p_ref_id: refRaw,
    p_outlet_id: outletId,
    p_business_date: businessDate,
    p_lines: lines,
    p_notes: notes,
    p_invoice_number: txn.invoiceNumber ?? null,
    p_channel: channel,
    p_sync_run_id: runId,
  });

  if (error) {
    await recordFail(admin, {
      refId: refRaw,
      invoice: txn.invoiceNumber,
      outletId,
      error: error.message,
      payload: { channel },
      runId,
    });
    return "failed";
  }

  const payload = data as {
    success?: boolean;
    error?: string;
    idempotent_replay?: boolean;
    sku?: string;
    requested?: number;
    available?: number;
  } | null;

  if (!payload?.success) {
    await recordFail(admin, {
      refId: refRaw,
      invoice: txn.invoiceNumber,
      outletId,
      error: payload?.error ?? "ingest_failed",
      payload: {
        sku: payload?.sku,
        requested: payload?.requested,
        available: payload?.available,
        channel,
      },
      runId,
    });
    return "failed";
  }

  return payload.idempotent_replay ? "skipped" : "ingested";
}

async function handleSync(
  admin: SupabaseClient,
  sh: StoreHubClient,
  opts: { from?: string; to?: string; fromCron: boolean; userId: string | null },
) {
  const { data: settings } = await admin
    .from("storehub_sync_settings")
    .select("last_success_to")
    .eq("id", 1)
    .maybeSingle();

  const to = opts.to?.trim() || todayMy();
  let from = opts.from?.trim() || "";
  if (!from) {
    const last = settings?.last_success_to as string | null | undefined;
    from = last ? last : addDays(to, -6);
  }

  const { data: runRow, error: runErr } = await admin
    .from("storehub_sync_runs")
    .insert({
      window_from: from,
      window_to: to,
      triggered_by: opts.fromCron ? "cron" : "admin",
      created_by: opts.userId,
    })
    .select("id")
    .single();

  if (runErr || !runRow) {
    throw new Error(runErr?.message ?? "Could not create sync run");
  }
  const runId = runRow.id as string;

  const counts = {
    stores_synced: 0,
    sales_ingested: 0,
    cancelled: 0,
    returns_flagged: 0,
    failed: 0,
  };
  let runError: string | null = null;

  try {
    const [{ data: storeMaps }, { data: productMaps }] = await Promise.all([
      admin.from("storehub_store_map").select("storehub_store_id, outlet_id"),
      admin.from("storehub_product_map").select("storehub_product_id, quackmaster_sku"),
    ]);

    const storeMap = new Map<string, string>(
      (storeMaps ?? []).map((r) => [r.storehub_store_id as string, r.outlet_id as string]),
    );
    const productMap = new Map<string, string>(
      (productMaps ?? []).map((r) => [
        r.storehub_product_id as string,
        String(r.quackmaster_sku).trim(),
      ]),
    );

    if (storeMap.size === 0) {
      if (!opts.fromCron) {
        throw new Error("No StoreHub stores mapped to outlets. Load catalog and save maps first.");
      }
    } else {
      for (const [storeId] of storeMap) {
        counts.stores_synced += 1;
        let windowFrom = from;
        const windowTo = to;
        let safety = 0;
        while (windowFrom <= windowTo && safety < 40) {
          safety += 1;
          const txns = await fetchTransactions(sh, storeId, windowFrom, windowTo);
          if (txns.length >= MAX_TXNS && windowFrom < windowTo) {
            const mid = addDays(
              windowFrom,
              Math.max(
                0,
                Math.floor(
                  (Date.parse(`${windowTo}T00:00:00Z`) - Date.parse(`${windowFrom}T00:00:00Z`)) /
                    86400000 /
                    2,
                ),
              ),
            );
            const leftTo = mid < windowTo ? mid : windowFrom;
            const first = await fetchTransactions(sh, storeId, windowFrom, leftTo);
            for (const txn of first) {
              const kind = await processTxn(admin, txn, storeMap, productMap, runId);
              if (kind === "ingested") counts.sales_ingested += 1;
              else if (kind === "cancelled") counts.cancelled += 1;
              else if (kind === "return") counts.returns_flagged += 1;
              else if (kind === "failed") counts.failed += 1;
            }
            windowFrom = addDays(leftTo, 1);
            continue;
          }
          for (const txn of txns) {
            const kind = await processTxn(admin, txn, storeMap, productMap, runId);
            if (kind === "ingested") counts.sales_ingested += 1;
            else if (kind === "cancelled") counts.cancelled += 1;
            else if (kind === "return") counts.returns_flagged += 1;
            else if (kind === "failed") counts.failed += 1;
          }
          break;
        }
      }

      await admin
        .from("storehub_sync_settings")
        .update({ last_success_to: to, updated_at: new Date().toISOString() })
        .eq("id", 1);
    }
  } catch (e) {
    runError = e instanceof Error ? e.message : String(e);
  }

  await admin
    .from("storehub_sync_runs")
    .update({
      finished_at: new Date().toISOString(),
      stores_synced: counts.stores_synced,
      sales_ingested: counts.sales_ingested,
      cancelled: counts.cancelled,
      returns_flagged: counts.returns_flagged,
      failed: counts.failed,
      error: runError,
    })
    .eq("id", runId);

  return { runId, from, to, ...counts, error: runError };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, req, 405);
  }

  try {
    const auth = await requireAdminOrCron(req);
    if (!auth.ok) return auth.res;

    const body = (await req.json().catch(() => ({}))) as {
      action?: string;
      from?: string;
      to?: string;
    };
    const action = body.action ?? "status";

    if (action === "status") {
      const admin = makeAdminClient();
      const { data: lastRun } = await admin
        .from("storehub_sync_runs")
        .select("*")
        .order("started_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      const { data: settings } = await admin
        .from("storehub_sync_settings")
        .select("last_success_to, timezone")
        .eq("id", 1)
        .maybeSingle();
      return jsonResponse({
        configured: storehubConfigured(),
        lastRun,
        lastSuccessTo: settings?.last_success_to ?? null,
        timezone: settings?.timezone ?? TZ,
      }, req);
    }

    if (!storehubConfigured()) {
      return jsonResponse({
        error:
          "StoreHub secrets are not set. In Supabase → Edge Functions → Secrets, set STOREHUB_STORE_NAME and STOREHUB_API_TOKEN.",
      }, req, 400);
    }

    const sh = new StoreHubClient(
      Deno.env.get("STOREHUB_STORE_NAME")!.trim(),
      Deno.env.get("STOREHUB_API_TOKEN")!.trim(),
    );

    if (action === "catalog") {
      const catalog = await handleCatalog(sh);
      return jsonResponse(catalog, req);
    }

    if (action === "sync") {
      const admin = makeAdminClient();
      const result = await handleSync(admin, sh, {
        from: body.from,
        to: body.to,
        fromCron: auth.fromCron,
        userId: auth.userId,
      });
      return jsonResponse(result, req, result.error ? 500 : 200);
    }

    return jsonResponse({ error: "Unknown action" }, req, 400);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: `Server error: ${message}` }, req, 500);
  }
});
