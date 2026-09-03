import type { SupabaseClient } from "npm:@supabase/supabase-js@2";
import type {
  DiffStatus,
  ReportId,
  ReportResult,
  ReportRow,
  ShEmployee,
  ShProduct,
  ShStock,
  ShTxn,
  ViewBy,
} from "./types.ts";

const TZ = "Asia/Kuala_Lumpur";
const QTY_EPS = 0.0001;

const AVAILABLE: ReportId[] = [
  "sales_over_time",
  "sales_by_product",
  "sales_by_category",
  "sales_by_sku",
  "sales_by_payment",
  "sales_by_channel",
  "promotions",
  "tax",
  "employee",
  "offline_txns",
  "online_txns",
  "returns",
  "stock_value",
];

const POS_ONLY: ReportId[] = [
  "sales_by_payment",
  "promotions",
  "tax",
  "employee",
];

export type ShGet = <T>(path: string) => Promise<T>;
export type FetchTxns = (storeId: string, from: string, to: string) => Promise<ShTxn[]>;

function malaysiaDate(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

function malaysiaHour(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: TZ,
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(d);
  return parts.find((p) => p.type === "hour")?.value ?? "00";
}

function addDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function mondayOf(isoDate: string): string {
  const [y, m, d] = isoDate.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  const dow = dt.getUTCDay(); // 0 Sun
  const back = dow === 0 ? 6 : dow - 1;
  dt.setUTCDate(dt.getUTCDate() - back);
  return dt.toISOString().slice(0, 10);
}

function bucketKey(isoDate: string, hour: string, viewBy: ViewBy): string {
  if (viewBy === "hour") return `${isoDate} ${hour}:00`;
  if (viewBy === "month") return isoDate.slice(0, 7);
  if (viewBy === "week") return `Week of ${mondayOf(isoDate)}`;
  return isoDate;
}

function num(v: unknown): number {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

function qtyEq(a: number | null, b: number | null): boolean {
  if (a == null || b == null) return false;
  return Math.abs(a - b) < QTY_EPS;
}

function skuFromLot(batch: string): string {
  const t = batch.trim();
  const m = t.match(/^(.+)-\d{6}-\d+$/);
  return m ? m[1] : t;
}

function itemQty(txn: ShTxn): number {
  let n = 0;
  for (const item of txn.items ?? []) {
    if (String(item.itemType ?? "Item") !== "Item") continue;
    n += num(item.quantity);
  }
  return n;
}

function isCancelled(txn: ShTxn): boolean {
  return Boolean(txn.isCancelled);
}

function isReturn(txn: ShTxn): boolean {
  return String(txn.transactionType ?? "Sale") === "Return";
}

function isSale(txn: ShTxn): boolean {
  return !isCancelled(txn) && !isReturn(txn);
}

function isOnline(txn: ShTxn): boolean {
  const ch = String(txn.channel ?? "").toUpperCase();
  return ch.includes("ONLINE") || ch.includes("BEEP") || ch.includes("QR") || ch.includes("WEB");
}

function promoName(p: { name?: string; id?: string }): string {
  return (p.name || p.id || "Promotion").trim() || "Promotion";
}

function employeeName(e: ShEmployee | undefined, id: string): string {
  if (!e) return id || "(no cashier)";
  const named = [e.firstName, e.lastName].filter(Boolean).join(" ").trim();
  return named || e.name || e.email || id || "(no cashier)";
}

function emptyTotals() {
  return {
    posQty: 0,
    posRm: 0,
    dashQty: 0,
    match: 0,
    qty_mismatch: 0,
    missing_in_dashboard: 0,
    extra_in_dashboard: 0,
    pos_only: 0,
  };
}

function finish(rows: ReportRow[], extra: Partial<ReportResult> & Pick<ReportResult, "report">): ReportResult {
  const totals = emptyTotals();
  for (const r of rows) {
    totals.posQty += r.posQty ?? 0;
    totals.posRm += r.posRm ?? 0;
    totals.dashQty += r.dashQty ?? 0;
    totals[r.status] += 1;
  }
  return {
    from: extra.from ?? null,
    to: extra.to ?? null,
    viewBy: extra.viewBy,
    snapshot: extra.snapshot ?? false,
    posOnly: extra.posOnly ?? false,
    notice: extra.notice ?? null,
    error: extra.error ?? null,
    columns: extra.columns ?? [
      { key: "label", label: "Row" },
      { key: "posQty", label: "POS qty" },
      { key: "posRm", label: "POS RM" },
      { key: "dashQty", label: "Dashboard qty" },
      { key: "status", label: "Status" },
    ],
    rows,
    totals,
    report: extra.report,
  };
}

function mergeKeys(pos: Map<string, { qty: number; rm: number; label: string }>, dash: Map<string, number>, posOnly: boolean): ReportRow[] {
  const keys = new Set([...pos.keys(), ...dash.keys()]);
  const rows: ReportRow[] = [];
  for (const key of [...keys].sort((a, b) => a.localeCompare(b))) {
    const p = pos.get(key);
    const d = dash.has(key) ? dash.get(key)! : null;
    const posQty = p ? p.qty : dash.has(key) && !p ? null : p?.qty ?? null;
    const posRm = p ? p.rm : null;
    const dashQty = posOnly ? null : d;
    const havePos = Boolean(p);
    const haveDash = d != null && !posOnly;
    let status: DiffStatus;
    if (posOnly) status = "pos_only";
    else if (havePos && haveDash) status = qtyEq(p!.qty, d) ? "match" : "qty_mismatch";
    else if (havePos) status = "missing_in_dashboard";
    else status = "extra_in_dashboard";
    rows.push({
      key,
      label: p?.label ?? key,
      posQty: havePos ? p!.qty : posQty,
      posRm,
      dashQty: haveDash ? d : dashQty,
      status,
    });
  }
  return rows;
}

interface JournalLine {
  id: string;
  business_date: string;
  outlet_id: string;
  status: string;
  notes: string | null;
  source: string | null;
  idempotency_key: string | null;
  quantity_sold: number;
  product_batch: string;
  lot_id: string | null;
}

async function loadJournals(
  admin: SupabaseClient,
  from: string,
  to: string,
  outletIds: string[],
): Promise<JournalLine[]> {
  let q = admin
    .from("sales_journals")
    .select("id, business_date, outlet_id, status, notes, source, idempotency_key, sales_journal_lines(quantity_sold, product_batch, lot_id)")
    .eq("status", "posted")
    .gte("business_date", from)
    .lte("business_date", to);
  if (outletIds.length === 1) q = q.eq("outlet_id", outletIds[0]);
  else if (outletIds.length > 1) q = q.in("outlet_id", outletIds);

  const { data, error } = await q;
  if (error) throw new Error(error.message);

  const out: JournalLine[] = [];
  for (const j of data ?? []) {
    const lines = (j.sales_journal_lines ?? []) as {
      quantity_sold?: number;
      product_batch?: string;
      lot_id?: string | null;
    }[];
    if (!lines.length) {
      out.push({
        id: j.id as string,
        business_date: j.business_date as string,
        outlet_id: j.outlet_id as string,
        status: j.status as string,
        notes: (j.notes as string | null) ?? null,
        source: (j.source as string | null) ?? null,
        idempotency_key: (j.idempotency_key as string | null) ?? null,
        quantity_sold: 0,
        product_batch: "",
        lot_id: null,
      });
      continue;
    }
    for (const line of lines) {
      out.push({
        id: j.id as string,
        business_date: j.business_date as string,
        outlet_id: j.outlet_id as string,
        status: j.status as string,
        notes: (j.notes as string | null) ?? null,
        source: (j.source as string | null) ?? null,
        idempotency_key: (j.idempotency_key as string | null) ?? null,
        quantity_sold: num(line.quantity_sold),
        product_batch: String(line.product_batch ?? ""),
        lot_id: (line.lot_id as string | null) ?? null,
      });
    }
  }
  return out;
}

function channelFromNotes(notes: string | null): string {
  if (!notes) return "unknown";
  const idx = notes.lastIndexOf(" · ");
  if (idx >= 0) return notes.slice(idx + 3).trim() || "unknown";
  return "unknown";
}

export async function handleReport(opts: {
  admin: SupabaseClient;
  get: ShGet;
  fetchTxns: FetchTxns;
  report: string;
  from?: string;
  to?: string;
  storeId?: string;
  viewBy?: string;
}): Promise<ReportResult> {
  const report = opts.report as ReportId;
  if (!AVAILABLE.includes(report)) {
    return finish([], {
      report: opts.report,
      error: "This StoreHub report is not available through the API.",
      posOnly: true,
    });
  }

  const [{ data: storeMaps }, { data: productMaps }] = await Promise.all([
    opts.admin.from("storehub_store_map").select("storehub_store_id, outlet_id, storehub_store_name"),
    opts.admin.from("storehub_product_map").select("storehub_product_id, quackmaster_sku, storehub_sku, storehub_name"),
  ]);

  const storeMap = new Map<string, { outletId: string; name: string }>();
  for (const r of storeMaps ?? []) {
    storeMap.set(r.storehub_store_id as string, {
      outletId: r.outlet_id as string,
      name: (r.storehub_store_name as string) || (r.storehub_store_id as string),
    });
  }
  const productToSku = new Map<string, string>();
  const productMeta = new Map<string, { sku: string; name: string }>();
  for (const r of productMaps ?? []) {
    const sku = String(r.quackmaster_sku ?? "").trim();
    if (!sku) continue;
    productToSku.set(r.storehub_product_id as string, sku);
    productMeta.set(r.storehub_product_id as string, {
      sku,
      name: (r.storehub_name as string) || (r.storehub_sku as string) || sku,
    });
  }

  let storeIds = opts.storeId?.trim()
    ? [opts.storeId.trim()]
    : [...storeMap.keys()];

  if (storeIds.length === 0) {
    const stores = await opts.get<Array<{ id?: string }>>("/stores");
    storeIds = (Array.isArray(stores) ? stores : []).map((s) => String(s.id ?? "")).filter(Boolean);
  }

  if (report === "stock_value") {
    return stockValueReport(opts, storeIds, storeMap, productToSku, productMeta);
  }

  const from = opts.from?.trim() || malaysiaDate(new Date(Date.now() - 6 * 86400000));
  const to = opts.to?.trim() || malaysiaDate(new Date());
  const viewBy = (["day", "week", "month", "hour"].includes(opts.viewBy ?? "") ? opts.viewBy : "day") as ViewBy;

  if (storeIds.length === 0) {
    return finish([], {
      report,
      from,
      to,
      error: "No StoreHub stores mapped to outlets. Load catalog and save maps first.",
      posOnly: POS_ONLY.includes(report),
    });
  }

  const txns: ShTxn[] = [];
  for (const sid of storeIds) {
    txns.push(...await opts.fetchTxns(sid, from, to));
  }

  const outletIds = [...new Set(
    storeIds.map((id) => storeMap.get(id)?.outletId).filter((v): v is string => Boolean(v)),
  )];

  const journals = outletIds.length ? await loadJournals(opts.admin, from, to, outletIds) : [];
  const posOnly = POS_ONLY.includes(report) || (report === "sales_over_time" && viewBy === "hour");

  let productsById = new Map<string, ShProduct>();
  if (
    report === "sales_by_product" ||
    report === "sales_by_category" ||
    report === "sales_by_sku" ||
    report === "stock_value"
  ) {
    const products = await opts.get<ShProduct[]>("/products");
    productsById = new Map((Array.isArray(products) ? products : []).map((p) => [p.id, p]));
  }

  let employeesById = new Map<string, ShEmployee>();
  if (report === "employee") {
    try {
      const employees = await opts.get<ShEmployee[]>("/employees");
      employeesById = new Map(
        (Array.isArray(employees) ? employees : []).map((e) => [String(e.id ?? ""), e]),
      );
    } catch {
      employeesById = new Map();
    }
  }

  if (report === "sales_over_time") {
    const pos = new Map<string, { qty: number; rm: number; label: string }>();
    for (const txn of txns) {
      if (!isSale(txn) || !txn.transactionTime) continue;
      const dt = new Date(txn.transactionTime);
      const day = malaysiaDate(dt);
      const key = bucketKey(day, malaysiaHour(dt), viewBy);
      const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
      cur.qty += itemQty(txn);
      cur.rm += num(txn.total);
      pos.set(key, cur);
    }
    const dash = new Map<string, number>();
    if (!posOnly) {
      for (const line of journals) {
        const key = bucketKey(line.business_date, "00", viewBy);
        dash.set(key, (dash.get(key) ?? 0) + line.quantity_sold);
      }
    }
    return finish(mergeKeys(pos, dash, posOnly), {
      report,
      from,
      to,
      viewBy,
      posOnly,
      notice: posOnly
        ? "Dashboard journals are dated by business day, not hour. POS hours are shown only."
        : "POS qty is units on completed sales (cancels excluded). Dashboard qty is posted journal units.",
    });
  }

  if (report === "sales_by_product" || report === "sales_by_sku" || report === "sales_by_category") {
    const pos = new Map<string, { qty: number; rm: number; label: string }>();
    for (const txn of txns) {
      if (!isSale(txn)) continue;
      for (const item of txn.items ?? []) {
        if (String(item.itemType ?? "Item") !== "Item") continue;
        const pid = String(item.productId ?? "").trim();
        if (!pid) continue;
        const prod = productsById.get(pid);
        let key: string;
        let label: string;
        if (report === "sales_by_category") {
          key = (prod?.category || "Uncategorised").trim() || "Uncategorised";
          label = key;
        } else if (report === "sales_by_sku") {
          const sku = productToSku.get(pid) || prod?.sku || pid;
          key = sku;
          label = `${sku}${prod?.name ? ` · ${prod.name}` : ""}`;
        } else {
          key = pid;
          label = prod?.name || productMeta.get(pid)?.name || pid;
        }
        const cur = pos.get(key) ?? { qty: 0, rm: 0, label };
        cur.qty += num(item.quantity);
        cur.rm += num(item.total ?? item.subTotal);
        pos.set(key, cur);
      }
    }

    const dash = new Map<string, number>();
    if (report === "sales_by_category") {
      const skuToCat = new Map<string, string>();
      for (const [pid, prod] of productsById) {
        const sku = productToSku.get(pid) || (prod.sku ?? "").trim();
        if (sku) skuToCat.set(sku, (prod.category || "Uncategorised").trim() || "Uncategorised");
      }
      for (const line of journals) {
        const sku = skuFromLot(line.product_batch);
        const cat = skuToCat.get(sku) || "Uncategorised";
        dash.set(cat, (dash.get(cat) ?? 0) + line.quantity_sold);
      }
    } else {
      for (const line of journals) {
        const sku = skuFromLot(line.product_batch);
        if (report === "sales_by_product") {
          // Dashboard has SKU not product id; put qty on every mapped product of that SKU only via sku key compare below.
          dash.set(sku, (dash.get(sku) ?? 0) + line.quantity_sold);
        } else {
          dash.set(sku, (dash.get(sku) ?? 0) + line.quantity_sold);
        }
      }
      if (report === "sales_by_product") {
        const mappedDash = new Map<string, number>();
        for (const [pid] of pos) {
          const sku = productToSku.get(pid) || productsById.get(pid)?.sku?.trim() || "";
          if (sku && dash.has(sku)) mappedDash.set(pid, dash.get(sku)!);
        }
        for (const [sku, qty] of dash) {
          const mappedPids = [...productToSku.entries()].filter(([, s]) => s === sku).map(([id]) => id);
          if (mappedPids.length === 0 && !pos.has(sku)) {
            mappedDash.set(sku, qty);
          }
        }
        return finish(mergeKeys(pos, mappedDash, false), {
          report,
          from,
          to,
          posOnly: false,
          notice:
            "Dashboard groups by recipe SKU (e.g. QUACKTEOW), not StoreHub product id. Map products in Settings so rows can match.",
        });
      }
    }

    return finish(mergeKeys(pos, dash, false), {
      report,
      from,
      to,
      posOnly: false,
      notice: report === "sales_by_sku"
        ? "POS uses mapped Quackmaster SKU when saved; otherwise the StoreHub SKU."
        : "Category comes from the StoreHub product catalog. Unmapped SKUs land in Uncategorised on the dashboard side.",
    });
  }

  if (report === "sales_by_channel") {
    const pos = new Map<string, { qty: number; rm: number; label: string }>();
    for (const txn of txns) {
      if (!isSale(txn)) continue;
      const key = String(txn.channel ?? "OFFLINE_PAYMENTS") || "OFFLINE_PAYMENTS";
      const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
      cur.qty += itemQty(txn);
      cur.rm += num(txn.total);
      pos.set(key, cur);
    }
    const dash = new Map<string, number>();
    for (const line of journals) {
      const key = line.source === "storehub" ? channelFromNotes(line.notes) : "manual";
      dash.set(key, (dash.get(key) ?? 0) + line.quantity_sold);
    }
    return finish(mergeKeys(pos, dash, false), {
      report,
      from,
      to,
      posOnly: false,
      notice: "Manual journals (not ingested from StoreHub) appear as channel “manual”.",
    });
  }

  if (report === "sales_by_payment" || report === "promotions" || report === "tax" || report === "employee") {
    const pos = new Map<string, { qty: number; rm: number; label: string }>();
    for (const txn of txns) {
      if (!isSale(txn)) continue;
      if (report === "sales_by_payment") {
        const pays = txn.payments?.length ? txn.payments : [{ paymentMethod: "(none)", amount: txn.total }];
        for (const p of pays) {
          const key = String(p.paymentMethod ?? "(none)") || "(none)";
          const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
          cur.qty += 1;
          cur.rm += num(p.amount);
          pos.set(key, cur);
        }
      } else if (report === "promotions") {
        const promos = [
          ...(txn.promotions ?? []),
          ...(txn.items ?? []).flatMap((i) => i.promotions ?? []),
        ];
        if (!promos.length && num(txn.discount) > 0) {
          const cur = pos.get("Discount") ?? { qty: 0, rm: 0, label: "Discount" };
          cur.qty += 1;
          cur.rm += num(txn.discount);
          pos.set("Discount", cur);
        }
        for (const p of promos) {
          const key = promoName(p);
          const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
          cur.qty += 1;
          cur.rm += num(p.discountAmount ?? p.amount);
          pos.set(key, cur);
        }
      } else if (report === "tax") {
        const codes = new Map<string, { qty: number; rm: number }>();
        for (const item of txn.items ?? []) {
          if (String(item.itemType ?? "Item") !== "Item") continue;
          const key = String(item.taxCode ?? "Tax") || "Tax";
          const cur = codes.get(key) ?? { qty: 0, rm: 0 };
          cur.qty += num(item.quantity);
          cur.rm += num(item.tax);
          codes.set(key, cur);
        }
        if (codes.size === 0) {
          const key = "Tax";
          const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
          cur.qty += itemQty(txn);
          cur.rm += num(txn.tax);
          pos.set(key, cur);
        } else {
          for (const [key, v] of codes) {
            const cur = pos.get(key) ?? { qty: 0, rm: 0, label: key };
            cur.qty += v.qty;
            cur.rm += v.rm || num(txn.tax);
            pos.set(key, cur);
          }
        }
      } else {
        const id = String(txn.employeeId ?? "").trim();
        const label = employeeName(employeesById.get(id), id);
        const key = id || label;
        const cur = pos.get(key) ?? { qty: 0, rm: 0, label };
        cur.qty += itemQty(txn);
        cur.rm += num(txn.total);
        pos.set(key, cur);
      }
    }
    const notice =
      report === "sales_by_payment"
        ? "Quackmaster journals do not store payment method. POS side only."
        : report === "promotions"
        ? "Quackmaster journals do not store promotions. POS side only."
        : report === "tax"
        ? "Quackmaster journals do not store tax. POS side only."
        : "Quackmaster journals do not store cashier. POS side only.";
    return finish(mergeKeys(pos, new Map(), true), {
      report,
      from,
      to,
      posOnly: true,
      notice,
    });
  }

  if (report === "offline_txns" || report === "online_txns" || report === "returns") {
    const dashByRef = new Map<string, { qty: number; invoice?: string }>();
    if (report === "returns") {
      const { data: events } = await opts.admin
        .from("storehub_sync_events")
        .select("ref_id, invoice_number, status")
        .eq("event_type", "return")
        .gte("created_at", `${from}T00:00:00+08:00`)
        .lte("created_at", `${addDays(to, 1)}T00:00:00+08:00`);
      for (const ev of events ?? []) {
        dashByRef.set(String(ev.ref_id), { qty: 0, invoice: ev.invoice_number as string | undefined });
      }
    } else {
      const seen = new Map<string, number>();
      for (const line of journals) {
        if (!line.idempotency_key) continue;
        seen.set(line.idempotency_key, (seen.get(line.idempotency_key) ?? 0) + line.quantity_sold);
      }
      for (const [ref, qty] of seen) dashByRef.set(ref, { qty });
    }

    const pos = new Map<string, { qty: number; rm: number; label: string }>();
    for (const txn of txns) {
      const ref = String(txn.refId ?? "").trim();
      if (!ref) continue;
      if (report === "returns") {
        if (!isReturn(txn)) continue;
      } else if (isCancelled(txn) || isReturn(txn)) {
        continue;
      } else if (report === "online_txns" && !isOnline(txn)) {
        continue;
      } else if (report === "offline_txns" && isOnline(txn)) {
        continue;
      }
      const label = txn.invoiceNumber || ref;
      pos.set(ref, { qty: itemQty(txn), rm: num(txn.total), label: `${label}${isCancelled(txn) ? " (cancelled)" : ""}` });
    }

    const dash = new Map<string, number>();
    for (const [ref, v] of dashByRef) dash.set(ref, v.qty);

    const rows = mergeKeys(pos, dash, false);
    return finish(rows.slice(0, 500), {
      report,
      from,
      to,
      posOnly: false,
      notice:
        rows.length > 500
          ? `Showing first 500 of ${rows.length} rows. Narrow the date range.`
          : report === "returns"
          ? "Dashboard column is whether a return was flagged for review (qty stays 0 until FIFO reverse exists)."
          : "Match is on StoreHub refId = sales journal idempotency key. Qty is units on the ticket vs journal lines.",
    });
  }

  return finish([], { report, error: "Unknown report", posOnly: true });
}

async function stockValueReport(
  opts: {
    admin: SupabaseClient;
    get: ShGet;
  },
  storeIds: string[],
  storeMap: Map<string, { outletId: string; name: string }>,
  productToSku: Map<string, string>,
  productMeta: Map<string, { sku: string; name: string }>,
): Promise<ReportResult> {
  if (storeIds.length === 0) {
    return finish([], {
      report: "stock_value",
      snapshot: true,
      error: "Map at least one StoreHub store to an outlet, then compare stock.",
      posOnly: false,
    });
  }

  const products = await opts.get<ShProduct[]>("/products");
  const productsById = new Map((Array.isArray(products) ? products : []).map((p) => [p.id, p]));

  const pos = new Map<string, { qty: number; rm: number; label: string }>();
  for (const sid of storeIds) {
    let stocks: ShStock[] = [];
    try {
      stocks = await opts.get<ShStock[]>(`/inventory/${sid}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return finish([], {
        report: "stock_value",
        snapshot: true,
        error: `StoreHub inventory for store ${sid}: ${msg}`,
        posOnly: false,
      });
    }
    for (const s of Array.isArray(stocks) ? stocks : []) {
      const pid = String(s.productId ?? "").trim();
      if (!pid) continue;
      const sku = productToSku.get(pid) || productsById.get(pid)?.sku || pid;
      const name = productsById.get(pid)?.name || productMeta.get(pid)?.name || sku;
      const cur = pos.get(sku) ?? { qty: 0, rm: 0, label: name };
      cur.qty += num(s.quantityOnHand);
      pos.set(sku, cur);
    }
  }

  const outletIds = [...new Set(
    storeIds.map((id) => storeMap.get(id)?.outletId).filter((v): v is string => Boolean(v)),
  )];
  const dash = new Map<string, number>();
  if (outletIds.length) {
    const { data, error } = await opts.admin
      .from("outlet_inventory")
      .select("product_batch, quantity_on_hand")
      .in("outlet_id", outletIds);
    if (error) throw new Error(error.message);
    for (const row of data ?? []) {
      const sku = skuFromLot(String(row.product_batch ?? ""));
      dash.set(sku, (dash.get(sku) ?? 0) + num(row.quantity_on_hand));
    }
  }

  return finish(mergeKeys(pos, dash, false), {
    report: "stock_value",
    snapshot: true,
    posOnly: false,
    notice:
      "This is a now-snapshot, not a period report. StoreHub qty is cashier-facing; Quackmaster outlet on-hand is lot stock. They are not expected to match if POS track-stock and lots diverge.",
  });
}
