import type { ReactNode } from 'react';

export function Tabs<T extends string>({
  value,
  onChange,
  items,
}: {
  value: T;
  onChange: (next: T) => void;
  items: { id: T; label: ReactNode }[];
}) {
  return (
    <div className="border-b border-stone-200">
      <nav className="-mx-1 flex gap-4 overflow-x-auto overscroll-x-contain px-1">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => onChange(item.id)}
            className={`shrink-0 border-b-2 px-1 py-3 text-sm font-medium transition-colors ${
              value === item.id
                ? 'border-brand-600 text-brand-800'
                : 'border-transparent text-stone-500 hover:text-stone-800'
            }`}
          >
            {item.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
