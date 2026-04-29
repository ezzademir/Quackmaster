import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';

/** Matches `base` in vite.config — required for GitHub Pages (`/Quackmaster/`). */
const ROUTER_BASENAME = import.meta.env.BASE_URL.replace(/\/$/, '');
import { AuthProvider, useAuth } from './utils/auth';
import { Layout } from './components/Layout';
import { Login } from './pages/Login';
import { Register } from './pages/Register';
import { PendingApproval } from './pages/PendingApproval';
import { Overview } from './pages/Overview';
import { Procurement } from './pages/Procurement';
import { Production } from './pages/Production';
import { Inventory } from './pages/Inventory';
import { Distribution } from './pages/Distribution';
import { ActivityLog } from './pages/ActivityLog';
import { Ledger } from './pages/Ledger';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';

function ProtectedRoutes() {
  const { session, loading, profile, isAdmin } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-600 text-xl font-bold text-white">
            Q
          </div>
          <p className="text-sm text-gray-500">Loading…</p>
        </div>
      </div>
    );
  }

  if (!session) return <Navigate to="/login" replace />;

  if (profile?.role === 'pending') return <PendingApproval />;

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/procurement/*" element={<Procurement />} />
        <Route path="/production/*" element={<Production />} />
        <Route path="/inventory/*" element={<Inventory />} />
        <Route path="/distribution/*" element={<Distribution />} />
        <Route path="/users" element={isAdmin ? <Users /> : <Navigate to="/" replace />} />
        <Route path="/activity-log" element={isAdmin ? <ActivityLog /> : <Navigate to="/" replace />} />
        <Route path="/ledger" element={isAdmin ? <Ledger /> : <Navigate to="/" replace />} />
        <Route path="/settings" element={isAdmin ? <Settings /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

function AuthRoutes() {
  const { session, loading } = useAuth();
  if (loading) return null;
  if (session) return <Navigate to="/" replace />;
  return null;
}

function App() {
  return (
    <BrowserRouter basename={ROUTER_BASENAME}>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<><AuthRoutes /><Login /></>} />
          <Route path="/register" element={<><AuthRoutes /><Register /></>} />
          <Route path="/*" element={<ProtectedRoutes />} />
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
