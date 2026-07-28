import { Navigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function ProtectedRoute({ children, adminOnly = false }) {
  const { session, isAdmin, loading } = useAuth();

  if (loading) {
    return <div className="min-h-screen grid place-items-center text-blueline font-mono">Loading…</div>;
  }
  if (!session) return <Navigate to="/login" replace />;
  if (adminOnly && !isAdmin) return <Navigate to="/dashboard" replace />;
  return children;
}
