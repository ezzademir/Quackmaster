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
  ChevronRight,
  Plus,
  ScrollText,
  BookOpenText,
  LogOut,
  ChevronDown,
  Users,
} from 'lucide-react';
import { useAuth } from '../utils/auth';

const mainNav = [
  { path: '/', label: 'Dashboard', icon: LayoutDashboard, exact: true },
];

const opsNav = [
  { path: '/procurement', label: 'Procurement', icon: ShoppingCart, exact: false },
  { path: '/production', label: 'Production', icon: FlaskConical, exact: false },
  { path: '/inventory', label: 'Inventory', icon: Boxes, exact: false },
  { path: '/distribution', label: 'Distribution', icon: Truck, exact: false },
];

const adminNav = [
  { path: '/users', label: 'Users', icon: Users, exact: false },
  { path: '/activity-log', label: 'Activity Log', icon: ScrollText, exact: false },
  { path: '/ledger', label: 'Data Ledger', icon: BookOpenText, exact: false },
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
      className={`flex items-center gap-3 rounded-lg px-2.5 py-2.5 text-sm font-medium transition-all ${
        active
          ? 'bg-blue-600 text-white shadow-sm'
          : 'text-slate-400 hover:bg-slate-800 hover:text-white'
      } ${collapsed ? 'justify-center' : ''}`}
    >
      <Icon size={18} className="flex-shrink-0" />
      {!collapsed && <span>{label}</span>}
      {!collapsed && active && <ChevronRight size={14} className="ml-auto opacity-70" />}
    </Link>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  const [collapsed, setCollapsed] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const { profile, user, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate('/login');
  }

  const initials = profile?.full_name
    ? profile.full_name.split(' ').map((n) => n[0]).join('').toUpperCase().slice(0, 2)
    : (user?.email?.[0] ?? 'U').toUpperCase();

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Mobile sidebar overlay */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-30 bg-black/50 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed md:relative z-40 flex flex-col bg-slate-900 transition-all duration-300 ease-in-out flex-shrink-0 h-screen ${
          sidebarOpen ? 'w-60' : '-translate-x-full'
        } md:translate-x-0 md:w-60 ${collapsed ? 'md:w-[72px]' : ''}`}
      >
        {/* Brand */}
        <div
          className={`flex h-16 items-center justify-between border-b border-slate-800 px-4 md:justify-start ${
            collapsed ? 'md:justify-center' : 'gap-3'
          }`}
        >
          <img src="/Quackmaster_Logo.png" alt="Quackmaster" className="h-9 w-9 flex-shrink-0" />
          {!collapsed && (
            <div>
              <div className="text-sm font-semibold text-white leading-tight">Quackmaster</div>
              <div className="text-xs text-slate-400 leading-tight">ERP System</div>
            </div>
          )}
          <button
            onClick={() => setSidebarOpen(false)}
            className="md:hidden text-slate-400 hover:text-white"
          >
            <span className="text-2xl">&times;</span>
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto px-3 py-4 space-y-5">
          <div>
            {!collapsed && (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Overview
              </p>
            )}
            <ul className="space-y-0.5">
              {mainNav.map((item) => (
                <li key={item.path}>
                  <NavItem {...item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>

          <div>
            {!collapsed && (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                Operations
              </p>
            )}
            <ul className="space-y-0.5">
              {opsNav.map((item) => (
                <li key={item.path}>
                  <NavItem {...item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>

          <div>
            {!collapsed && (
              <p className="mb-1.5 px-2 text-[10px] font-semibold uppercase tracking-widest text-slate-500">
                {isAdmin ? 'Admin' : 'System'}
              </p>
            )}
            <ul className="space-y-0.5">
              {adminNav
                .filter((item) => {
                  if (item.path === '/activity-log' || item.path === '/ledger') return isAdmin;
                  return true;
                })
                .map((item) => (
                  <li key={item.path}>
                    <NavItem {...item} collapsed={collapsed} />
                  </li>
                ))}
            </ul>
          </div>

          {!collapsed && (
            <div className="border-t border-slate-800 pt-4">
              <div className="rounded-lg border border-dashed border-slate-700 p-3">
                <div className="flex items-center gap-2 text-slate-500">
                  <Plus size={14} />
                  <span className="text-xs font-medium">More modules coming</span>
                </div>
                <p className="mt-1 text-[10px] text-slate-600 leading-relaxed">
                  Finance · HR · CRM · Quality
                </p>
              </div>
            </div>
          )}
        </nav>

        {/* Collapse toggle */}
        <div className="border-t border-slate-800 p-3">
          <button
            onClick={() => setCollapsed(!collapsed)}
            className={`flex w-full items-center gap-3 rounded-lg px-2.5 py-2.5 text-slate-400 hover:bg-slate-800 hover:text-white transition-all ${
              collapsed ? 'justify-center' : ''
            }`}
          >
            <Menu size={18} />
            {!collapsed && <span className="text-sm font-medium">Collapse</span>}
          </button>
        </div>
      </aside>

      {/* Main */}
      <div className="flex flex-1 flex-col overflow-hidden">
        {/* Top bar */}
        <header className="flex h-16 flex-shrink-0 items-center justify-between md:justify-end gap-4 border-b border-gray-200 bg-white px-4 md:px-6">
          <button
            onClick={() => setSidebarOpen(true)}
            className="md:hidden flex items-center gap-2 text-gray-600 hover:text-gray-900"
          >
            <Menu size={20} />
          </button>
          {/* User menu */}
          <div className="relative">
            <button
              onClick={() => setUserMenuOpen(!userMenuOpen)}
              className="flex items-center gap-2.5 rounded-xl px-3 py-2 hover:bg-gray-100 transition-colors"
            >
              <div className="flex h-8 w-8 items-center justify-center rounded-full bg-blue-100 text-sm font-semibold text-blue-700">
                {initials}
              </div>
              <div className="hidden text-left sm:block">
                <div className="text-sm font-medium text-gray-900 leading-tight">
                  {profile?.full_name || user?.email?.split('@')[0] || 'User'}
                </div>
                <div className="text-xs text-gray-400 capitalize leading-tight">{profile?.role ?? 'staff'}</div>
              </div>
              <ChevronDown size={14} className="text-gray-400" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-10" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full z-20 mt-1 w-52 rounded-xl border border-gray-200 bg-white py-1 shadow-lg">
                  <div className="border-b border-gray-100 px-4 py-3">
                    <p className="text-sm font-medium text-gray-900 truncate">
                      {profile?.full_name || 'User'}
                    </p>
                    <p className="text-xs text-gray-400 truncate">{user?.email}</p>
                    <span
                      className={`mt-1.5 inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase ${
                        isAdmin ? 'bg-blue-100 text-blue-700' : 'bg-gray-100 text-gray-600'
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

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-7xl px-4 md:px-6 py-6 md:py-8">{children}</div>
        </main>
      </div>
    </div>
  );
}
