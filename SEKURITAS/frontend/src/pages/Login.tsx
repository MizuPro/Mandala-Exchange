import { useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { fetchApi } from '../api/client';
import { LogIn, UserPlus, Eye, EyeOff, Mail, Lock, ArrowLeft } from 'lucide-react';
import './Login.css';

export default function Login() {
  const [isLogin, setIsLogin] = useState(true);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  const login = useStore(state => state.login);
  const navigate = useNavigate();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetchApi(isLogin ? '/auth/login' : '/auth/register', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });

      if (!res.token || !res.user) {
        throw new Error(isLogin ? 'Invalid login response' : 'Invalid registration response');
      }

      login(res.token, res.user);
      if (!res.user.is_verified) {
        if (res.verification_token) localStorage.setItem('verification_token', res.verification_token);
        navigate('/verify-email');
      } else {
        navigate('/dashboard');
      }
    } catch (err: any) {
      setError(err.message || 'Authentication failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page-root">
      {/* Top Navbar */}
      <nav className="login-nav">
        <div className="login-nav-container">
          <div className="login-nav-brand">Mandala Sekuritas</div>
          <Link to="/" className="login-nav-back">
            <ArrowLeft size={16} />
            Kembali ke Home
          </Link>
        </div>
      </nav>

      {/* Main split-screen container */}
      <main className="login-split-main">
        {/* Left Side: Visual Narrative */}
        <div className="login-visual-panel">
          <div className="login-image-overlay" />
          <img 
            alt="High-fidelity professional stock trading terminal preview" 
            className="login-visual-img" 
            src="/login_image_asset.png" 
          />
          <div className="login-visual-info">
            <h2>Masa Depan Investasi di Tangan Anda</h2>
            <p>Akses instrumen pasar modal tercanggih dengan keamanan berlapis dan performa real-time.</p>
          </div>
        </div>

        {/* Right Side: Login Form */}
        <div className="login-form-panel">
          <div className="login-form-wrapper animate-fade-in">
            {/* Brand Header */}
            <div className="login-brand-header">
              <div className="login-logo-container">
                <img 
                  alt="Mandala Sekuritas Logo" 
                  className="login-logo-img" 
                  src="/logo_teksbawah.png" 
                  onError={(e) => {
                    e.currentTarget.style.display = 'none';
                  }}
                />
              </div>
              <h1>{isLogin ? 'Selamat Datang Kembali' : 'Daftar Akun Baru'}</h1>
              <p>
                {isLogin 
                  ? 'Masuk ke akun Mandala Sekuritas Anda untuk mulai trading.' 
                  : 'Buat akun baru Mandala Sekuritas untuk memulai simulasi paper trading.'}
              </p>
            </div>

            {/* Error Alert */}
            {error && (
              <div className="login-error-alert">
                {error}
              </div>
            )}

            {/* Form Section */}
            <form onSubmit={handleSubmit} className="login-form">
              {/* User ID / Email */}
              <div className="login-form-group">
                <label className="login-label" htmlFor="email">Email Address</label>
                <div className="login-input-wrapper">
                  <input 
                    className="login-input" 
                    id="email" 
                    type="email" 
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    placeholder="investor@example.com"
                    required
                  />
                  <span className="login-input-icon">
                    <Mail size={18} />
                  </span>
                </div>
              </div>

              {/* Password */}
              <div className="login-form-group">
                <div className="login-label-row">
                  <label className="login-label" htmlFor="password">Password</label>
                  {isLogin && (
                    <a 
                      href="#" 
                      onClick={(e) => {
                        e.preventDefault();
                        alert('Silakan hubungi administrator untuk mereset kata sandi akun simulasi Anda.');
                      }} 
                      className="login-link-forgot"
                    >
                      Lupa Password?
                    </a>
                  )}
                </div>
                <div className="login-input-wrapper">
                  <input 
                    className="login-input" 
                    id="password" 
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    placeholder="Password minimal 6 karakter"
                    required
                    minLength={6}
                  />
                  <button 
                    type="button" 
                    className="login-input-toggle" 
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? "Hide password" : "Show password"}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>

              {/* Remember Me Checkbox (Only for Login) */}
              {isLogin && (
                <div className="login-checkbox-group">
                  <input 
                    type="checkbox" 
                    id="remember" 
                    className="login-checkbox" 
                  />
                  <label htmlFor="remember" className="login-checkbox-label">Ingat Saya</label>
                </div>
              )}

              {/* Submit Button */}
              <button 
                type="submit" 
                className="login-btn-submit" 
                disabled={loading}
              >
                {loading ? (
                  'Memproses...'
                ) : isLogin ? (
                  <>
                    <LogIn size={18} />
                    Masuk Sekarang
                  </>
                ) : (
                  <>
                    <UserPlus size={18} />
                    Daftar Sekarang
                  </>
                )}
              </button>
            </form>

            {/* Switch Mode Footer Note */}
            <div className="login-footer-note">
              <p>
                {isLogin ? (
                  <>
                    Belum punya akun?{' '}
                    <button 
                      type="button" 
                      className="login-btn-toggle-mode"
                      onClick={() => {
                        setIsLogin(false);
                        setError('');
                      }}
                    >
                      Daftar Sekarang
                    </button>
                  </>
                ) : (
                  <>
                    Sudah memiliki akun?{' '}
                    <button 
                      type="button" 
                      className="login-btn-toggle-mode"
                      onClick={() => {
                        setIsLogin(true);
                        setError('');
                      }}
                    >
                      Masuk Sekarang
                    </button>
                  </>
                )}
              </p>
            </div>
          </div>
        </div>
      </main>

      {/* Footer */}
      <footer className="login-footer">
        <div className="login-footer-brand">Mandala Sekuritas</div>
        <div className="login-footer-links">
          <a href="#" className="login-footer-link">Privacy Policy</a>
          <a href="#" className="login-footer-link">Terms of Service</a>
          <a href="#" className="login-footer-link">Security</a>
        </div>
        <div className="login-footer-copy">
          © {new Date().getFullYear()} Mandala Sekuritas. All rights reserved.
        </div>
      </footer>
    </div>
  );
}
