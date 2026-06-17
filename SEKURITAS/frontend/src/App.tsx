import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect } from 'react';
import { useStore } from './store/useStore';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import VerifyEmail from './pages/VerifyEmail';

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
    <Router>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/verify-email" element={<VerifyEmail />} />
        <Route path="/" element={
          <ProtectedRoute>
            <Dashboard />
          </ProtectedRoute>
        } />
      </Routes>
    </Router>
  );
}

export default App;
