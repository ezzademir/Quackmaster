import { useEffect, useState } from 'react';
import { Calendar, ChevronDown } from 'lucide-react';
import {
  DateRange,
  getToday,
  getYesterday,
  getThisWeek,
  getLastWeek,
  getLast7Days,
  getThisMonth,
  getLastMonth,
  formatDateForInput,
} from '../utils/dateRange';

export type DateFilterType =
  | 'all'
  | 'today'
  | 'yesterday'
  | 'thisWeek'
  | 'lastWeek'
  | 'last7Days'
  | 'thisMonth'
  | 'lastMonth'
  | 'custom';

export const DATE_FILTER_LABELS: Record<DateFilterType, string> = {
  all: 'All time',
  today: 'Today',
  yesterday: 'Yesterday',
  thisWeek: 'This week',
  lastWeek: 'Last week',
  last7Days: 'Last 7 days',
  thisMonth: 'This month',
  lastMonth: 'Last month',
  custom: 'Custom range',
};

export function rangeForFilterType(type: DateFilterType): DateRange | null {
  switch (type) {
    case 'today':
      return getToday();
    case 'yesterday':
      return getYesterday();
    case 'thisWeek':
      return getThisWeek();
    case 'lastWeek':
      return getLastWeek();
    case 'last7Days':
      return getLast7Days();
    case 'thisMonth':
      return getThisMonth();
    case 'lastMonth':
      return getLastMonth();
    case 'custom':
    case 'all':
    default:
      return null;
  }
}

interface DateFilterProps {
  onFilterChange: (range: DateRange | null, filterType: DateFilterType) => void;
  className?: string;
  hint?: string;
  label?: string;
  defaultType?: DateFilterType;
}

export function DateFilter({
  onFilterChange,
  className = '',
  hint,
  label = 'View period',
  defaultType = 'all',
}: DateFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterType, setFilterType] = useState<DateFilterType>(defaultType);
  const [customStartDate, setCustomStartDate] = useState(formatDateForInput(new Date()));
  const [customEndDate, setCustomEndDate] = useState(formatDateForInput(new Date()));

  useEffect(() => {
    if (defaultType === 'all') return;
    onFilterChange(rangeForFilterType(defaultType), defaultType);
    // Notify parent once when a non-all default is requested.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleFilterSelect(type: DateFilterType) {
    setFilterType(type);
    if (type === 'custom') {
      setIsOpen(true);
      return;
    }
    setIsOpen(false);
    onFilterChange(rangeForFilterType(type), type);
  }

  function handleCustomDateApply() {
    const start = new Date(customStartDate);
    start.setHours(0, 0, 0, 0);
    const end = new Date(customEndDate);
    end.setHours(23, 59, 59, 999);

    if (start > end) {
      alert('Start date must be before end date');
      return;
    }

    onFilterChange({ start, end }, 'custom');
    setIsOpen(false);
  }

  const optionClass = (type: DateFilterType) =>
    `w-full rounded px-3 py-2 text-left text-sm transition-colors ${
      filterType === type ? 'bg-brand-50 text-brand-800 font-medium' : 'text-stone-700 hover:bg-stone-100'
    }`;

  return (
    <div className={`relative min-w-0 ${className}`}>
      <div className="flex w-full min-w-0 flex-col items-stretch gap-1 sm:items-end">
        <span className="text-xs font-medium text-stone-600">{label}</span>
        <button
          type="button"
          onClick={() => setIsOpen(!isOpen)}
          className="inline-flex w-full min-h-11 items-center justify-between gap-2 rounded-lg border border-stone-300 bg-white px-3 py-2 text-sm font-medium text-stone-800 hover:bg-stone-50 transition-colors sm:w-auto sm:justify-center"
        >
          <Calendar size={14} className="text-stone-500" />
          {DATE_FILTER_LABELS[filterType]}
          <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {hint ? <p className="max-w-xs text-xs text-stone-500 sm:text-right">{hint}</p> : null}
      </div>

      {isOpen && (
        <div className="absolute left-0 right-0 top-full z-10 mt-2 w-full rounded-lg border border-stone-200 bg-white shadow-lg sm:left-auto sm:right-0 sm:w-56">
          <div className="space-y-1 p-2">
            {(
              [
                'all',
                'today',
                'yesterday',
                'thisWeek',
                'lastWeek',
                'last7Days',
                'thisMonth',
                'lastMonth',
              ] as DateFilterType[]
            ).map((type) => (
              <button key={type} type="button" onClick={() => handleFilterSelect(type)} className={optionClass(type)}>
                {DATE_FILTER_LABELS[type]}
              </button>
            ))}
            <div className="border-t border-stone-100 pt-2">
              <button type="button" onClick={() => handleFilterSelect('custom')} className={optionClass('custom')}>
                Custom range
              </button>
              {filterType === 'custom' && (
                <div className="mt-3 space-y-3 border-t border-stone-100 pt-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-stone-700">Start date</label>
                    <input
                      type="date"
                      value={customStartDate}
                      onChange={(e) => setCustomStartDate(e.target.value)}
                      className="w-full rounded border border-stone-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-stone-700">End date</label>
                    <input
                      type="date"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      className="w-full rounded border border-stone-300 px-2 py-1 text-xs focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
                    />
                  </div>
                  <button type="button" onClick={handleCustomDateApply} className="btn-primary w-full py-1 text-xs">
                    Apply
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
