import type { ReactNode } from 'react';

/**
 * Primary action bar: fixed above the home indicator (and supervisor bottom nav) on mobile;
 * in-flow on md+.
 */
export function StickyActions({
  children,
  className = '',
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <>
      {/* Spacer so fixed bar doesn't cover form content on mobile */}
      <div className="h-20 md:hidden" aria-hidden />
      <div
        className={`fixed inset-x-0 z-20 border-t border-stone-200 bg-white/95 px-4 py-3 backdrop-blur-sm md:static md:z-auto md:border-0 md:bg-transparent md:p-0 md:backdrop-blur-none ${className}`.trim()}
        style={{
          bottom: 'calc(var(--outlet-bottom-nav, 0px) + env(safe-area-inset-bottom, 0px))',
        }}
      >
        <div className="mx-auto flex w-full max-w-7xl flex-col gap-2 sm:flex-row sm:justify-end">{children}</div>
      </div>
    </>
  );
}
