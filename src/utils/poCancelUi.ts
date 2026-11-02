/** Client-side helpers for 089 PO cancel-request UI. No I/O. */

export const CANCEL_REASON_MAX = 1000;

const CANCEL_FAILURE_CODES = [
  'pending_request_exists',
  'bills_on_po',
  'not_authorized',
  'forbidden',
  'already_cancelled',
  'po_not_found',
  'reason_required',
  'reason_too_long',
  'request_already_decided',
  'request_not_found',
  'cannot_decide_own_request',
  'not_authenticated',
  'po_entity_required',
  'stock_entity_tag_required',
  'insufficient_hub_quantity',
  'hub_below_reserved',
  'insufficient_tagged_stock',
  'cannot_cancel_missing_hub_row',
  'missing_raw_material',
] as const;

export type CancelFailureCode = (typeof CANCEL_FAILURE_CODES)[number];

const CANCEL_FAILURE_TEXT: Record<CancelFailureCode, string> = {
  pending_request_exists: 'A cancellation request is already pending on this order.',
  bills_on_po: 'This purchase order has a supplier bill. Handle the bill through accounting first.',
  not_authorized: 'You can only request cancel on a purchase order tagged with your business (MH / QT).',
  forbidden: 'You are not allowed to do that.',
  already_cancelled: 'This purchase order is already cancelled.',
  po_not_found: 'This purchase order no longer exists.',
  reason_required: 'A reason is required',
  reason_too_long: 'Reason must be at most 1000 characters',
  request_already_decided: 'This cancel request has already been decided.',
  request_not_found: 'This cancel request no longer exists.',
  cannot_decide_own_request: 'Another admin must decide this',
  not_authenticated: 'You must be signed in to do that.',
  po_entity_required: 'This purchase order needs a business tag (MH / QT) before it can be cancelled.',
  stock_entity_tag_required:
    'This order has untagged received stock and cannot be cancelled while tags are enforced.',
  insufficient_hub_quantity: 'Hub stock is too low to reverse the received quantities.',
  hub_below_reserved: 'Cancelling would leave hub stock below the reserved quantity.',
  insufficient_tagged_stock: 'Tagged hub stock is too low to reverse the received quantities.',
  cannot_cancel_missing_hub_row:
    'Hub stock for a received material is missing, so this order cannot be cancelled.',
  missing_raw_material: 'A received line has no raw material, so this order cannot be cancelled.',
};

export type NormalisedCancelFailure = {
  code: string;
  message: string;
  detail: string;
  hint: string;
  billNumbers: string[];
};

export type PostgrestLikeError = {
  message?: string | null;
  details?: string | null;
  hint?: string | null;
};

export type SoftCancelFailure = {
  success?: boolean;
  error?: string | null;
  message?: string | null;
  detail?: string | null;
  hint?: unknown;
  bill_numbers?: unknown;
};

export type PoCancelRequestStatus = 'pending' | 'approved' | 'rejected';

export type PoCancelRequestRow = {
  id: string;
  purchase_order_id: string;
  requested_by: string;
  requested_at: string;
  reason: string;
  status: PoCancelRequestStatus;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_reason?: string | null;
};

export type PoCancelNoticeKind = 'pending' | 'rejected' | 'decide_pending_first' | 'own_request';

export type PoCancelNotice = {
  kind: PoCancelNoticeKind;
  requestedAt?: string;
  reason?: string;
  decidedAt?: string;
  decisionReason?: string;
};

export type PoCancelActionFlags = {
  requestCancel: boolean;
  directCancel: boolean;
  approve: boolean;
  reject: boolean;
  notices: PoCancelNotice[];
};

export type EntityChip = {
  label: 'MH' | 'QT' | 'Untagged';
  tone: 'mh' | 'qt' | 'untagged';
};

export type CancelRole = 'admin' | 'procurement' | 'staff' | 'supervisor' | 'pending';

export type CancelPoLike = {
  status?: string | null;
  items?: Array<{ quantity_received?: number | null }>;
};

function isCancelFailureCode(value: string): value is CancelFailureCode {
  return (CANCEL_FAILURE_CODES as readonly string[]).includes(value);
}

export function cancelFailureText(code: string | undefined | null): string {
  const trimmed = String(code ?? '').trim();
  if (isCancelFailureCode(trimmed)) return CANCEL_FAILURE_TEXT[trimmed];
  return trimmed ? `Could not complete cancellation (${trimmed}).` : 'Could not complete cancellation.';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function asString(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

export function parseBillNumbers(hint: unknown, billNumbers?: unknown): string[] {
  if (Array.isArray(billNumbers)) {
    return billNumbers.map((n) => String(n).trim()).filter(Boolean);
  }
  if (typeof billNumbers === 'string') {
    const fromField = parseBillNumbers(billNumbers);
    if (fromField.length) return fromField;
  }
  if (Array.isArray(hint)) {
    return hint.map((n) => String(n).trim()).filter(Boolean);
  }
  const raw = asString(hint).trim();
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.map((n) => String(n).trim()).filter(Boolean);
    }
  } catch {
    // HINT may be a single bill number or a stock-figure object.
  }
  return [];
}

function extractCode(data: SoftCancelFailure | null, error: PostgrestLikeError | null): string {
  const soft = String(data?.error ?? '').trim();
  if (soft) return soft;
  const msg = String(error?.message ?? '').trim();
  if (!msg) return '';
  if (isCancelFailureCode(msg)) return msg;
  for (const code of CANCEL_FAILURE_CODES) {
    if (msg === code || msg.includes(code)) return code;
  }
  return msg;
}

export function normaliseCancelFailure(input: {
  data?: unknown;
  error?: PostgrestLikeError | null;
}): NormalisedCancelFailure {
  const rec = asRecord(input.data);
  const soft: SoftCancelFailure | null =
    rec && rec.success === false ? (rec as SoftCancelFailure) : rec && rec.error ? (rec as SoftCancelFailure) : null;
  const error = input.error ?? null;
  const code = extractCode(soft, error);
  const detail = asString(soft?.detail).trim() || asString(error?.details).trim();
  const hintRaw = soft?.hint ?? error?.hint ?? '';
  const hint = typeof hintRaw === 'string' ? hintRaw : hintRaw == null ? '' : JSON.stringify(hintRaw);
  const serverMessage = asString(soft?.message).trim();
  const errorMessage = asString(error?.message).trim();
  const distinctServerMessage =
    serverMessage && serverMessage !== code
      ? serverMessage
      : errorMessage && errorMessage !== code && !isCancelFailureCode(errorMessage)
        ? errorMessage
        : '';
  const message = isCancelFailureCode(code)
    ? distinctServerMessage || cancelFailureText(code)
    : serverMessage || errorMessage || cancelFailureText(code);
  return {
    code,
    message,
    detail,
    hint,
    billNumbers: parseBillNumbers(hintRaw, soft?.bill_numbers),
  };
}

export function validateCancelReason(
  text: string
): { ok: true; reason: string } | { ok: false; message: string; code: CancelFailureCode } {
  const reason = String(text ?? '').trim();
  if (!reason) {
    return { ok: false, message: CANCEL_FAILURE_TEXT.reason_required, code: 'reason_required' };
  }
  if (reason.length > CANCEL_REASON_MAX) {
    return { ok: false, message: CANCEL_FAILURE_TEXT.reason_too_long, code: 'reason_too_long' };
  }
  return { ok: true, reason };
}

export function latestRequestByPo(rows: PoCancelRequestRow[]): Map<string, PoCancelRequestRow> {
  const latest = new Map<string, PoCancelRequestRow>();
  for (const row of rows) {
    const prev = latest.get(row.purchase_order_id);
    if (!prev) {
      latest.set(row.purchase_order_id, row);
      continue;
    }
    const prevTs = Date.parse(prev.requested_at) || 0;
    const nextTs = Date.parse(row.requested_at) || 0;
    if (nextTs >= prevTs) latest.set(row.purchase_order_id, row);
  }
  return latest;
}

export function poUsesCancelRpc(po: CancelPoLike): boolean {
  const items = po.items ?? [];
  if (items.some((i) => (Number(i.quantity_received) || 0) > 0)) return true;
  const st = String(po.status ?? '').trim().toLowerCase();
  return st === 'partial' || st === 'received';
}

export function poCancelActions({
  role,
  uid,
  po,
  latestRequest,
}: {
  role: string;
  uid: string;
  po: CancelPoLike;
  latestRequest?: PoCancelRequestRow | null;
}): PoCancelActionFlags {
  const notices: PoCancelNotice[] = [];
  const flags: PoCancelActionFlags = {
    requestCancel: false,
    directCancel: false,
    approve: false,
    reject: false,
    notices,
  };
  if (!poUsesCancelRpc(po)) return flags;

  const pending = latestRequest?.status === 'pending' ? latestRequest : null;
  const rejected = latestRequest?.status === 'rejected' ? latestRequest : null;
  const normalisedRole = String(role ?? '').trim().toLowerCase();

  if (pending) {
    notices.push({
      kind: 'pending',
      requestedAt: pending.requested_at,
      reason: pending.reason,
    });
  } else if (rejected) {
    notices.push({
      kind: 'rejected',
      decidedAt: rejected.decided_at ?? '',
      decisionReason: rejected.decision_reason ?? '',
    });
  }

  if (normalisedRole === 'procurement') {
    flags.requestCancel = !pending;
    return flags;
  }

  if (normalisedRole === 'admin') {
    if (pending) {
      notices.push({ kind: 'decide_pending_first' });
      const own = pending.requested_by === uid;
      if (own) {
        notices.push({ kind: 'own_request' });
      } else {
        flags.approve = true;
        flags.reject = true;
      }
      return flags;
    }
    flags.directCancel = true;
    return flags;
  }

  return flags;
}

export function entityChip(code: string | null | undefined): EntityChip {
  const n = String(code ?? '').trim().toUpperCase();
  if (n === 'MH') return { label: 'MH', tone: 'mh' };
  if (n === 'QT') return { label: 'QT', tone: 'qt' };
  return { label: 'Untagged', tone: 'untagged' };
}

export function formatMytDateTime(iso: string | null | undefined): string {
  const raw = String(iso ?? '').trim();
  if (!raw) return '—';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleString('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
