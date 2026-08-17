import type { ReactNode } from 'react';

export function PageHeader({
  title,
  description,
  actions,
  filters,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  filters?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-stone-900">{title}</h1>
        {description ? <div className="mt-1 text-sm text-stone-500">{description}</div> : null}
      </div>
      {(actions || filters) && (
        <div className="flex flex-col items-stretch gap-2 sm:items-end">
          {actions ? <div className="flex flex-wrap items-center gap-2 sm:justify-end">{actions}</div> : null}
          {filters ? <div className="flex flex-wrap items-end gap-3 sm:justify-end">{filters}</div> : null}
        </div>
      )}
    </div>
  );
}
