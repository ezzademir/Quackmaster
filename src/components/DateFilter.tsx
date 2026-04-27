import { useState } from 'react';
import { ChevronDown } from 'lucide-react';
import { DateRange, getToday, getYesterday, getThisWeek, getLastWeek, getLast7Days, getThisMonth, getLastMonth, formatDateForInput } from '../utils/dateRange';

export type DateFilterType = 'all' | 'today' | 'yesterday' | 'thisWeek' | 'lastWeek' | 'last7Days' | 'thisMonth' | 'lastMonth' | 'custom';

interface DateFilterProps {
  onFilterChange: (range: DateRange | null, filterType: DateFilterType) => void;
  className?: string;
}

export function DateFilter({ onFilterChange, className = '' }: DateFilterProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [filterType, setFilterType] = useState<DateFilterType>('all');
  const [customStartDate, setCustomStartDate] = useState(formatDateForInput(new Date()));
  const [customEndDate, setCustomEndDate] = useState(formatDateForInput(new Date()));

  function handleFilterSelect(type: DateFilterType) {
    setFilterType(type);
    setIsOpen(false);

    let range: DateRange | null = null;
    switch (type) {
      case 'today':
        range = getToday();
        break;
      case 'yesterday':
        range = getYesterday();
        break;
      case 'thisWeek':
        range = getThisWeek();
        break;
      case 'lastWeek':
        range = getLastWeek();
        break;
      case 'last7Days':
        range = getLast7Days();
        break;
      case 'thisMonth':
        range = getThisMonth();
        break;
      case 'lastMonth':
        range = getLastMonth();
        break;
      case 'custom':
        setIsOpen(true);
        return;
      case 'all':
      default:
        range = null;
    }

    onFilterChange(range, type);
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

  const filterLabel: Record<DateFilterType, string> = {
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

  return (
    <div className={`relative ${className}`}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="inline-flex items-center gap-2 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 transition-colors"
      >
        📅 {filterLabel[filterType]}
        <ChevronDown size={14} className={`transition-transform ${isOpen ? 'rotate-180' : ''}`} />
      </button>

      {isOpen && (
        <div className="absolute right-0 z-10 mt-2 w-56 rounded-lg border border-gray-200 bg-white shadow-lg">
          <div className="space-y-1 p-2">
            <button
              onClick={() => handleFilterSelect('all')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'all' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              All time
            </button>
            <button
              onClick={() => handleFilterSelect('today')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'today' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Today
            </button>
            <button
              onClick={() => handleFilterSelect('yesterday')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'yesterday' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Yesterday
            </button>
            <button
              onClick={() => handleFilterSelect('thisWeek')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'thisWeek' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              This week
            </button>
            <button
              onClick={() => handleFilterSelect('lastWeek')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'lastWeek' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Last week
            </button>
            <button
              onClick={() => handleFilterSelect('last7Days')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'last7Days' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Last 7 days
            </button>
            <button
              onClick={() => handleFilterSelect('thisMonth')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'thisMonth' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              This month
            </button>
            <button
              onClick={() => handleFilterSelect('lastMonth')}
              className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                filterType === 'lastMonth' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
              }`}
            >
              Last month
            </button>
            <div className="border-t border-gray-100 pt-2">
              <button
                onClick={() => handleFilterSelect('custom')}
                className={`w-full rounded px-3 py-2 text-left text-sm transition-colors ${
                  filterType === 'custom' ? 'bg-blue-50 text-blue-700 font-medium' : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                Custom range
              </button>
              {filterType === 'custom' && (
                <div className="mt-3 space-y-3 border-t border-gray-100 pt-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Start Date</label>
                    <input
                      type="date"
                      value={customStartDate}
                      onChange={(e) => setCustomStartDate(e.target.value)}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">End Date</label>
                    <input
                      type="date"
                      value={customEndDate}
                      onChange={(e) => setCustomEndDate(e.target.value)}
                      className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                  </div>
                  <button
                    onClick={handleCustomDateApply}
                    className="w-full rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700 transition-colors"
                  >
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
