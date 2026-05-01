import { HashRouter, Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom';

/** GitHub Pages only serves real files; deep pathname URLs can 404. Hash routing loads index.html once. */
import { AuthProvider, useAuth } from './utils/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { PendingApproval } from './pages/PendingApproval';
import { RequiredPasswordReset } from './pages/RequiredPasswordReset';
import { ResetPassword } from './pages/ResetPassword';
import { Overview } from './pages/Overview';
import { Procurement } from './pages/Procurement';
import { Production } from './pages/Production';
import { Inventory } from './pages/Inventory';
import { Distribution } from './pages/Distribution';
import { Sales } from './pages/Sales';
import { Waste } from './pages/Waste';
import { Genealogy } from './pages/Genealogy';
import { Ledger } from './pages/Ledger';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';

function LoadingScreen({ subtitle }: { subtitle?: string }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="text-center max-w-sm">
        <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-xl font-bold text-white">
          Q
        </div>
        <p className="text-sm text-gray-500">Loading…</p>
        {subtitle && <p className="mt-3 text-xs text-gray-400 leading-relaxed">{subtitle}</p>}
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

function GenealogyGate() {
  const { isAdmin } = useAuth();
  return isAdmin ? <Genealogy /> : <Navigate to="/" replace />;
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

  return <Outlet />;
}

function App() {
  return (
    <HashRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginRoute />} />
          <Route path="/register" element={<RegisterRoute />} />
          <Route path="/reset-password" element={<ResetPasswordRoute />} />
          <Route element={<ProtectedShell />}>
            <Route path="/required-password-reset" element={<RequiredPasswordReset />} />
            <Route element={<LayoutShell />}>
              <Route index element={<Overview />} />
              <Route path="/procurement/*" element={<Procurement />} />
              <Route path="/production/*" element={<Production />} />
              <Route path="/inventory/*" element={<Inventory />} />
              <Route path="/distribution/*" element={<Distribution />} />
              <Route path="/sales" element={<Sales />} />
              <Route path="/waste" element={<Waste />} />
              <Route path="/users" element={<UsersGate />} />
              <Route path="/ledger" element={<LedgerGate />} />
              <Route path="/genealogy" element={<GenealogyGate />} />
              <Route path="/settings" element={<SettingsGate />} />
              <Route path="*" element={<Navigate to="/" replace />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </HashRouter>
  );
}

export default App;
