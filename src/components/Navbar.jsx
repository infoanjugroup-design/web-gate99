import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';

export default function Navbar() {
  const { session, profile, isAdmin, signOut } = useAuth();
  const navigate = useNavigate();

  return (
    <header className="border-b border-blueline/30 bg-ink/95 sticky top-0 z-40 backdrop-blur">
      <div className="max-w-6xl mx-auto px-5 h-16 flex items-center justify-between">
        <Link to="/" className="font-display font-bold text-lg tracking-tight text-paper">
          GATE<span className="text-signal">99</span>
        </Link>
        <nav className="flex items-center gap-5 label-mono">
          {session && !isAdmin && <Link to="/dashboard" className="hover:text-signal">Dashboard</Link>}
          {session && !isAdmin && <Link to="/doubts" className="hover:text-signal">Doubts</Link>}
          {isAdmin && <Link to="/admin" className="hover:text-signal">Admin</Link>}
          {session ? (
            <button
              onClick={async () => { await signOut(); navigate('/login'); }}
              className="btn-ghost !px-3 !py-1.5 text-xs"
            >
              Sign out{profile?.name ? ` · ${profile.name}` : ''}
            </button>
          ) : (
            <Link to="/login" className="btn-signal !px-3 !py-1.5 text-xs">Sign in</Link>
          )}
        </nav>
      </div>
    </header>
  );
}
