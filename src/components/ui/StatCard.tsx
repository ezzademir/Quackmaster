import type { ReactNode } from 'react';

export function StatCard({
  icon,
  label,
  value,
  sub,
  tone = 'default',
}: {
  icon?: ReactNode;
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'default' | 'brand' | 'muted' | 'danger';
}) {
  const iconWrap =
    tone === 'brand'
      ? 'bg-brand-50 text-brand-700'
      : tone === 'danger'
        ? 'bg-red-50 text-red-600'
        : tone === 'muted'
          ? 'bg-stone-100 text-stone-500'
          : 'bg-stone-100 text-stone-600';

  return (
    <div className="panel p-4">
      {icon ? <div className={`mb-2 inline-flex rounded-lg p-2 ${iconWrap}`}>{icon}</div> : null}
      <p className="text-xl font-bold tabular-nums text-stone-900">{value}</p>
      <p className="mt-0.5 text-xs font-medium text-stone-700">{label}</p>
      {sub ? <p className="text-[11px] text-stone-400">{sub}</p> : null}
    </div>
  );
}
