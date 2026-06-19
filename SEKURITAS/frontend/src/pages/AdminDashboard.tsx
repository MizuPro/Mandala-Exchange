import { useState } from 'react';
import { Activity, ShieldAlert, FileText, CheckSquare, Power, ArrowLeft, Users, Search, Edit2, Check, X, AlertTriangle, RefreshCw } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { resolveApiBase } from '../config/endpoints';

interface UserRow {
  id: string;
  email: string;
  status: string;
  created_at: string;
  broker_account_id: string | null;
  account_type: string | null;
  cash_available: string | null;
  cash_reserved: string | null;
  cash_pending: string | null;
}

const API_BASE = resolveApiBase();

async function adminFetch(path: string, adminToken: string, options: RequestInit = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': adminToken,
      ...(options.headers as Record<string, string>),
    },
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed: ${res.status}`);
  return data;
}

function formatRp(value: string | null | undefined) {
  if (value == null) return '-';
  const n = parseFloat(value);
  if (isNaN(n)) return '-';
  return `Rp ${n.toLocaleString('id-ID', { maximumFractionDigits: 0 })}`;
}

// ==========================================
// SUB-KOMPONEN: Tab Manajemen User
// ==========================================
function UserManagementTab() {
  const [adminToken, setAdminToken] = useState('');
  const [tokenInput, setTokenInput] = useState('');
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Edit state
  const [editingUserId, setEditingUserId] = useState<string | null>(null);
  const [editAmount, setEditAmount] = useState('');
  const [editLoading, setEditLoading] = useState(false);

  const isAuthenticated = !!adminToken;

  const handleLogin = () => {
    if (!tokenInput.trim()) return;
    setAdminToken(tokenInput.trim());
    setError(null);
    fetchUsers(tokenInput.trim());
  };

  const fetchUsers = async (token = adminToken) => {
    if (!token) return;
    setLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const data = await adminFetch('/admin/users', token);
      setUsers(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Gagal memuat data user');
      if (err.message?.includes('401') || err.message?.includes('Missing') || err.message?.includes('invalid')) {
        setAdminToken('');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleUpdateBalance = async (userId: string) => {
    const amount = parseFloat(editAmount.replace(/[^0-9.]/g, ''));
    if (isNaN(amount) || amount < 0) {
      setError('Masukkan nilai saldo yang valid');
      return;
    }
    setEditLoading(true);
    setError(null);
    setSuccessMsg(null);
    try {
      await adminFetch('/admin/users/balance', adminToken, {
        method: 'POST',
        body: JSON.stringify({ userId, available: amount }),
      });
      setSuccessMsg('Saldo berhasil diperbarui!');
      setEditingUserId(null);
      setEditAmount('');
      await fetchUsers();
    } catch (err: any) {
      setError(err.message || 'Gagal memperbarui saldo');
    } finally {
      setEditLoading(false);
    }
  };

  const startEdit = (user: UserRow) => {
    setEditingUserId(user.id);
    setEditAmount(user.cash_available ? parseFloat(user.cash_available).toFixed(0) : '0');
    setError(null);
    setSuccessMsg(null);
  };

  const filteredUsers = users.filter(u =>
    u.email.toLowerCase().includes(searchTerm.toLowerCase()) ||
    u.id.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // ---- UI: Token Login ----
  if (!isAuthenticated) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '400px', gap: '1.5rem' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ width: '4rem', height: '4rem', borderRadius: '50%', background: 'rgba(230, 34, 37, 0.1)', border: '1px solid rgba(230, 34, 37, 0.3)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 1rem' }}>
            <Users size={28} color="#E62225" />
          </div>
          <h3 style={{ margin: 0, color: '#fff', fontSize: '1.1rem' }}>Autentikasi Admin Diperlukan</h3>
          <p style={{ color: '#8B949E', marginTop: '0.5rem', fontSize: '0.875rem' }}>Masukkan Admin Token untuk mengakses manajemen user</p>
        </div>
        <div style={{ display: 'flex', gap: '0.5rem', width: '100%', maxWidth: '420px' }}>
          <input
            type="password"
            placeholder="Masukkan Admin Token..."
            value={tokenInput}
            onChange={e => setTokenInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleLogin()}
            style={{ flex: 1, padding: '0.65rem 1rem', background: '#0D1117', border: '1px solid #21262D', borderRadius: '8px', color: '#fff', fontSize: '0.875rem' }}
          />
          <button
            onClick={handleLogin}
            disabled={!tokenInput.trim()}
            style={{ padding: '0.65rem 1.25rem', background: '#E62225', color: '#fff', border: 'none', borderRadius: '8px', cursor: 'pointer', fontWeight: 600, fontSize: '0.875rem', whiteSpace: 'nowrap' }}
          >
            Masuk
          </button>
        </div>
        {error && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#EF4444', fontSize: '0.8rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '0.5rem 1rem' }}>
            <AlertTriangle size={14} />
            {error}
          </div>
        )}
      </div>
    );
  }

  // ---- UI: User List ----
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.25rem' }}>
      {/* Header Bar */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem', flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <h2 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '1.1rem' }}>
            <Users size={20} color="#E62225" /> Manajemen User ({users.length})
          </h2>
          <button
            onClick={() => fetchUsers()}
            disabled={loading}
            title="Refresh data"
            style={{ background: 'transparent', border: '1px solid #21262D', borderRadius: '6px', color: '#8B949E', cursor: 'pointer', padding: '0.35rem', display: 'flex', alignItems: 'center' }}
          >
            <RefreshCw size={14} style={{ animation: loading ? 'spin 1s linear infinite' : 'none' }} />
          </button>
        </div>
        <div style={{ position: 'relative', flex: '0 0 auto', minWidth: '220px' }}>
          <Search size={14} style={{ position: 'absolute', left: '0.65rem', top: '50%', transform: 'translateY(-50%)', color: '#8B949E' }} />
          <input
            type="text"
            placeholder="Cari email / user ID..."
            value={searchTerm}
            onChange={e => setSearchTerm(e.target.value)}
            style={{ width: '100%', padding: '0.5rem 0.75rem 0.5rem 2rem', background: '#0D1117', border: '1px solid #21262D', borderRadius: '8px', color: '#fff', fontSize: '0.8rem', boxSizing: 'border-box' }}
          />
        </div>
      </div>

      {/* Status Messages */}
      {error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#EF4444', fontSize: '0.8rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.3)', borderRadius: '8px', padding: '0.6rem 1rem' }}>
          <AlertTriangle size={14} /> {error}
        </div>
      )}
      {successMsg && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', color: '#10B981', fontSize: '0.8rem', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.3)', borderRadius: '8px', padding: '0.6rem 1rem' }}>
          <Check size={14} /> {successMsg}
        </div>
      )}

      {/* Table */}
      <div style={{ width: '100%', overflowX: 'auto', borderRadius: '8px', border: '1px solid #21262D' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.8rem', minWidth: '750px' }}>
          <thead>
            <tr style={{ background: '#161B22', borderBottom: '1px solid #21262D' }}>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Email</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Status</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'left', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Tipe</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Saldo Tersedia</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Reserved</th>
              <th style={{ padding: '0.75rem 1rem', textAlign: 'center', color: '#8B949E', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.05em', fontSize: '0.7rem' }}>Aksi</th>
            </tr>
          </thead>
          <tbody>
            {loading && (
              <tr>
                <td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: '#8B949E' }}>
                  Memuat data...
                </td>
              </tr>
            )}
            {!loading && filteredUsers.length === 0 && (
              <tr>
                <td colSpan={6} style={{ padding: '2rem', textAlign: 'center', color: '#8B949E' }}>
                  {searchTerm ? 'Tidak ada user yang sesuai pencarian.' : 'Tidak ada user ditemukan.'}
                </td>
              </tr>
            )}
            {filteredUsers.map((user, idx) => (
              <tr key={user.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', background: idx % 2 === 0 ? 'transparent' : 'rgba(255,255,255,0.01)' }}>
                <td style={{ padding: '0.75rem 1rem', color: '#e6edf3' }}>
                  <div style={{ fontWeight: 500 }}>{user.email}</div>
                  <div style={{ color: '#8B949E', fontSize: '0.7rem', fontFamily: 'monospace', marginTop: '0.15rem' }}>{user.id.slice(0, 12)}...</div>
                </td>
                <td style={{ padding: '0.75rem 1rem' }}>
                  <span style={{
                    display: 'inline-block', padding: '0.2rem 0.6rem', borderRadius: '999px', fontSize: '0.7rem', fontWeight: 700,
                    color: user.status === 'verified' ? '#10B981' : user.status === 'suspended' ? '#EF4444' : '#F59E0B',
                    background: user.status === 'verified' ? 'rgba(16,185,129,0.1)' : user.status === 'suspended' ? 'rgba(239,68,68,0.1)' : 'rgba(245,158,11,0.1)',
                    border: `1px solid ${user.status === 'verified' ? 'rgba(16,185,129,0.3)' : user.status === 'suspended' ? 'rgba(239,68,68,0.3)' : 'rgba(245,158,11,0.3)'}`,
                  }}>
                    {user.status}
                  </span>
                </td>
                <td style={{ padding: '0.75rem 1rem', color: '#8B949E' }}>
                  {user.account_type || '-'}
                </td>
                <td style={{ padding: '0.75rem 1rem', textAlign: 'right' }}>
                  {editingUserId === user.id ? (
                    <input
                      type="number"
                      value={editAmount}
                      onChange={e => setEditAmount(e.target.value)}
                      min={0}
                      style={{ width: '130px', padding: '0.35rem 0.5rem', background: '#0D1117', border: '1px solid rgba(230,34,37,0.5)', borderRadius: '6px', color: '#fff', fontSize: '0.8rem', textAlign: 'right' }}
                    />
                  ) : (
                    <span style={{ fontFamily: 'monospace', fontWeight: 600, color: '#10B981' }}>{formatRp(user.cash_available)}</span>
                  )}
                </td>
                <td style={{ padding: '0.75rem 1rem', textAlign: 'right', color: '#8B949E', fontFamily: 'monospace' }}>
                  {formatRp(user.cash_reserved)}
                </td>
                <td style={{ padding: '0.75rem 1rem', textAlign: 'center' }}>
                  {user.broker_account_id ? (
                    editingUserId === user.id ? (
                      <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                        <button
                          onClick={() => handleUpdateBalance(user.id)}
                          disabled={editLoading}
                          title="Simpan perubahan"
                          style={{ padding: '0.35rem 0.5rem', background: 'rgba(16,185,129,0.1)', border: '1px solid rgba(16,185,129,0.4)', borderRadius: '6px', color: '#10B981', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        >
                          <Check size={14} />
                        </button>
                        <button
                          onClick={() => { setEditingUserId(null); setEditAmount(''); setError(null); }}
                          title="Batal"
                          style={{ padding: '0.35rem 0.5rem', background: 'rgba(239,68,68,0.1)', border: '1px solid rgba(239,68,68,0.4)', borderRadius: '6px', color: '#EF4444', cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                        >
                          <X size={14} />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => startEdit(user)}
                        title="Edit saldo"
                        style={{ padding: '0.35rem 0.65rem', background: 'rgba(255,255,255,0.05)', border: '1px solid #21262D', borderRadius: '6px', color: '#8B949E', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.75rem' }}
                      >
                        <Edit2 size={12} /> Edit
                      </button>
                    )
                  ) : (
                    <span style={{ color: '#8B949E', fontSize: '0.75rem' }}>No account</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ==========================================
// KOMPONEN UTAMA: AdminDashboard
// ==========================================
export default function AdminDashboard() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'session' | 'audit' | 'broker' | 'surveillance' | 'users'>('users');

  return (
    <>
      <nav className="navbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button onClick={() => navigate('/dashboard')} style={{ background: 'transparent', color: 'var(--primary)', border: 'none', cursor: 'pointer' }}>
            <ArrowLeft size={24} />
          </button>
          <span className="navbar-brand">Admin Dashboard</span>
        </div>
      </nav>

      <main className="container animate-fade-in" style={{ display: 'flex', gap: '1.5rem', marginTop: '2rem' }}>
        <aside style={{ width: '250px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
          <button
            className={`btn ${activeTab === 'users' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setActiveTab('users')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}
          >
            <Users size={18} /> Manajemen User
          </button>
          <button
            className={`btn ${activeTab === 'session' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setActiveTab('session')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}
          >
            <Power size={18} /> Kontrol Sesi
          </button>
          <button
            className={`btn ${activeTab === 'surveillance' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setActiveTab('surveillance')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}
          >
            <Activity size={18} /> Surveillance
          </button>
          <button
            className={`btn ${activeTab === 'broker' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setActiveTab('broker')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}
          >
            <CheckSquare size={18} /> Approval Broker
          </button>
          <button
            className={`btn ${activeTab === 'audit' ? 'btn-primary' : 'btn-outline'}`}
            onClick={() => setActiveTab('audit')}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', justifyContent: 'flex-start' }}
          >
            <FileText size={18} /> Audit Log
          </button>
        </aside>

        <section className="glass-panel" style={{ flex: 1, minHeight: '600px', padding: '2rem' }}>
          {activeTab === 'users' && <UserManagementTab />}

          {activeTab === 'session' && (
            <div>
              <h2 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Power size={24} color="var(--primary)" /> Kontrol Sesi Pasar
              </h2>
              <p className="text-muted" style={{ marginBottom: '2rem' }}>Modul ini mengatur status dan fase market secara manual atau otomatis.</p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
                <div className="glass-panel">
                  <h3>Halt Market</h3>
                  <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>Hentikan semua aktivitas trading seketika.</p>
                  <button className="btn" style={{ backgroundColor: 'var(--danger)', color: 'white', border: 'none' }}>Trigger Halt</button>
                </div>
                <div className="glass-panel">
                  <h3>Suspend Symbol</h3>
                  <p className="text-muted" style={{ fontSize: '0.9rem', marginBottom: '1rem' }}>Hentikan trading untuk emiten tertentu.</p>
                  <div style={{ display: 'flex', gap: '0.5rem' }}>
                    <input type="text" placeholder="Symbol (e.g., BBCA)" style={{ flex: 1, padding: '0.5rem' }} />
                    <button className="btn btn-primary">Suspend</button>
                  </div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'surveillance' && (
            <div>
              <h2 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <Activity size={24} color="var(--primary)" /> Grafik Surveillance
              </h2>
              <p className="text-muted" style={{ marginBottom: '2rem' }}>Pemantauan pergerakan anomali, ARA/ARB beruntun, dan potensi wash trade.</p>
              <div style={{ height: '300px', border: '1px dashed var(--border)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--muted)' }}>
                <ShieldAlert size={48} style={{ opacity: 0.5, marginRight: '1rem' }} /> Area Grafik Surveillance (Placeholder)
              </div>
            </div>
          )}

          {activeTab === 'broker' && (
            <div>
              <h2 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CheckSquare size={24} color="var(--primary)" /> Persetujuan Broker
              </h2>
              <p className="text-muted" style={{ marginBottom: '2rem' }}>Verifikasi pendaftaran anggota bursa dan partisipan baru.</p>
              <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--border)' }}>
                    <th style={{ padding: '0.5rem' }}>Kode</th>
                    <th style={{ padding: '0.5rem' }}>Nama</th>
                    <th style={{ padding: '0.5rem' }}>Status</th>
                    <th style={{ padding: '0.5rem' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td style={{ padding: '1rem 0.5rem' }} colSpan={4} className="text-muted">Tidak ada permohonan tertunda.</td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'audit' && (
            <div>
              <h2 style={{ marginBottom: '1rem', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <FileText size={24} color="var(--primary)" /> Log Audit
              </h2>
              <p className="text-muted" style={{ marginBottom: '2rem' }}>Riwayat aktivitas admin dan perubahan sistem yang krusial.</p>
              <div className="glass-panel" style={{ background: 'var(--background)' }}>
                <p className="text-muted" style={{ fontStyle: 'italic' }}>Menunggu koneksi ke layanan logging backend...</p>
              </div>
            </div>
          )}
        </section>
      </main>
    </>
  );
}
