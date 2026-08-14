export function StatusBadge({ status }: { status: string }) {
  const key = String(status ?? '').toLowerCase().trim();
  const map: Record<string, string> = {
    pending: 'bg-blue-100 text-blue-700',
    dispatched: 'bg-amber-100 text-amber-700',
    received: 'bg-emerald-100 text-emerald-700',
    cancelled: 'bg-gray-100 text-gray-700',
  };
  return (
    <span className={`inline-flex rounded-full px-2.5 py-0.5 text-xs font-semibold capitalize ${map[key] ?? 'bg-gray-100 text-gray-700'}`}>
      {key.replace(/_/g, ' ') || '—'}
    </span>
  );
}
