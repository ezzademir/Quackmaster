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
  const valueTone =
    tone === 'brand'
      ? 'text-brand-800'
      : tone === 'danger'
        ? 'text-red-700'
        : tone === 'muted'
          ? 'text-stone-500'
          : 'text-stone-900';

  return (
    <div className="panel p-4">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs font-medium text-stone-500">{label}</p>
        {icon ? <div className="text-stone-400">{icon}</div> : null}
      </div>
      <p className={`mt-2 text-2xl font-semibold tabular-nums tracking-tight ${valueTone}`}>{value}</p>
      {sub ? <p className="mt-1 text-xs text-stone-400">{sub}</p> : null}
    </div>
  );
}
