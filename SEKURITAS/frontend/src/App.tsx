import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store/useStore';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import DashboardHome from './pages/DashboardHome';
import Portfolio from './components/Portfolio';
import MarketPanel from './components/MarketPanel';
import ActivityOrder from './pages/ActivityOrder';
import SettingsPage from './pages/SettingsPage';
import AdminDashboard from './pages/AdminDashboard';
import VerifyEmail from './pages/VerifyEmail';
import LandingPage from './pages/LandingPage';
import MarketDetail from './pages/MarketDetail';
import { ToastProvider } from './components/ui/Toast';

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const token = useStore(state => state.token);
  const user = useStore(state => state.user);
  const authReady = useStore(state => state.authReady);
  if (!authReady) return null;
  if (!token) return <Navigate to="/login" />;
  if (user && !user.is_verified) return <Navigate to="/verify-email" />;
  return <>{children}</>;
}

function App() {
  const hydrateSession = useStore(state => state.hydrateSession);

  useEffect(() => {
    hydrateSession();
  }, [hydrateSession]);

  return (
    <ToastProvider>
      <Router>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<Login />} />
          <Route path="/verify-email" element={<VerifyEmail />} />
          
          {/* Rute Bersarang dengan Layout Utama */}
          <Route element={
            <ProtectedRoute>
              <Dashboard />
            </ProtectedRoute>
          }>
            <Route path="/dashboard" element={<DashboardHome />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/market" element={<MarketPanel />} />
            <Route path="/market/:symbol" element={<MarketDetail />} />
            <Route path="/activity" element={<ActivityOrder />} />
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="/admin" element={
            <ProtectedRoute>
              <AdminDashboard />
            </ProtectedRoute>
          } />
        </Routes>
      </Router>
    </ToastProvider>
  );
}

export default App;
