import { useState } from 'react';
import { Activity, ShieldAlert, FileText, CheckSquare, Power, ArrowLeft } from 'lucide-react';
import { useNavigate } from 'react-router-dom';

export default function AdminDashboard() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<'session' | 'audit' | 'broker' | 'surveillance'>('session');

  return (
    <>
      <nav className="navbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <button onClick={() => navigate('/')} style={{ background: 'transparent', color: 'var(--primary)', border: 'none', cursor: 'pointer' }}>
            <ArrowLeft size={24} />
          </button>
          <span className="navbar-brand">Admin Dashboard</span>
        </div>
      </nav>

      <main className="container animate-fade-in" style={{ display: 'flex', gap: '1.5rem', marginTop: '2rem' }}>
        <aside style={{ width: '250px', display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
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
