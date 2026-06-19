import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { 
  User, 
  Shield, 
  Percent, 
  Sliders, 
  CheckCircle2, 
  AlertCircle, 
  Eye, 
  EyeOff, 
  HelpCircle,
  TrendingUp,
  RefreshCw,
  SlidersHorizontal
} from 'lucide-react';

export default function SettingsPage() {
  // --- Store States ---
  const user = useStore(state => state.user);
  const accountProfile = useStore(state => state.accountProfile);
  const feeSchedule = useStore(state => state.feeSchedule);
  const fetchAccountProfile = useStore(state => state.fetchAccountProfile);
  const depositFunds = useStore(state => state.depositFunds);

  // --- Local States ---
  const [activeTab, setActiveTab] = useState<'profile' | 'fees' | 'security' | 'preferences'>('profile');
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // RDN Sandbox State
  const [rdnDepositAmount, setRdnDepositAmount] = useState<string>('0');

  // Security - Password
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);

  // Security - PIN Trading
  const [oldPin, setOldPin] = useState('');
  const [newPin, setNewPin] = useState('');
  const [confirmPin, setConfirmPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  // Preference - Auto-refresh
  const [refreshInterval, setRefreshInterval] = useState(() => {
    return localStorage.getItem('refresh_interval') || '5';
  });

  // Preference - Sound
  const [soundEnabled, setSoundEnabled] = useState(() => {
    return localStorage.getItem('sound_notifications') !== 'false';
  });

  // --- Toast Helper ---
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  useEffect(() => {
    fetchAccountProfile();
  }, [fetchAccountProfile]);

  // --- Actions ---
  const handleSaveRdnSandbox = async (e: React.FormEvent) => {
    e.preventDefault();
    const val = parseFloat(rdnDepositAmount);
    if (isNaN(val) || val <= 0) {
      showToast('Masukkan jumlah nominal angka yang valid!', 'error');
      return;
    }
    try {
      await depositFunds(val);
      setRdnDepositAmount('0');
      showToast(`Saldo RDN Sandbox berhasil ditambah Rp ${val.toLocaleString('id-ID')} (Simulasi)`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Sandbox RDN belum tersedia', 'error');
    }
  };

  const handleUpdatePassword = (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPassword || !newPassword || !confirmPassword) {
      showToast('Harap lengkapi semua kolom password!', 'error');
      return;
    }
    if (newPassword !== confirmPassword) {
      showToast('Konfirmasi password baru tidak cocok!', 'error');
      return;
    }
    if (newPassword.length < 8) {
      showToast('Password baru minimal harus 8 karakter!', 'error');
      return;
    }
    
    // Simulasi Berhasil
    setOldPassword('');
    setNewPassword('');
    setConfirmPassword('');
    showToast('Password akun Anda berhasil diperbarui (Simulasi)', 'success');
  };

  const handleUpdatePin = (e: React.FormEvent) => {
    e.preventDefault();
    if (!oldPin || !newPin || !confirmPin) {
      showToast('Harap lengkapi semua kolom PIN!', 'error');
      return;
    }
    if (newPin !== confirmPin) {
      showToast('Konfirmasi PIN baru tidak cocok!', 'error');
      return;
    }
    if (newPin.length !== 6 || !/^\d+$/.test(newPin)) {
      showToast('PIN trading baru harus berupa 6 digit angka!', 'error');
      return;
    }

    // Simulasi Berhasil
    setOldPin('');
    setNewPin('');
    setConfirmPin('');
    showToast('PIN Trading Anda berhasil diperbarui (Simulasi)', 'success');
  };

  const handleSavePreferences = (e: React.FormEvent) => {
    e.preventDefault();
    localStorage.setItem('refresh_interval', refreshInterval);
    localStorage.setItem('sound_notifications', String(soundEnabled));
    showToast('Preferensi aplikasi berhasil disimpan!', 'success');
  };

  return (
    <div className="space-y-6 animate-fade-in" style={{ padding: '1rem 0' }}>
      
      {/* Toast Notification */}
      {toast && (
        <div 
          style={{
            position: 'fixed',
            top: '1.5rem',
            right: '1.5rem',
            zIndex: 9999,
            backgroundColor: toast.type === 'success' ? 'rgba(16, 185, 129, 0.95)' : 'rgba(239, 68, 68, 0.95)',
            color: 'white',
            padding: '0.85rem 1.5rem',
            borderRadius: '12px',
            boxShadow: '0 10px 25px -5px rgba(0, 0, 0, 0.3)',
            display: 'flex',
            alignItems: 'center',
            gap: '0.75rem',
            backdropFilter: 'blur(8px)',
            border: toast.type === 'success' ? '1px solid rgba(16, 185, 129, 0.2)' : '1px solid rgba(239, 68, 68, 0.2)',
            fontSize: '13px',
            fontWeight: 600
          }}
        >
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* HEADER SECTION */}
      <div>
        <h2 className="text-xl font-bold tracking-tight text-white mb-1" style={{ margin: 0 }}>
          Pengaturan
        </h2>
        <p className="text-xs text-[#8B949E]" style={{ margin: 0 }}>
          Konfigurasi data profil investasi, biaya transaksi bursa, keamanan PIN trading, dan parameter sandbox.
        </p>
      </div>

      {/* INNER TABS & CONTAINER */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* TAB BUTTONS (LEFT SIDEBAR ON LARGE SCREEN) */}
        <div className="lg:col-span-1 flex flex-row lg:flex-col gap-2 overflow-x-auto pb-2 lg:pb-0">
          <button
            onClick={() => setActiveTab('profile')}
            className="w-full text-xs font-semibold px-4 py-3 rounded-xl transition flex items-center gap-2.5 justify-start shrink-0"
            style={{
              backgroundColor: activeTab === 'profile' ? '#0F2C59' : '#161B22',
              color: activeTab === 'profile' ? '#FFFFFF' : '#8B949E',
              border: `1px solid ${activeTab === 'profile' ? 'rgba(15, 44, 89, 0.6)' : '#21262D'}`,
              textAlign: 'left'
            }}
          >
            <User size={15} />
            Akun & Profil
          </button>
          <button
            onClick={() => setActiveTab('fees')}
            className="w-full text-xs font-semibold px-4 py-3 rounded-xl transition flex items-center gap-2.5 justify-start shrink-0"
            style={{
              backgroundColor: activeTab === 'fees' ? '#0F2C59' : '#161B22',
              color: activeTab === 'fees' ? '#FFFFFF' : '#8B949E',
              border: `1px solid ${activeTab === 'fees' ? 'rgba(15, 44, 89, 0.6)' : '#21262D'}`,
              textAlign: 'left'
            }}
          >
            <Percent size={15} />
            Biaya Transaksi
          </button>
          <button
            onClick={() => setActiveTab('security')}
            className="w-full text-xs font-semibold px-4 py-3 rounded-xl transition flex items-center gap-2.5 justify-start shrink-0"
            style={{
              backgroundColor: activeTab === 'security' ? '#0F2C59' : '#161B22',
              color: activeTab === 'security' ? '#FFFFFF' : '#8B949E',
              border: `1px solid ${activeTab === 'security' ? 'rgba(15, 44, 89, 0.6)' : '#21262D'}`,
              textAlign: 'left'
            }}
          >
            <Shield size={15} />
            Keamanan
          </button>
          <button
            onClick={() => setActiveTab('preferences')}
            className="w-full text-xs font-semibold px-4 py-3 rounded-xl transition flex items-center gap-2.5 justify-start shrink-0"
            style={{
              backgroundColor: activeTab === 'preferences' ? '#0F2C59' : '#161B22',
              color: activeTab === 'preferences' ? '#FFFFFF' : '#8B949E',
              border: `1px solid ${activeTab === 'preferences' ? 'rgba(15, 44, 89, 0.6)' : '#21262D'}`,
              textAlign: 'left'
            }}
          >
            <SlidersHorizontal size={15} />
            Preferensi & Sandbox
          </button>
        </div>

        {/* TAB PANELS (RIGHT AREA) */}
        <div className="lg:col-span-3 bg-[#161B22] border border-[#21262D] rounded-2xl p-5 md:p-6 shadow-xl relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#E62225] via-[#0F2C59] to-[#E62225]"></div>

          {/* TAB 1: AKUN & PROFIL */}
          {activeTab === 'profile' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>Profil Pengguna</h3>
                <p className="text-xs text-[#8B949E]">Detail identitas investor yang terdaftar pada sistem Bursa Efek Indonesia.</p>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                
                {/* Email Info */}
                <div className="bg-[#0D1117] border border-[#21262D] rounded-xl p-4">
                  <span className="text-[10px] text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Email Terdaftar</span>
                  <span className="text-sm font-bold text-white block">{user?.email || 'N/A'}</span>
                  <span className="text-[9px] text-[#10B981] font-mono font-bold mt-1 inline-flex items-center gap-1">
                    <CheckCircle2 size={10} /> TERVERIFIKASI
                  </span>
                </div>

                {/* Account Status Info */}
                <div className="bg-[#0D1117] border border-[#21262D] rounded-xl p-4">
                  <span className="text-[10px] text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Status Akun Trading</span>
                  <span className="text-sm font-bold text-white block capitalize">{user?.status || 'Active Trader'}</span>
                  <span className="text-[9px] text-slate-300 font-mono font-bold mt-1 inline-flex items-center gap-1">
                    <CheckCircle2 size={10} className="text-[#10B981]" /> READY FOR MARKET
                  </span>
                </div>

                {/* SID Info */}
                <div className="bg-[#0D1117] border border-[#21262D] rounded-xl p-4 font-mono">
                  <span className="text-[10px] text-[#8B949E] uppercase font-bold tracking-wider block mb-1">SID (Single Investor Identification)</span>
                  <span className="text-sm font-bold text-white block">{accountProfile?.references?.sid || '-'}</span>
                  <span className="text-[9px] text-[#8B949E] mt-1 block">Nomor pengenal tunggal investor dari KSEI.</span>
                </div>

                {/* SRE Info */}
                <div className="bg-[#0D1117] border border-[#21262D] rounded-xl p-4 font-mono">
                  <span className="text-[10px] text-[#8B949E] uppercase font-bold tracking-wider block mb-1">SRE (Sub Rekening Efek)</span>
                  <span className="text-sm font-bold text-white block">{accountProfile?.references?.sre || '-'}</span>
                  <span className="text-[9px] text-[#8B949E] mt-1 block">Sub rekening efek untuk penitipan aset saham.</span>
                </div>

                {/* RDN Info */}
                <div className="bg-[#0D1117] border border-[#21262D] rounded-xl p-4 font-mono col-span-1 md:col-span-2">
                  <span className="text-[10px] text-[#8B949E] uppercase font-bold tracking-wider block mb-1">RDN (Rekening Dana Nasabah) - BCA</span>
                  <span className="text-sm font-bold text-white block">{accountProfile?.references?.rdn || '-'}</span>
                  <span className="text-[9px] text-[#8B949E] mt-1 block">Akun RDN penampungan dana tunai (BCA Virtual Account).</span>
                </div>

              </div>
            </div>
          )}

          {/* TAB 2: BIAYA TRANSAKSI */}
          {activeTab === 'fees' && (
            <div className="space-y-6">
              <div>
                <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>Rincian Biaya Transaksi</h3>
                <p className="text-xs text-[#8B949E]">Rasio tarif komisi bursa, kliring, penjaminan, dan pajak untuk setiap eksekusi order.</p>
              </div>

              {feeSchedule ? (
                <div className="border border-[#21262D] rounded-xl overflow-hidden font-mono text-xs">
                  <div className="bg-[#0D1117] p-3 border-b border-[#21262D] flex justify-between font-sans text-sm font-bold text-white">
                    <span>Komponen Biaya</span>
                    <span>Tarif (%)</span>
                  </div>
                  <div className="divide-y divide-[#21262D]/60 bg-[#0D1117]/30">
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Komisi Broker (Beli)</span>
                      <span className="text-white font-bold">{feeSchedule.brokerBuyRate ? `${parseFloat(feeSchedule.brokerBuyRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Komisi Broker (Jual)</span>
                      <span className="text-white font-bold">{feeSchedule.brokerSellRate ? `${parseFloat(feeSchedule.brokerSellRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Biaya Bursa (Levy BEI)</span>
                      <span className="text-white font-bold">{feeSchedule.exchangeFeeRate ? `${parseFloat(feeSchedule.exchangeFeeRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Biaya Kliring KPEI</span>
                      <span className="text-white font-bold">{feeSchedule.clearingFeeRate ? `${parseFloat(feeSchedule.clearingFeeRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Biaya Jasa KSEI</span>
                      <span className="text-white font-bold">{feeSchedule.settlementFeeRate ? `${parseFloat(feeSchedule.settlementFeeRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Dana Penjaminan</span>
                      <span className="text-white font-bold">{feeSchedule.guaranteeFundRate ? `${parseFloat(feeSchedule.guaranteeFundRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">PPN (VAT) atas Komisi Broker</span>
                      <span className="text-white font-bold">{feeSchedule.vatRate ? `${parseFloat(feeSchedule.vatRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 flex justify-between">
                      <span className="text-[#8B949E]">Pajak Penghasilan (PPh Jual)</span>
                      <span className="text-white font-bold">{feeSchedule.sellTaxRate ? `${parseFloat(feeSchedule.sellTaxRate) * 100}%` : '-'}</span>
                    </div>
                    <div className="p-3 bg-[#0F2C59]/10 flex justify-between font-sans font-bold">
                      <span className="text-slate-200">Batas Komisi Minimum per Hari</span>
                      <span className="text-white">{feeSchedule.minimumFee ? `Rp ${parseFloat(feeSchedule.minimumFee).toLocaleString('id-ID')}` : 'Rp 0'}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center text-[#8B949E] text-xs">
                  <AlertCircle size={20} className="mx-auto mb-2 text-[#8B949E] opacity-50" />
                  Gagal menarik informasi tarif bursa dari server.
                </div>
              )}
            </div>
          )}

          {/* TAB 3: KEAMANAN */}
          {activeTab === 'security' && (
            <div className="space-y-6">
              
              {/* PIN Trading */}
              <div>
                <div className="mb-4">
                  <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>Ganti PIN Trading</h3>
                  <p className="text-xs text-[#8B949E]">PIN 6-digit wajib dimasukkan setiap kali Anda ingin memasang order (BUY/SELL) saham.</p>
                </div>

                <form onSubmit={handleUpdatePin} className="space-y-3 max-w-sm">
                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">PIN Lama (6-digit)</label>
                    <input 
                      type={showPin ? "text" : "password"} 
                      maxLength={6}
                      value={oldPin}
                      onChange={(e) => setOldPin(e.target.value.replace(/\D/g, ''))}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225] font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">PIN Baru (6-digit)</label>
                    <input 
                      type={showPin ? "text" : "password"} 
                      maxLength={6}
                      value={newPin}
                      onChange={(e) => setNewPin(e.target.value.replace(/\D/g, ''))}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225] font-mono"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Konfirmasi PIN Baru</label>
                    <input 
                      type={showPin ? "text" : "password"} 
                      maxLength={6}
                      value={confirmPin}
                      onChange={(e) => setConfirmPin(e.target.value.replace(/\D/g, ''))}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225] font-mono"
                    />
                  </div>

                  <div className="flex justify-between items-center pt-1">
                    <button 
                      type="button"
                      onClick={() => setShowPin(!showPin)}
                      className="text-xs text-[#8B949E] hover:text-white transition flex items-center gap-1.5"
                      style={{ background: 'transparent', padding: 0 }}
                    >
                      {showPin ? <EyeOff size={14} /> : <Eye size={14} />}
                      {showPin ? "Sembunyikan" : "Tampilkan"} PIN
                    </button>

                    <button 
                      type="submit"
                      className="bg-[#0F2C59] hover:bg-[#163c78] text-xs text-white font-bold py-2 px-5 rounded-lg border border-[#21262D]"
                    >
                      Perbarui PIN
                    </button>
                  </div>
                </form>
              </div>

              <hr className="border-[#21262D]/60" />

              {/* Password */}
              <div>
                <div className="mb-4">
                  <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>Ganti Password Akun</h3>
                  <p className="text-xs text-[#8B949E]">Amankan akun Anda dengan mengganti password secara berkala.</p>
                </div>

                <form onSubmit={handleUpdatePassword} className="space-y-3 max-w-sm">
                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Password Lama</label>
                    <input 
                      type={showPassword ? "text" : "password"} 
                      value={oldPassword}
                      onChange={(e) => setOldPassword(e.target.value)}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225]"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Password Baru</label>
                    <input 
                      type={showPassword ? "text" : "password"} 
                      value={newPassword}
                      onChange={(e) => setNewPassword(e.target.value)}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225]"
                    />
                  </div>

                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Konfirmasi Password Baru</label>
                    <input 
                      type={showPassword ? "text" : "password"} 
                      value={confirmPassword}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225]"
                    />
                  </div>

                  <div className="flex justify-between items-center pt-1">
                    <button 
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="text-xs text-[#8B949E] hover:text-white transition flex items-center gap-1.5"
                      style={{ background: 'transparent', padding: 0 }}
                    >
                      {showPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                      {showPassword ? "Sembunyikan" : "Tampilkan"} Password
                    </button>

                    <button 
                      type="submit"
                      className="bg-[#0F2C59] hover:bg-[#163c78] text-xs text-white font-bold py-2 px-5 rounded-lg border border-[#21262D]"
                    >
                      Perbarui Password
                    </button>
                  </div>
                </form>
              </div>

            </div>
          )}

          {/* TAB 4: PREFERENSI & SANDBOX */}
          {activeTab === 'preferences' && (
            <div className="space-y-6">
              
              {/* RDN Sandbox Simulator */}
              <div>
                <div className="mb-4">
                  <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>RDN Sandbox Simulator</h3>
                  <p className="text-xs text-[#8B949E]">
                    Simulasi suntikan modal dana development. Dana masuk ke backend dan ledger, bukan lagi disimpan di browser.
                  </p>
                </div>

                <form onSubmit={handleSaveRdnSandbox} className="space-y-3 max-w-sm">
                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">
                      Nominal Deposit Simulasi (IDR)
                    </label>
                    <div className="flex gap-2">
                      <input 
                        type="number" 
                        value={rdnDepositAmount}
                        onChange={(e) => setRdnDepositAmount(e.target.value)}
                        className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225] font-mono font-bold"
                      />
                      <button 
                        type="submit"
                        className="bg-[#E62225] hover:brightness-110 text-xs text-white font-bold px-4 py-2 rounded-lg shrink-0 transition"
                      >
                        Terapkan
                      </button>
                    </div>
                    <span className="text-[9px] text-[#8B949E] mt-1.5 block leading-relaxed font-mono">
                      Production akan menolak simulator sampai integrasi RDN Bank Mandala aktif.
                    </span>
                  </div>
                </form>
              </div>

              <hr className="border-[#21262D]/60" />

              {/* Preference Form */}
              <div>
                <div className="mb-4">
                  <h3 className="text-base font-bold text-white mb-1" style={{ margin: 0 }}>Preferensi Aplikasi</h3>
                  <p className="text-xs text-[#8B949E]">Atur interval otomatis untuk merestruktur data aplikasi.</p>
                </div>

                <form onSubmit={handleSavePreferences} className="space-y-4 max-w-sm">
                  <div>
                    <label className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">
                      Interval Auto-Refresh Data Portofolio (Detik)
                    </label>
                    <select 
                      value={refreshInterval}
                      onChange={(e) => setRefreshInterval(e.target.value)}
                      className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225] font-mono"
                    >
                      <option value="2">2 Detik (Sangat Cepat)</option>
                      <option value="5">5 Detik (Default)</option>
                      <option value="10">10 Detik</option>
                      <option value="30">30 Detik</option>
                      <option value="manual">Manual (Segarkan Sendiri)</option>
                    </select>
                  </div>

                  <div className="flex items-center gap-2">
                    <input 
                      type="checkbox" 
                      id="soundEnabled"
                      checked={soundEnabled}
                      onChange={(e) => setSoundEnabled(e.target.checked)}
                      className="w-4 h-4 text-[#E62225] bg-[#0D1117] border-[#21262D] rounded focus:ring-0 focus:ring-offset-0 focus:outline-none cursor-pointer"
                      style={{ width: 'auto', padding: 0 }}
                    />
                    <label htmlFor="soundEnabled" className="text-xs text-[#8B949E] select-none cursor-pointer mb-0" style={{ margin: 0 }}>
                      Aktifkan efek suara (Sound Effect) jika order Matched
                    </label>
                  </div>

                  <div className="pt-2">
                    <button 
                      type="submit"
                      className="bg-[#0F2C59] hover:bg-[#163c78] text-xs text-white font-bold py-2.5 px-6 rounded-lg border border-[#21262D] transition"
                    >
                      Simpan Preferensi
                    </button>
                  </div>
                </form>
              </div>

            </div>
          )}

        </div>

      </div>

    </div>
  );
}
