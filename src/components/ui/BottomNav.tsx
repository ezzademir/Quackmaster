import { Link, useLocation } from 'react-router-dom';

export type BottomNavItem = {
  path: string;
  label: string;
  icon: React.ElementType;
  exact?: boolean;
};

export function BottomNav({ items }: { items: BottomNavItem[] }) {
  const location = useLocation();

  return (
    <nav
      className="fixed inset-x-0 bottom-0 z-30 border-t border-stone-200 bg-white md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      aria-label="Primary"
    >
      <ul className="mx-auto flex max-w-lg items-stretch">
        {items.map(({ path, label, icon: Icon, exact = true }) => {
          const active = exact ? location.pathname === path : location.pathname.startsWith(path);
          return (
            <li key={path} className="flex-1">
              <Link
                to={path}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 px-1 text-[11px] font-medium transition-colors ${
                  active ? 'text-brand-700' : 'text-stone-500 hover:text-stone-800'
                }`}
              >
                <Icon size={20} strokeWidth={active ? 2.25 : 1.75} className="shrink-0" aria-hidden />
                <span className="truncate">{label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
