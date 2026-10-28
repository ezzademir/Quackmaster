import type { ReactNode } from 'react';

type StatusTone = 'neutral' | 'brand' | 'success' | 'warning' | 'danger';

const toneDot: Record<StatusTone, string> = {
  neutral: 'bg-stone-400',
  brand: 'bg-brand-600',
  success: 'bg-emerald-500',
  warning: 'bg-amber-500',
  danger: 'bg-red-500',
};

const toneText: Record<StatusTone, string> = {
  neutral: 'text-stone-600',
  brand: 'text-brand-800',
  success: 'text-emerald-700',
  warning: 'text-amber-800',
  danger: 'text-red-700',
};

export function Status({
  children,
  tone = 'neutral',
}: {
  children: ReactNode;
  tone?: StatusTone;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${toneText[tone]}`}>
      <span className={`size-1.5 shrink-0 rounded-full ${toneDot[tone]}`} aria-hidden />
      {children}
    </span>
  );
}
