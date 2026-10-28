/** Pure helpers for PO receiving (mirrors receive_po_shipment v2, migration 081). */

export const DEFAULT_OVER_RECEIPT_TOLERANCE_PCT = 10;

export type ReceiptLineInput = {
  id: string;
  name: string;
  ordered: number;
  previous: number;
  entered: string;
  reason?: string;
};

export type ReceiptLineResult = {
  id: string;
  qty: number;
  delta: number;
  variance: 'exact' | 'over' | 'short';
  overTolerance: boolean;
  reason: string;
};

export type ReceiptPlan =
  | { ok: true; lines: ReceiptLineResult[]; status: 'partial' | 'received'; warnings: string[] }
  | { ok: false; error: string };

export function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function toleranceLimit(ordered: number, tolerancePct: number): number {
  return round4(ordered * (1 + tolerancePct / 100));
}

/** No clamping: the entered quantity is what posts. Over-tolerance needs admin + reason. */
export function planReceipt(
  lines: ReceiptLineInput[],
  opts: { tolerancePct: number; isAdmin: boolean }
): ReceiptPlan {
  const out: ReceiptLineResult[] = [];
  const warnings: string[] = [];
  for (const l of lines) {
    const raw = l.entered.trim();
    const qty = raw === '' ? 0 : Number(raw);
    if (!Number.isFinite(qty) || qty < 0) return { ok: false, error: `${l.name}: enter a quantity of 0 or more` };
    const q = round4(qty);
    const reason = (l.reason ?? '').trim();
    const overTolerance = q > toleranceLimit(l.ordered, opts.tolerancePct);
    if (overTolerance && !(opts.isAdmin && reason)) {
      return {
        ok: false,
        error: `${l.name}: ${q} is more than ${opts.tolerancePct}% over the ordered ${l.ordered}. An admin must receive it with a reason.`,
      };
    }
    const variance = q > l.ordered ? 'over' : q < l.ordered ? 'short' : 'exact';
    if (variance === 'over') warnings.push(`${l.name}: ${round4(q - l.ordered)} more than ordered`);
    if (variance === 'short') warnings.push(`${l.name}: ${round4(l.ordered - q)} less than ordered`);
    out.push({ id: l.id, qty: q, delta: round4(q - l.previous), variance, overTolerance, reason });
  }
  if (out.every((l) => l.qty === 0)) return { ok: false, error: 'At least one item must be marked as received' };
  const status = out.every((l, i) => l.qty >= lines[i].ordered) ? 'received' : 'partial';
  return { ok: true, lines: out, status, warnings };
}

export function rpcLines(plan: Extract<ReceiptPlan, { ok: true }>) {
  return plan.lines.map((l) => ({
    purchase_order_item_id: l.id,
    quantity_received: l.qty,
    ...(l.reason ? { reason: l.reason } : {}),
  }));
}
