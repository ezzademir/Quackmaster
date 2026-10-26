import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  FlaskConical,
  Boxes,
  Truck,
  Settings,
  Menu,
  BookOpenText,
  LogOut,
  ChevronDown,
  Users,
  CircleDollarSign,
  Trash2,
  Scale,
  ClipboardList,
  ClipboardCheck,
  GitBranch,
  BarChart3,
  PackageCheck,
  PieChart,
  Receipt,
} from 'lucide-react';
import { useAuth } from '../utils/auth';
import { crumbForPath, sectionIsActive, visibleSections } from '../utils/workflowNav';
import { BottomNav } from './ui/BottomNav';

const outletNav = [
  { path: '/sales', label: 'Outlet sales', icon: CircleDollarSign, exact: true },
  { path: '/waste', label: 'Waste', icon: Trash2, exact: true },
  { path: '/stock-take', label: 'Stock take', icon: ClipboardList, exact: true },
];

const supervisorBottomNav = [
  { path: '/sales', label: 'Sales', icon: CircleDollarSign, exact: true },
  { path: '/waste', label: 'Waste', icon: Trash2, exact: true },
  { path: '/stock-take', label: 'Stock take', icon: ClipboardList, exact: true },
];

const procurementNav = [
  { path: '/procurement', label: 'Purchase orders', icon: ShoppingCart, exact: false },
  { path: '/receiving', label: 'Receiving', icon: PackageCheck, exact: true },
  { path: '/bills', label: 'Bills', icon: Receipt, exact: true },
  { path: '/suppliers', label: 'Suppliers', icon: Truck, exact: true },
];

const SECTION_ICON = {
  today: LayoutDashboard,
  buy: ShoppingCart,
  kitchen: FlaskConical,
  outlets: Truck,
  books: BookOpenText,
} as const;

const TASK_ICON: Record<string, React.ElementType> = {
  '/': LayoutDashboard,
  '/procurement': ShoppingCart,
  '/receiving': PackageCheck,
  '/bills': Receipt,
  '/suppliers': Truck,
  '/production': FlaskConical,
  '/inventory': Boxes,
  '/genealogy': GitBranch,
  '/distribution': Truck,
  '/sales': CircleDollarSign,
  '/waste': Trash2,
  '/stock-take': ClipboardList,
  '/costing': PieChart,
  '/audit': ClipboardCheck,
  '/reconciliation': Scale,
  '/pos-compare': BarChart3,
  '/users': Users,
  '/ledger': BookOpenText,
  '/settings': Settings,
};

function NavItem({
  path,
  label,
  icon: Icon,
  exact,
  collapsed,
}: {
  path: string;
  label: string;
  icon: React.ElementType;
  exact: boolean;
  collapsed: boolean;
}) {
  const location = useLocation();
  const active = exact ? location.pathname === path : location.pathname.startsWith(path);
  return (
    <Link
      to={path}
      title={collapsed ? label : undefined}
      className={`relative flex min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors md:min-h-0 ${
        active
          ? 'bg-stone-100 text-stone-900'
          : 'text-stone-600 hover:bg-stone-50 hover:text-stone-900'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      {active && (
        <span
          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-brand-600"
          aria-hidden
        />
      )}
      <Icon size={18} className={`shrink-0 ${active ? 'text-brand-700' : ''}`} />
      {!collapsed && <span>{label}</span>}
    </Link>
  );
}

function NavSection({
  title,
  collapsed,
  items,
}: {
  title: string;
  collapsed: boolean;
  items: { path: string; label: string; icon: React.ElementType; exact: boolean }[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      {!collapsed && (
        <p className="mb-1.5 px-2.5 text-[10px] font-medium uppercase tracking-wider text-stone-400">
          {title}
        </p>
      )}
      <ul className="space-y-0.5">
        {items.map((item) => (
          <li key={item.path}>
            <NavItem {...item} collapsed={collapsed} />
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { profile, user, isAdmin, isSupervisor, isProcurement, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const sections = visibleSections(isAdmin);
  const crumb = crumbForPath(location.pathname);

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  const initials = profile?.full_name
    ? profile.full_name
        .split(' ')
        .map((n) => n[0])
        .join('')
        .toUpperCase()
        .slice(0, 2)
    : (user?.email?.[0] ?? 'U').toUpperCase();

  return (
    <div
      className="flex h-dvh min-h-0 max-h-dvh overflow-hidden bg-[#f2f2f7] pt-[env(safe-area-inset-top,0px)] pb-[env(safe-area-inset-bottom,0px)] pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]"
    >
      <aside
        className={`fixed z-40 hidden min-h-0 flex-shrink-0 flex-col border-r border-white/50 bg-white/70 backdrop-blur-2xl md:relative md:flex md:h-full md:w-60 ${
          collapsed ? 'md:w-[72px]' : ''
        }`}
      >
        <div
          className={`flex h-14 items-center justify-between border-b border-stone-100 px-4 md:justify-start ${
            collapsed ? 'md:justify-center' : 'gap-3'
          }`}
        >
          <img
            src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`}
            alt="Quackmaster"
            className="h-8 w-8 flex-shrink-0"
          />
          {!collapsed && (
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-stone-900 leading-tight">Quackmaster</div>
              <div className="text-xs text-stone-400 leading-tight">ERP</div>
            </div>
          )}
        </div>

        <nav className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-y-contain px-2.5 py-4">
          {isProcurement ? (
            <NavSection title="Procurement" collapsed={collapsed} items={procurementNav} />
          ) : isSupervisor ? (
            <NavSection title="Outlet" collapsed={collapsed} items={outletNav} />
          ) : (
            sections.map((section) => (
              <NavSection
                key={section.id}
                title={section.label}
                collapsed={collapsed}
                items={section.tasks.map((task) => ({
                  path: task.path,
                  label: task.label,
                  icon: TASK_ICON[task.path] ?? SECTION_ICON[section.id],
                  exact: task.path === '/' || task.path === '/bills' || task.path === '/receiving',
                }))}
              />
            ))
          )}
        </nav>

        <div className="hidden border-t border-stone-100 p-2.5 md:block">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className={`flex w-full min-h-11 items-center gap-3 rounded-lg px-2.5 py-2 text-stone-500 transition-colors hover:bg-stone-50 hover:text-stone-800 ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <Menu size={18} />
            {!collapsed && <span className="text-sm font-medium">Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 flex-shrink-0 items-center justify-between gap-3 border-b border-white/50 bg-white/70 px-4 backdrop-blur-xl">
          <div className="min-w-0">
            <p className="text-[11px] font-medium uppercase tracking-wide text-stone-400">{crumb.section}</p>
            <p className="truncate text-[17px] font-semibold tracking-tight text-stone-900">{crumb.page}</p>
          </div>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              className="flex min-h-11 items-center gap-2.5 rounded-lg px-2 py-1.5 transition-colors hover:bg-stone-50 sm:px-3"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-stone-100 text-sm font-medium text-stone-700">
                {initials}
              </div>
              <div className="hidden text-left sm:block">
                <div className="text-sm font-medium leading-tight text-stone-900">
                  {profile?.full_name || user?.email?.split('@')[0] || 'User'}
                </div>
                <div className="text-xs capitalize leading-tight text-stone-400">{profile?.role ?? 'staff'}</div>
              </div>
              <ChevronDown size={14} className="text-stone-400" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-stone-200 bg-white py-1">
                  <div className="border-b border-stone-100 px-4 py-3">
                    <p className="truncate text-sm font-medium text-stone-900">{profile?.full_name || 'User'}</p>
                    <p className="truncate text-xs text-stone-400">{user?.email}</p>
                    <span className="mt-1.5 inline-flex text-xs font-medium capitalize text-stone-500">
                      {profile?.role ?? 'staff'}
                    </span>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-red-600 transition-colors hover:bg-red-50"
                  >
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain pb-24 touch-pan-y md:pb-0">
          <div className="mx-auto w-full min-w-0 max-w-7xl px-4 py-5 sm:px-5 md:px-6 md:py-8">
            {children}
          </div>
        </main>
      </div>

      <BottomNav
        items={
          isProcurement
            ? procurementNav
            : isSupervisor
              ? supervisorBottomNav
              : sections.map((section) => ({
                  path: section.home,
                  label: section.label,
                  icon: SECTION_ICON[section.id],
                  match: (path: string) => sectionIsActive(path, section),
                }))
        }
      />
    </div>
  );
}
