import { lazy, Suspense } from 'react';
import { HashRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';

/** GitHub Pages only serves real files; deep pathname URLs can 404. Hash routing loads index.html once. */
import { AuthProvider, useAuth } from './utils/auth';
import { Layout } from './components/Layout';

const Login = lazy(() => import('./pages/Login').then((m) => ({ default: m.Login })));
const Register = lazy(() => import('./pages/Register').then((m) => ({ default: m.Register })));
const PendingApproval = lazy(() => import('./pages/PendingApproval').then((m) => ({ default: m.PendingApproval })));
const RequiredPasswordReset = lazy(() =>
  import('./pages/RequiredPasswordReset').then((m) => ({ default: m.RequiredPasswordReset }))
);
const ResetPassword = lazy(() => import('./pages/ResetPassword').then((m) => ({ default: m.ResetPassword })));
const Overview = lazy(() => import('./pages/Overview').then((m) => ({ default: m.Overview })));
const Procurement = lazy(() => import('./pages/Procurement').then((m) => ({ default: m.Procurement })));
const Production = lazy(() => import('./pages/Production').then((m) => ({ default: m.Production })));
const Inventory = lazy(() => import('./pages/Inventory').then((m) => ({ default: m.Inventory })));
const Distribution = lazy(() => import('./pages/Distribution').then((m) => ({ default: m.Distribution })));
const Sales = lazy(() => import('./pages/Sales').then((m) => ({ default: m.Sales })));
const Waste = lazy(() => import('./pages/Waste').then((m) => ({ default: m.Waste })));
const Genealogy = lazy(() => import('./pages/Genealogy').then((m) => ({ default: m.Genealogy })));
const Ledger = lazy(() => import('./pages/Ledger').then((m) => ({ default: m.Ledger })));
const Reconciliation = lazy(() => import('./pages/Reconciliation').then((m) => ({ default: m.Reconciliation })));
const AuditDashboard = lazy(() => import('./pages/AuditDashboard').then((m) => ({ default: m.AuditDashboard })));
const Settings = lazy(() => import('./pages/Settings').then((m) => ({ default: m.Settings })));
const StockTake = lazy(() => import('./pages/StockTake').then((m) => ({ default: m.StockTake })));
const Users = lazy(() => import('./pages/Users').then((m) => ({ default: m.Users })));

function LoadingScreen({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-50 auth-safe-padding">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-brand-700 text-xl font-bold text-white">
          Q
        </div>
        <p className="text-sm text-stone-500">Loading…</p>
        {subtitle && <p className="mt-3 text-xs text-stone-400 leading-relaxed">{subtitle}</p>}
      </div>
    </div>
  );
}

function LoginRoute() {
  const { session, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (session) return <Navigate to="/" replace />;
  return <Login />;
}

function RegisterRoute() {
  const { session, loading } = useAuth();
  if (loading) return <LoadingScreen />;
  if (session) return <Navigate to="/" replace />;
  return <Register />;
}

/** Password recovery from email may establish a session before the user chooses a new password. */
function ResetPasswordRoute() {
  const { loading } = useAuth();
  if (loading) return <LoadingScreen />;
  return <ResetPassword />;
}

function UsersGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Users /> : <Navigate to="/" replace />;
}

function LedgerGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Ledger /> : <Navigate to="/" replace />;
}

function SettingsGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Settings /> : <Navigate to="/" replace />;
}

function ReconciliationGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Reconciliation /> : <Navigate to="/" replace />;
}

function AuditGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <AuditDashboard /> : <Navigate to="/" replace />;
}

function GenealogyGate() {
  const { isAdmin, profile } = useAuth();
  const canView = isAdmin || profile?.role === 'staff';
  return canView ? <Genealogy /> : <Navigate to="/" replace />;
}

function LayoutShell() {
  return (
    <Layout>
      <Outlet />
    </Layout>
  );
}

function ProtectedShell() {
  const { session, loading, profileLoading, profile } = useAuth();
  const location = useLocation();

  if (loading) return <LoadingScreen />;
  if (!session) return <Navigate to="/login" replace />;
  if (profileLoading) {
    return (
      <LoadingScreen subtitle="Loading your profile from the server. If this hangs, check your connection or Supabase status." />
    );
  }

  const role = profile?.role?.toLowerCase?.()?.trim();
  if (role === 'pending') return <PendingApproval />;

  const needsPasswordReset = Boolean(profile?.password_reset_required);
  if (needsPasswordReset && location.pathname !== '/required-password-reset') {
    return <Navigate to="/required-password-reset" replace />;
  }

  if (role === 'supervisor') {
    const path = location.pathname;
    const allowed =
      path === '/stock-take' || path === '/sales' || path === '/waste' || path === '/required-password-reset';
    if (!allowed) {
      return <Navigate to="/stock-take" replace />;
    }
  }

  return <Outlet />;
}

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route path="/login" element={<LoginRoute />} />
            <Route path="/register" element={<RegisterRoute />} />
            <Route path="/reset-password" element={<ResetPasswordRoute />} />
            <Route element={<ProtectedShell />}>
              <Route path="/required-password-reset" element={<RequiredPasswordReset />} />
              <Route element={<LayoutShell />}>
                <Route index element={<Overview />} />
                <Route path="/stock-take" element={<StockTake />} />
                <Route path="/procurement/*" element={<Procurement />} />
                <Route path="/production/*" element={<Production />} />
                <Route path="/inventory/*" element={<Inventory />} />
                <Route path="/distribution/*" element={<Distribution />} />
                <Route path="/sales" element={<Sales />} />
                <Route path="/waste" element={<Waste />} />
                <Route path="/users" element={<UsersGate />} />
                <Route path="/ledger" element={<LedgerGate />} />
                <Route path="/reconciliation" element={<ReconciliationGate />} />
                <Route path="/audit" element={<AuditGate />} />
                <Route path="/genealogy" element={<GenealogyGate />} />
                <Route path="/settings" element={<SettingsGate />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
