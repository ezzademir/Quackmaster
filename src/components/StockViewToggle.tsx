import type { StockView } from '../utils/stockView';

export function StockViewToggle({
  value,
  onChange,
  className = '',
}: {
  value: StockView;
  onChange: (view: StockView) => void;
  className?: string;
}) {
  return (
    <div className={className}>
      <div className="inline-flex gap-1 rounded-lg border border-gray-200 bg-gray-50 p-1">
        {(
          [
            ['in_stock', 'In stock'],
            ['all', 'All lots'],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => onChange(id)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              value === id ? 'bg-white text-amber-900 shadow-sm' : 'text-gray-600 hover:text-gray-900'
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="mt-1 text-xs text-gray-500">Zeros hidden. Switch to All lots for empty / audit.</p>
    </div>
  );
}
