import { useEffect, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutDashboard,
  ShoppingCart,
  FlaskConical,
  Boxes,
  Truck,
  Settings,
  Menu,
  ChevronRight,
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
} from 'lucide-react';
import { useAuth } from '../utils/auth';

const mainNav = [{ path: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true }];

const hubNav = [
  { path: '/procurement', label: 'Procurement', icon: ShoppingCart, exact: false },
  { path: '/production', label: 'Production', icon: FlaskConical, exact: false },
  { path: '/inventory', label: 'Inventory', icon: Boxes, exact: false },
  { path: '/distribution', label: 'Distribution', icon: Truck, exact: false },
];

const outletNav = [
  { path: '/sales', label: 'Outlet sales', icon: CircleDollarSign, exact: true },
  { path: '/waste', label: 'Waste', icon: Trash2, exact: true },
  { path: '/stock-take', label: 'Stock take', icon: ClipboardList, exact: true },
];

const posCompareNav = [{ path: '/pos-compare', label: 'SHPOS vs QMERP', icon: BarChart3, exact: true }];

const findNav = [{ path: '/genealogy', label: 'Lot trace', icon: GitBranch, exact: true }];

const stockIntegrityNav = [
  { path: '/audit', label: 'Stock audit', icon: ClipboardCheck, exact: true },
  { path: '/reconciliation', label: 'Reconciliation', icon: Scale, exact: true },
];

const adminNav = [
  { path: '/users', label: 'Users', icon: Users, exact: false },
  { path: '/ledger', label: 'Change log', icon: BookOpenText, exact: false },
  { path: '/settings', label: 'Settings', icon: Settings, exact: false },
];

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
      className={`flex min-h-[2.75rem] items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-all md:min-h-0 ${
        active
          ? 'bg-brand-700 text-white shadow-sm'
          : 'text-stone-400 hover:bg-stone-800 hover:text-white'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      <Icon size={18} className="flex-shrink-0" />
      {!collapsed && <span>{label}</span>}
      {!collapsed && active && <ChevronRight size={14} className="ml-auto opacity-70" />}
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
        <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-stone-500">{title}</p>
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
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { profile, user, isAdmin, isSupervisor, signOut } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setSidebarOpen(false);
  }, [location.pathname]);

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
    <div className="flex h-dvh min-h-0 max-h-dvh bg-stone-50 pl-[env(safe-area-inset-left,0px)] pr-[env(safe-area-inset-right,0px)]">
      {sidebarOpen && (
        <div className="fixed inset-0 z-30 bg-black/50 md:hidden" onClick={() => setSidebarOpen(false)} />
      )}

      <aside
        className={`fixed md:relative z-40 flex min-h-0 flex-col bg-stone-900 transition-all duration-300 ease-in-out flex-shrink-0 h-dvh max-h-dvh ${
          sidebarOpen ? 'w-60' : '-translate-x-full'
        } md:translate-x-0 md:w-60 ${collapsed ? 'md:w-[72px]' : ''}`}
      >
        <div
          className={`flex h-16 items-center justify-between border-b border-stone-800 px-4 md:justify-start ${
            collapsed ? 'md:justify-center' : 'gap-3'
          }`}
        >
          <img
            src={`${import.meta.env.BASE_URL}Quackmaster_Logo.png`}
            alt="Quackmaster"
            className="h-9 w-9 flex-shrink-0"
          />
          {!collapsed && (
            <div>
              <div className="text-sm font-semibold text-white leading-tight">Quackmaster</div>
              <div className="text-xs text-stone-400 leading-tight">ERP</div>
            </div>
          )}
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            aria-label="Close menu"
            className="inline-flex size-11 items-center justify-center rounded-lg text-stone-400 hover:bg-stone-800 hover:text-white md:hidden"
          >
            <span className="text-2xl leading-none">&times;</span>
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-y-contain px-3 py-4 space-y-5">
          {isSupervisor ? (
            <NavSection title="Outlet" collapsed={collapsed} items={outletNav} />
          ) : (
            <>
              <NavSection title="Overview" collapsed={collapsed} items={mainNav} />
              <NavSection title="Hub" collapsed={collapsed} items={hubNav} />
              <NavSection title="Outlets" collapsed={collapsed} items={outletNav} />
              {isAdmin && <NavSection title="POS" collapsed={collapsed} items={posCompareNav} />}
              <NavSection title="Find" collapsed={collapsed} items={findNav} />
              {isAdmin && (
                <>
                  <NavSection title="Stock integrity" collapsed={collapsed} items={stockIntegrityNav} />
                  <NavSection title="Admin" collapsed={collapsed} items={adminNav} />
                </>
              )}
            </>
          )}
        </nav>

        <div className="hidden border-t border-stone-800 p-3 md:block">
          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            className={`flex w-full min-h-[2.75rem] items-center gap-3 rounded-lg px-2.5 py-2.5 text-stone-400 hover:bg-stone-800 hover:text-white transition-all ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <Menu size={18} />
            {!collapsed && <span className="text-sm font-medium">Collapse</span>}
          </button>
        </div>
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-16 flex-shrink-0 items-center justify-between gap-4 border-b border-stone-200 bg-white px-3 md:justify-end md:px-6">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            aria-label="Open menu"
            className="inline-flex size-11 items-center justify-center rounded-lg text-stone-600 hover:bg-stone-100 hover:text-stone-900 md:hidden"
          >
            <Menu size={22} className="shrink-0" aria-hidden />
          </button>
          <div className="relative">
            <button
              type="button"
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              aria-expanded={userMenuOpen}
              aria-haspopup="menu"
              className="flex min-h-11 items-center gap-2.5 rounded-xl px-2 py-1.5 hover:bg-stone-100 transition-colors sm:px-3 sm:py-2"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-brand-100 text-sm font-semibold text-brand-800">
                {initials}
              </div>
              <div className="hidden text-left sm:block">
                <div className="text-sm font-medium text-stone-900 leading-tight">
                  {profile?.full_name || user?.email?.split('@')[0] || 'User'}
                </div>
                <div className="text-xs text-stone-400 capitalize leading-tight">{profile?.role ?? 'staff'}</div>
              </div>
              <ChevronDown size={14} className="text-stone-400" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-[min(18rem,calc(100vw-1.5rem))] rounded-xl border border-stone-200 bg-white py-1 shadow-lg">
                  <div className="border-b border-stone-100 px-4 py-3">
                    <p className="text-sm font-medium text-stone-900 truncate">{profile?.full_name || 'User'}</p>
                    <p className="text-xs text-stone-400 truncate">{user?.email}</p>
                    <span
                      className={`mt-1.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        isAdmin ? 'bg-brand-100 text-brand-800' : 'bg-stone-100 text-stone-600'
                      }`}
                    >
                      {profile?.role ?? 'staff'}
                    </span>
                  </div>
                  <button
                    onClick={handleSignOut}
                    className="flex w-full items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                  >
                    <LogOut size={15} />
                    Sign Out
                  </button>
                </div>
              </>
            )}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-y-contain touch-pan-y">
          <div className="mx-auto max-w-7xl px-3 pb-[max(1.5rem,env(safe-area-inset-bottom,0px))] pt-5 sm:px-4 md:px-6 md:py-8 md:pb-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
