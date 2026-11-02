import type { ReactNode } from 'react';

/** iOS segmented control. One submodule is on screen. Switching does not leave the page. */
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
    <div
      data-no-swipe
      className="inline-flex max-w-full gap-1 overflow-x-auto rounded-full bg-black/5 p-1 scrollbar-none"
    >
      {items.map((item) => {
        const selected = value === item.id;
        return (
          <button
            key={item.id}
            type="button"
            aria-pressed={selected}
            onClick={() => onChange(item.id)}
            className={`min-h-9 shrink-0 rounded-full px-4 text-[13px] font-semibold tracking-tight transition-colors ${
              selected ? 'bg-white text-brand-800 shadow-sm' : 'text-stone-500'
            }`}
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
