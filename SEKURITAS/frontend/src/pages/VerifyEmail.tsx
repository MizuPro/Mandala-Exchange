import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ShieldCheck } from 'lucide-react';
import { useStore } from '../store/useStore';

export default function VerifyEmail() {
  const [token, setToken] = useState(localStorage.getItem('verification_token') || '');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const verifyEmail = useStore(state => state.verifyEmail);
  const navigate = useNavigate();

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setLoading(true);
    setMessage('');
    try {
      await verifyEmail(token);
      localStorage.removeItem('verification_token');
      navigate('/dashboard');
    } catch (error: any) {
      setMessage(error.message || 'Verification failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="flex-center" style={{ minHeight: '100vh' }}>
      <div className="glass-panel animate-fade-in" style={{ width: '100%', maxWidth: '420px', padding: '2rem' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '1.5rem' }}>
          <ShieldCheck className="text-primary" />
          <h2 style={{ margin: 0 }}>Verify Email</h2>
        </div>
        {message && <p className="text-danger">{message}</p>}
        <form onSubmit={handleSubmit}>
          <div className="form-group">
            <label>Verification Token</label>
            <input value={token} onChange={(event) => setToken(event.target.value)} required />
          </div>
          <button className="btn-primary" style={{ width: '100%' }} disabled={loading}>
            {loading ? 'Verifying...' : 'Verify'}
          </button>
        </form>
      </div>
    </div>
  );
}
