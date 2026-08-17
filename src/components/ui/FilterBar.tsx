import type { ReactNode } from 'react';
import { DateFilter, type DateFilterType } from '../DateFilter';
import type { DateRange } from '../../utils/dateRange';

export function FilterBar({
  children,
  onPeriodChange,
  periodHint,
  defaultType,
  label = 'View period',
}: {
  children?: ReactNode;
  onPeriodChange?: (range: DateRange | null, type: DateFilterType) => void;
  periodHint?: string;
  defaultType?: DateFilterType;
  label?: string;
}) {
  return (
    <div className="flex flex-wrap items-end gap-3">
      {children}
      {onPeriodChange ? (
        <DateFilter
          label={label}
          hint={periodHint}
          defaultType={defaultType}
          onFilterChange={onPeriodChange}
        />
      ) : null}
    </div>
  );
}
