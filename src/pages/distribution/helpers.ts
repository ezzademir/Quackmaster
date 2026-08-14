import type { DistributionTab } from './types';

/** Calendar date from DB `date` or timestamptz — avoids UTC midnight shifting the displayed day */
export function formatSupplyCalendarDate(value: string | undefined | null): string {
  if (value == null || value === '') return '—';
  const trimmed = String(value).trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})/.exec(trimmed);
  if (dateOnly) {
    const y = Number(dateOnly[1]);
    const mo = Number(dateOnly[2]) - 1;
    const day = Number(dateOnly[3]);
    const d = new Date(y, mo, day);
    if (!Number.isNaN(d.getTime())) return d.toLocaleDateString();
  }
  const d = new Date(trimmed);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString();
}

export function supplyOrderAllowsAdminHardDelete(status: string | undefined): boolean {
  const s = String(status ?? '').toLowerCase().trim();
  return s === 'pending' || s === 'cancelled' || s === 'dispatched' || s === 'received';
}

export function supplyOrderAdminDeleteConfirmDetail(status: string | undefined): string {
  const stNorm = String(status ?? '').toLowerCase().trim();
  switch (stNorm) {
    case 'pending':
      return 'Reserved hub stock will be released.';
    case 'dispatched':
      return 'Hub shipment will be reversed (stock returned to hub batches). Outlet on-hand was not increased until receipt, so it is unchanged.';
    case 'received':
      return 'Outlet on-hand will be reduced and hub finished-goods stock will be restored for each line (admin correction).';
    case 'cancelled':
      return 'This removes the cancelled record only. Inventory is not adjusted automatically; if this order was dispatched before cancel, correct hub/outlet stock manually if needed.';
    default:
      return 'This order will be permanently removed.';
  }
}

export function normalizeSOStatus(status: string | undefined): string {
  return String(status ?? '').toLowerCase().trim();
}

export function tabClass(current: DistributionTab, t: DistributionTab): string {
  return `border-b-2 px-1 py-4 text-sm font-medium transition-colors ${
    current === t ? 'border-teal-600 text-teal-600' : 'border-transparent text-gray-500 hover:text-gray-700'
  }`;
}
