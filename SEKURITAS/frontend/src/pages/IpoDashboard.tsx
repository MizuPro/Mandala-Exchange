import { useEffect, useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { useToast } from '../components/ui/Toast';
import { IpoEvent, IpoSubscription, IpoStatus, IpoSubscriptionStatus } from '../types/ipo';
import { 
  Building2, 
  Calendar, 
  DollarSign, 
  TrendingUp, 
  ShieldAlert,
  Clock, 
  CheckCircle2, 
  XCircle,
  HelpCircle,
  AlertCircle
} from 'lucide-react';

export default function IpoDashboard() {
  const navigate = useNavigate();
  const { success: showSuccessToast, error: showErrorToast } = useToast();
  
  // Zustand States & Actions
  const ipoEvents = useStore(state => state.ipoEvents);
  const ipoSubscriptions = useStore(state => state.ipoSubscriptions);
  const portfolio = useStore(state => state.portfolio);
  const fetchIpoEvents = useStore(state => state.fetchIpoEvents);
  const fetchIpoSubscriptions = useStore(state => state.fetchIpoSubscriptions);
  const subscribeIpo = useStore(state => state.subscribeIpo);
  const cancelIpoSubscription = useStore(state => state.cancelIpoSubscription);
  const fetchPortfolio = useStore(state => state.fetchPortfolio);

  // Local States
  const [selectedIpoId, setSelectedIpoId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'active' | 'completed'>('active');
  const [subscriptionQtyLot, setSubscriptionQtyLot] = useState<string>('1');
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [isCancelling, setIsCancelling] = useState<boolean>(false);
  const [showConfirmModal, setShowConfirmModal] = useState<boolean>(false);
  const [showCancelConfirmModal, setShowCancelConfirmModal] = useState<boolean>(false);
  const [cancellingSubscriptionId, setCancellingSubscriptionId] = useState<string | null>(null);

  // Load Data & Polling dengan Page Visibility API
  useEffect(() => {
    fetchIpoEvents();
    fetchIpoSubscriptions();
    fetchPortfolio();

    let intervalId: any = null;

    const startPolling = () => {
      if (!intervalId) {
        intervalId = setInterval(() => {
          if (!document.hidden) {
            fetchIpoEvents();
            fetchIpoSubscriptions();
          }
        }, 12000); // Polling setiap 12 detik
      }
    };

    const stopPolling = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const handleVisibilityChange = () => {
      if (document.hidden) {
        stopPolling();
      } else {
        fetchIpoEvents();
        fetchIpoSubscriptions();
        startPolling();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    startPolling();

    return () => {
      stopPolling();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [fetchIpoEvents, fetchIpoSubscriptions, fetchPortfolio]);

  // Buying Power Helper
  const buyingPower = useMemo(() => {
    return Math.max(0, parseFloat(portfolio?.cash?.available || '0'));
  }, [portfolio]);

  // Filter IPOs
  const filteredIpos = useMemo(() => {
    return ipoEvents.filter(ipo => {
      const isFinished = ipo.status === 'listed' || ipo.status === 'cancelled';
      if (activeTab === 'active') {
        return !isFinished;
      } else {
        return isFinished;
      }
    });
  }, [ipoEvents, activeTab]);

  // Selected IPO
  const selectedIpo = useMemo(() => {
    return ipoEvents.find(ipo => ipo.id === selectedIpoId) || null;
  }, [ipoEvents, selectedIpoId]);

  // Auto-Redirect ke halaman perdagangan ketika saham berstatus listed
  useEffect(() => {
    if (selectedIpo && selectedIpo.status === 'listed') {
      showSuccessToast(
        `Saham ${selectedIpo.symbol} telah resmi listed di bursa! Mengalihkan ke halaman pasar saham perdagangan...`,
        'IPO Terdaftar (Listed)'
      );
      const timer = setTimeout(() => {
        navigate(`/market/${selectedIpo.symbol}`);
      }, 2000);
      return () => clearTimeout(timer);
    }
  }, [selectedIpo, navigate, showSuccessToast]);

  // Selected IPO Subscriptions
  const selectedIpoSubscriptions = useMemo(() => {
    if (!selectedIpoId) return [];
    return ipoSubscriptions.filter(sub => sub.ipo_event_id === selectedIpoId);
  }, [ipoSubscriptions, selectedIpoId]);

  // Active Subscription (if any)
  const activeSubscription = useMemo(() => {
    const ACTIVE_STATUSES = ['cash_reserved', 'submitted_to_bei', 'allocated', 'settled'];
    return selectedIpoSubscriptions.find(sub => ACTIVE_STATUSES.includes(sub.status)) || null;
  }, [selectedIpoSubscriptions]);

  // Time Window Validation for Subscription Form
  const isSubscriptionWindowOpen = useMemo(() => {
    if (!selectedIpo || selectedIpo.status !== 'subscription') return false;
    const now = Date.now();
    const start = new Date(selectedIpo.subscription_start).getTime();
    const end = new Date(selectedIpo.subscription_end).getTime();
    return now >= start && now <= end;
  }, [selectedIpo]);

  // Numeric quantities
  const qtyLotNum = parseInt(subscriptionQtyLot) || 0;
  const requestedShares = selectedIpo ? qtyLotNum * selectedIpo.subscription_lot_size : 0;
  const estimatedCost = selectedIpo ? requestedShares * selectedIpo.offering_price_idr : 0;
  const isBalanceSufficient = buyingPower >= estimatedCost;

  // Handlers
  const handleQtyChange = (val: string) => {
    setSubscriptionQtyLot(val);
    setIdempotencyKey(null); // Reset key karena input payload berubah
  };

  const handleOpenConfirm = (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedIpo) return;
    if (qtyLotNum <= 0) {
      showErrorToast('Jumlah lot pemesanan harus lebih besar dari 0', 'Validasi Gagal');
      return;
    }
    if (!isBalanceSufficient) {
      showErrorToast('Saldo tunai (Buying Power) RDN Anda tidak mencukupi', 'Saldo Kurang');
      return;
    }

    // Generate Idempotency Key Stabil yang melekat pada submit attempt ini
    if (!idempotencyKey) {
      const randomPart = Math.random().toString(36).substring(2, 9);
      const stableKey = `user:ipo:${selectedIpo.id}:${qtyLotNum}:${randomPart}`;
      setIdempotencyKey(stableKey);
    }

    setShowConfirmModal(true);
  };

  const handleExecuteSubscribe = async () => {
    if (!selectedIpo || !isBalanceSufficient || !idempotencyKey) return;
    setIsSubmitting(true);

    try {
      await subscribeIpo(selectedIpo.id, requestedShares, idempotencyKey);
      showSuccessToast(`Pemesanan IPO ${selectedIpo.symbol} sebanyak ${qtyLotNum} Lot berhasil diajukan.`, 'Pemesanan Berhasil');
      setSubscriptionQtyLot('1');
      setIdempotencyKey(null); // Reset setelah sukses
      setShowConfirmModal(false);
    } catch (err: any) {
      showErrorToast(err.message || 'Gagal mengajukan pemesanan IPO. Silakan coba lagi.', 'Pemesanan Gagal');
      // Catatan: JANGAN mereset idempotencyKey di sini agar ketika pengguna melakukan retry
      // (klik "Ya, Konfirmasi" lagi), key yang sama tetap digunakan.
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleOpenCancelConfirm = (subscriptionId: string) => {
    setCancellingSubscriptionId(subscriptionId);
    setShowCancelConfirmModal(true);
  };

  const handleExecuteCancel = async () => {
    if (!selectedIpo || !cancellingSubscriptionId) return;
    setIsCancelling(true);

    try {
      await cancelIpoSubscription(selectedIpo.id, cancellingSubscriptionId);
      showSuccessToast(`Pemesanan IPO ${selectedIpo.symbol} berhasil dibatalkan.`, 'Pembatalan Berhasil');
      setShowCancelConfirmModal(false);
    } catch (err: any) {
      showErrorToast(err.message || 'Gagal membatalkan pemesanan IPO.', 'Pembatalan Gagal');
    } finally {
      setIsCancelling(false);
      setCancellingSubscriptionId(null);
    }
  };

  // Helper Formatter
  const formatIDR = (val: number | string) => {
    const num = typeof val === 'string' ? parseFloat(val) : val;
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(num);
  };

  const formatDate = (dateStr?: string) => {
    if (!dateStr) return '-';
    return new Intl.DateTimeFormat('id-ID', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(dateStr));
  };

  const getStatusBadgeClass = (status: IpoStatus) => {
    switch (status) {
      case 'bookbuilding': return 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30';
      case 'subscription': return 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/30';
      case 'allocation': return 'bg-amber-950/40 text-amber-400 border border-amber-800/30';
      case 'listed': return 'bg-blue-950/40 text-blue-400 border border-blue-800/30';
      case 'cancelled': return 'bg-red-950/40 text-red-400 border border-red-800/30';
      default: return 'bg-slate-950/40 text-slate-400 border border-slate-800/30';
    }
  };

  const getSubscriptionStatusBadgeClass = (status: IpoSubscriptionStatus) => {
    switch (status) {
      case 'cash_reserved': return 'bg-blue-950/40 text-blue-400 border border-blue-800/30';
      case 'submitted_to_bei': return 'bg-cyan-950/40 text-cyan-400 border border-cyan-800/30';
      case 'allocated': return 'bg-emerald-950/40 text-emerald-400 border border-emerald-800/30';
      case 'refunded': return 'bg-amber-950/40 text-amber-400 border border-amber-800/30';
      case 'settled': return 'bg-green-950/40 text-green-400 border border-green-800/30';
      case 'cancelled': 
      case 'reversed': return 'bg-red-950/40 text-red-400 border border-red-800/30';
      default: return 'bg-slate-950/40 text-slate-400 border border-slate-800/30';
    }
  };

  const getSubscriptionStatusLabel = (status: IpoSubscriptionStatus) => {
    switch (status) {
      case 'cash_reserved': return 'Dana Dicadangkan';
      case 'submitted_to_bei': return 'Terkirim ke BEI';
      case 'allocated': return 'Saham Dijatah';
      case 'refunded': return 'Dana Dikembalikan (Sisa)';
      case 'settled': return 'Distribusi Selesai';
      case 'cancelled': return 'Dibatalkan Pengguna';
      case 'reversed': return 'Dibatalkan Bursa (Reversal)';
      default: return status;
    }
  };

  const getArchetypeBadgeClass = (arch?: string) => {
    if (!arch) return 'bg-slate-950/40 text-slate-400 border border-slate-800/30';
    switch (arch) {
      case 'hot_ipo': return 'bg-gradient-to-r from-red-500/20 to-orange-500/20 text-orange-400 border border-orange-500/30 font-bold';
      case 'overpriced_ipo': return 'bg-gradient-to-r from-amber-500/20 to-yellow-500/20 text-yellow-400 border border-yellow-500/30';
      case 'quiet_ipo': return 'bg-gradient-to-r from-slate-500/20 to-blue-500/10 text-slate-400 border border-slate-700/30';
      case 'normal_ipo': return 'bg-gradient-to-r from-emerald-500/20 to-teal-500/20 text-emerald-400 border border-emerald-500/30';
      case 'failed_hype_ipo': return 'bg-gradient-to-r from-rose-950/40 to-slate-950/40 text-rose-400 border border-rose-900/30';
      default: return 'bg-slate-950/40 text-slate-400 border border-slate-800/30';
    }
  };

  return (
    <div className="container" style={{ maxWidth: '1400px', padding: '1.5rem 1rem' }}>
      
      {/* HEADER BANNER */}
      <div className="glass-panel p-6 mb-6 relative overflow-hidden" style={{ borderLeft: '4px solid var(--primary)' }}>
        <div className="absolute top-0 right-0 p-4 opacity-5 pointer-events-none">
          <Building2 size={160} />
        </div>
        <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
          <div>
            <h2 className="text-xl font-bold text-white mb-1" style={{ margin: 0 }}>Portal e-IPO Mandala Exchange</h2>
            <p className="text-xs text-[var(--text-muted)]" style={{ margin: 0 }}>
              Daftar penawaran umum perdana saham emiten baru. Analisis sentimen, periksa nilai wajar, dan ikuti IPO secara instan.
            </p>
          </div>
          <div className="bg-[#0D1117] border border-[#21262D] rounded-xl px-4 py-3 text-right">
            <p className="text-[10px] text-[#8B949E] uppercase tracking-wider mb-0.5 leading-none">Buying Power RDN Anda</p>
            <p className="text-base font-bold font-mono text-emerald-400 leading-none" style={{ margin: 0 }}>
              {formatIDR(buyingPower)}
            </p>
          </div>
        </div>
      </div>

      {/* DUA PANEL SPLIT LAYOUT */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        
        {/* PANEL KIRI: LIST IPO EVENTS */}
        <div className="lg:col-span-5 space-y-4">
          
          {/* CONTROL TABS */}
          <div className="flex border-b border-[#21262D] gap-2 pb-0">
            <button
              onClick={() => { setActiveTab('active'); setSelectedIpoId(null); setIdempotencyKey(null); }}
              className={`pb-3 px-4 text-xs font-semibold border-b-2 transition-all ${
                activeTab === 'active' 
                  ? 'border-[var(--primary)] text-white' 
                  : 'border-transparent text-[var(--text-muted)] hover:text-white'
              }`}
              style={{ background: 'transparent', borderRadius: 0, padding: '0.75rem 1rem' }}
            >
              Penawaran Aktif ({ipoEvents.filter(ipo => ipo.status !== 'listed' && ipo.status !== 'cancelled').length})
            </button>
            <button
              onClick={() => { setActiveTab('completed'); setSelectedIpoId(null); setIdempotencyKey(null); }}
              className={`pb-3 px-4 text-xs font-semibold border-b-2 transition-all ${
                activeTab === 'completed' 
                  ? 'border-[var(--primary)] text-white' 
                  : 'border-transparent text-[var(--text-muted)] hover:text-white'
              }`}
              style={{ background: 'transparent', borderRadius: 0, padding: '0.75rem 1rem' }}
            >
              Riwayat IPO Selesai ({ipoEvents.filter(ipo => ipo.status === 'listed' || ipo.status === 'cancelled').length})
            </button>
          </div>

          {/* LIST CARDS */}
          <div className="space-y-3 overflow-y-auto pr-1" style={{ maxHeight: 'calc(100vh - 320px)' }}>
            {filteredIpos.length === 0 ? (
              <div className="glass-panel p-8 text-center">
                <Building2 size={36} className="mx-auto text-[#8B949E] mb-3 opacity-60" />
                <p className="text-xs text-[var(--text-muted)]" style={{ margin: 0 }}>
                  Tidak ada emiten dalam kategori ini saat ini.
                </p>
              </div>
            ) : (
              filteredIpos.map((ipo) => {
                const isSelected = ipo.id === selectedIpoId;
                const hasSub = ipoSubscriptions.some(s => s.ipo_event_id === ipo.id && ['cash_reserved', 'submitted_to_bei', 'allocated', 'settled'].includes(s.status));
                
                return (
                  <div
                    key={ipo.id}
                    onClick={() => {
                      setSelectedIpoId(ipo.id);
                      setSubscriptionQtyLot('1');
                      setIdempotencyKey(null);
                    }}
                    className={`glass-panel p-4 cursor-pointer transition-all hover:-translate-y-0.5 ${
                      isSelected 
                        ? 'border-[var(--primary)] bg-red-950/10 shadow-glow' 
                        : 'border-[#21262D]'
                    }`}
                  >
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-2.5">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center font-bold text-sm bg-gradient-to-br from-[#0F2C59] to-[#161B22] border border-[#21262D] text-white">
                          {ipo.symbol.slice(0, 4)}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-extrabold text-sm text-white">{ipo.symbol}</span>
                            {hasSub && (
                              <span className="text-[9px] bg-emerald-950 text-emerald-400 border border-emerald-800/30 px-1.5 py-0.2 rounded-full font-medium">
                                Dipesan
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-[var(--text-muted)] block line-clamp-1">
                            {ipo.company_name}
                          </span>
                        </div>
                      </div>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${getStatusBadgeClass(ipo.status)}`}>
                        {ipo.status === 'bookbuilding' ? 'Masa Minat' : ipo.status}
                      </span>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-4 pt-3 border-t border-[#21262D]/60 text-xs">
                      <div>
                        <span className="text-[10px] text-[var(--text-muted)] block">Harga Penawaran</span>
                        <span className="font-bold text-white font-mono">{formatIDR(ipo.offering_price_idr)}</span>
                      </div>
                      <div>
                        <span className="text-[10px] text-[var(--text-muted)] block">Listing Bursa</span>
                        <span className="font-bold text-white">{formatDate(ipo.listing_at).split(',')[0]}</span>
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* PANEL KANAN: IPO DETAIL & INTERACTIVE FORM */}
        <div className="lg:col-span-7">
          {!selectedIpo ? (
            <div className="glass-panel p-12 text-center flex flex-col items-center justify-center" style={{ minHeight: '400px' }}>
              <div className="w-16 h-16 rounded-full bg-[#161B22] border border-[#21262D] flex items-center justify-center mb-4">
                <Building2 size={28} className="text-[#8B949E]" />
              </div>
              <h3 className="text-base font-bold text-white mb-2" style={{ margin: 0 }}>Pilih Emiten IPO</h3>
              <p className="text-xs text-[var(--text-muted)] max-w-sm mb-0">
                Pilih salah satu emiten dari daftar di sebelah kiri untuk melihat detail prospektus publik, fair value, archetype, dan memesan saham IPO.
              </p>
            </div>
          ) : (
            <div className="space-y-6">
              
              {/* DETAILS GLASS CONTAINER */}
              <div className="glass-panel p-6">
                
                {/* Header detail */}
                <div className="flex justify-between items-start pb-4 border-b border-[#21262D] mb-4">
                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <h3 className="text-lg font-bold text-white mb-0" style={{ margin: 0 }}>{selectedIpo.symbol}</h3>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full uppercase font-bold ${getStatusBadgeClass(selectedIpo.status)}`}>
                        {selectedIpo.status}
                      </span>
                    </div>
                    <p className="text-xs text-[var(--text-muted)] m-0" style={{ margin: 0 }}>{selectedIpo.company_name}</p>
                  </div>
                  
                  {/* Archetype Badge */}
                  {selectedIpo.ipo_archetype && (
                    <div className="text-right">
                      <span className={`text-xs px-3 py-1 rounded-full uppercase font-extrabold ${getArchetypeBadgeClass(selectedIpo.ipo_archetype)}`}>
                        {selectedIpo.ipo_archetype.replace(/_/g, ' ')}
                      </span>
                    </div>
                  )}
                </div>

                {/* Disclaimer / Konteks Risiko e-IPO */}
                <div className="flex gap-2.5 p-3 rounded-lg text-[10px] leading-relaxed mb-6" style={{ backgroundColor: 'rgba(245, 158, 11, 0.05)', border: '1px solid rgba(245, 158, 11, 0.25)', color: '#F59E0B' }}>
                  <AlertCircle size={15} style={{ flexShrink: 0, marginTop: '1px' }} />
                  <div>
                    <strong>Disclaimer Informasi e-IPO:</strong> Informasi Hype Score BEI dan Initial Fair Value (Nilai Wajar Awal) di atas hanya merupakan proyeksi analitis simulasi dan sentimen pasar saat ini. Data ini <strong>bukan merupakan jaminan keuntungan (return)</strong> di masa depan, bukan nasihat investasi resmi, dan tidak menjamin alokasi penjatahan saham perdana secara penuh (full allotment). Keputusan investasi sepenuhnya berada di tangan Anda.
                  </div>
                </div>

                {/* Grid 1: Hype Score, Fair value & Listing Sentiment */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
                  
                  {/* Hype score */}
                  <div className="bg-[#0D1117]/80 border border-[#21262D] rounded-xl p-4 flex flex-col justify-between">
                    <span className="text-[10px] text-[#8B949E] uppercase tracking-wider block mb-2">Hype Score BEI</span>
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-2xl font-extrabold text-orange-400 font-mono">
                        {selectedIpo.ipo_hype_score ?? 'N/A'}
                      </span>
                      <span className="text-xs text-[#8B949E]">/100</span>
                    </div>
                    {selectedIpo.ipo_hype_score && (
                      <div className="w-full bg-slate-800 rounded-full h-1.5 mt-2">
                        <div 
                          className="bg-gradient-to-r from-orange-600 to-orange-400 h-1.5 rounded-full" 
                          style={{ width: `${selectedIpo.ipo_hype_score}%` }}
                        ></div>
                      </div>
                    )}
                  </div>

                  {/* Initial Fair Value */}
                  <div className="bg-[#0D1117]/80 border border-[#21262D] rounded-xl p-4 flex flex-col justify-between">
                    <span className="text-[10px] text-[#8B949E] uppercase tracking-wider block mb-2">Initial Fair Value</span>
                    <div>
                      <p className="text-lg font-bold text-white font-mono mb-0.5 leading-none" style={{ margin: 0 }}>
                        {selectedIpo.fair_value_initial ? formatIDR(selectedIpo.fair_value_initial) : 'N/A'}
                      </p>
                      {selectedIpo.fair_value_confidence && (
                        <span className="text-[10px] text-[#8B949E] block mt-1">
                          Keyakinan: <span className="font-semibold text-slate-300 capitalize">{selectedIpo.fair_value_confidence}</span>
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Sentimen & Float */}
                  <div className="bg-[#0D1117]/80 border border-[#21262D] rounded-xl p-4 flex flex-col justify-between">
                    <span className="text-[10px] text-[#8B949E] uppercase tracking-wider block mb-2">Sentimen Sektor</span>
                    <div>
                      <p className="text-sm font-bold text-white capitalize mb-0.5 leading-none" style={{ margin: 0 }}>
                        {selectedIpo.sector_sentiment || 'Netral'}
                      </p>
                      {selectedIpo.float_ratio && (
                        <span className="text-[10px] text-[#8B949E] block mt-1">
                          Rasio Float: <span className="font-semibold text-slate-300 capitalize">{selectedIpo.float_ratio}</span>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                {/* Grid 2: Prospektus Ringkas */}
                <div className="border-t border-[#21262D] pt-4">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-3">Ringkasan Prospektus IPO</h4>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-4 text-xs">
                    <div>
                      <span className="text-[#8B949E] block mb-0.5">Jumlah Saham Ditawarkan</span>
                      <span className="font-bold text-white font-mono">
                        {selectedIpo.offered_shares.toLocaleString('id-ID')} Lembar
                      </span>
                    </div>
                    <div>
                      <span className="text-[#8B949E] block mb-0.5">Ukuran Minimal Lot</span>
                      <span className="font-bold text-white font-mono">
                        {selectedIpo.subscription_lot_size} Lembar / Lot
                      </span>
                    </div>
                    <div>
                      <span className="text-[#8B949E] block mb-0.5">Harga Penawaran</span>
                      <span className="font-bold text-white font-mono">
                        {formatIDR(selectedIpo.offering_price_idr)}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Jadwal IPO */}
                <div className="mt-4 pt-4 border-t border-[#21262D]/60 text-xs">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-3">Jadwal Pelaksanaan IPO</h4>
                  <div className="space-y-2.5">
                    {selectedIpo.bookbuilding_start && (
                      <div className="flex justify-between items-center bg-[#0D1117]/30 px-3 py-2 rounded-lg border border-[#21262D]/40">
                        <span className="text-[#8B949E] flex items-center gap-1.5">
                          <Calendar size={13} /> Masa Minat (Bookbuilding)
                        </span>
                        <span className="font-semibold text-slate-300">
                          {formatDate(selectedIpo.bookbuilding_start).split(',')[0]} - {formatDate(selectedIpo.bookbuilding_end).split(',')[0]}
                        </span>
                      </div>
                    )}
                    <div className="flex justify-between items-center bg-[#0D1117]/30 px-3 py-2 rounded-lg border border-[#21262D]/40">
                      <span className="text-[#8B949E] flex items-center gap-1.5">
                        <Clock size={13} /> Masa Penawaran (Offering)
                      </span>
                      <span className="font-semibold text-white">
                        {formatDate(selectedIpo.subscription_start)} - {formatDate(selectedIpo.subscription_end)}
                      </span>
                    </div>
                    <div className="flex justify-between items-center bg-[#0D1117]/30 px-3 py-2 rounded-lg border border-[#21262D]/40">
                      <span className="text-[#8B949E] flex items-center gap-1.5">
                        <TrendingUp size={13} /> Tanggal Listing Bursa
                      </span>
                      <span className="font-semibold text-emerald-400">
                        {formatDate(selectedIpo.listing_at)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* SECTION: FORM SUBSCRIPTION */}
              {selectedIpo.status === 'subscription' && (
                <div className="glass-panel p-6">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-4 flex items-center gap-2">
                    <DollarSign size={15} className="text-emerald-400" /> Pemesanan Saham IPO
                  </h4>
                  
                  {isSubscriptionWindowOpen ? (
                    activeSubscription ? (
                      <div className="p-4 rounded-xl text-center bg-emerald-950/20 border border-emerald-900/30">
                        <CheckCircle2 className="text-emerald-400 mx-auto mb-2" size={24} />
                        <p className="text-xs font-semibold text-white mb-1" style={{ margin: 0 }}>
                          Anda sudah memiliki pemesanan aktif untuk IPO ini.
                        </p>
                        <p className="text-[10px] text-[#8B949E]" style={{ margin: 0 }}>
                          Jumlah: {activeSubscription.requested_shares.toLocaleString('id-ID')} Lembar ({activeSubscription.requested_shares / selectedIpo.subscription_lot_size} Lot).
                        </p>
                      </div>
                    ) : (
                      <form onSubmit={handleOpenConfirm} className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                          <div>
                            <label className="text-[10px] text-[#8B949E] uppercase tracking-wider block mb-1.5">Jumlah Pesanan (Lot)</label>
                            <input
                              type="number"
                              min="1"
                              value={subscriptionQtyLot}
                              onChange={(e) => handleQtyChange(e.target.value)}
                              placeholder="Min: 1"
                              className="bg-[#0D1117] border border-[#21262D] text-sm text-white focus:border-[#E62225] font-mono p-3 rounded-lg"
                              required
                            />
                            <span className="text-[10px] text-[#8B949E] mt-1 block">
                              1 Lot = {selectedIpo.subscription_lot_size} lembar saham
                            </span>
                          </div>
                          <div>
                            <label className="text-[10px] text-[#8B949E] uppercase tracking-wider block mb-1.5">Estimasi Dana Cadangan (Reserved)</label>
                            <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-3 text-right">
                              <span className="text-base font-bold font-mono text-white leading-none">
                                {formatIDR(estimatedCost)}
                              </span>
                            </div>
                            <span className="text-[10px] text-[#8B949E] mt-1 block text-right">
                              {requestedShares.toLocaleString('id-ID')} Lembar x {formatIDR(selectedIpo.offering_price_idr)}
                            </span>
                          </div>
                        </div>

                        {/* Error Insufficient Balance */}
                        {!isBalanceSufficient && (
                          <div className="flex items-center gap-2 p-3 bg-red-950/20 border border-red-900/30 rounded-lg text-red-400 text-xs">
                            <AlertCircle size={15} />
                            <span>Buying Power Anda tidak mencukupi untuk pesanan sebesar ini.</span>
                          </div>
                        )}

                        <div className="flex justify-end pt-2">
                          <button
                            type="submit"
                            disabled={isSubmitting || qtyLotNum <= 0 || !isBalanceSufficient}
                            className="btn-primary text-xs py-3 px-6 rounded-lg w-full md:w-auto"
                          >
                            Ajukan Pemesanan IPO
                          </button>
                        </div>
                      </form>
                    )
                  ) : (
                    <div className="p-4 rounded-xl text-center bg-red-950/15 border border-red-900/30 flex items-center justify-center gap-3 text-red-400 text-xs">
                      <Clock size={16} />
                      <span className="text-left">
                        <strong>Masa penawaran belum dibuka atau sudah ditutup.</strong><br />
                        Jadwal: {formatDate(selectedIpo.subscription_start)} s/d {formatDate(selectedIpo.subscription_end)}
                      </span>
                    </div>
                  )}
                </div>
              )}

              {/* SECTION: USER SUBSCRIPTION HISTORY */}
              {selectedIpoSubscriptions.length > 0 && (
                <div className="glass-panel p-6">
                  <h4 className="text-xs font-bold text-white uppercase tracking-wider mb-4">
                    Status Pemesanan Saya
                  </h4>
                  <div className="space-y-4">
                    {selectedIpoSubscriptions.map((sub) => {
                      const isCancellable = ['cash_reserved', 'submitted_to_bei'].includes(sub.status);
                      
                      return (
                        <div key={sub.subscription_id} className="bg-[#0D1117]/80 border border-[#21262D] rounded-xl p-4 space-y-3">
                          <div className="flex justify-between items-center pb-2 border-b border-[#21262D]/60">
                            <div>
                              <span className="text-[10px] text-[#8B949E] block">ID Pemesanan</span>
                              <span className="font-mono text-[11px] text-slate-300 font-bold">{sub.subscription_id}</span>
                            </div>
                            <span className={`text-[10px] px-2.5 py-1 rounded-full uppercase font-bold ${getSubscriptionStatusBadgeClass(sub.status)}`}>
                              {getSubscriptionStatusLabel(sub.status)}
                            </span>
                          </div>

                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                            <div>
                              <span className="text-[10px] text-[#8B949E] block mb-0.5">Jumlah Dipesan</span>
                              <span className="font-bold text-white font-mono">
                                {sub.requested_shares.toLocaleString('id-ID')} ({sub.requested_shares / selectedIpo.subscription_lot_size} Lot)
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8B949E] block mb-0.5">Jumlah Dijatah</span>
                              <span className="font-bold text-emerald-400 font-mono">
                                {sub.allocated_shares.toLocaleString('id-ID')} Lembar
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8B949E] block mb-0.5">Dana Dicadangkan</span>
                              <span className="font-bold text-white font-mono">
                                {formatIDR(sub.reserved_cash_idr)}
                              </span>
                            </div>
                            <div>
                              <span className="text-[10px] text-[#8B949E] block mb-0.5">Debit Riil / Fee</span>
                              <span className="font-bold text-rose-400 font-mono">
                                {formatIDR(parseFloat(sub.actual_debit_idr) + parseFloat(sub.official_fee_idr))}
                              </span>
                            </div>
                          </div>

                          {/* Action cancel */}
                          {isCancellable && (
                            <div className="flex justify-end pt-1">
                              <button
                                onClick={() => handleOpenCancelConfirm(sub.subscription_id)}
                                disabled={isCancelling}
                                className="btn-danger py-1.5 px-4 text-[11px] rounded-lg"
                                style={{ padding: '0.4rem 0.8rem', background: 'rgba(239, 68, 68, 0.1)', color: '#EF4444', border: '1px solid rgba(239, 68, 68, 0.3)' }}
                              >
                                Batalkan Pemesanan
                              </button>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ==========================================
          MODALS & OVERLAYS INTERAKTIF
          ========================================== */}

      {/* CONFIRM SUBSCRIPTION MODAL */}
      {showConfirmModal && selectedIpo && (
        <div className="modal-overlay">
          <div className="modal-content-premium max-w-md">
            <h3 className="text-base font-bold text-white mb-2">Konfirmasi Pemesanan IPO</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              Harap verifikasi pemesanan perdana saham Anda di bawah. Dana Buying Power Anda akan dicadangkan di RDN secara instan.
            </p>
            
            <div className="space-y-2.5 bg-[#0D1117] border border-[#21262D] rounded-xl p-4 text-xs mb-4">
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Emiten Saham</span>
                <span className="font-bold text-white">{selectedIpo.symbol} - {selectedIpo.company_name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Jumlah Lot</span>
                <span className="font-bold text-white font-mono">{qtyLotNum} Lot ({requestedShares.toLocaleString('id-ID')} Lembar)</span>
              </div>
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Harga Per Saham</span>
                <span className="font-bold text-white font-mono">{formatIDR(selectedIpo.offering_price_idr)}</span>
              </div>
              <div className="flex justify-between border-t border-[#21262D]/60 pt-2.5 mt-2">
                <span className="text-[#8B949E] font-bold">Total Dana Dicadangkan</span>
                <span className="font-extrabold text-emerald-400 font-mono text-sm">{formatIDR(estimatedCost)}</span>
              </div>
            </div>

            <div className="flex gap-3">
              <button 
                type="button" 
                onClick={() => { setShowConfirmModal(false); }}
                disabled={isSubmitting}
                className="flex-grow btn-secondary-dark text-xs py-2.5 rounded-lg"
              >
                Batal
              </button>
              <button 
                type="button" 
                onClick={handleExecuteSubscribe}
                disabled={isSubmitting}
                className="flex-grow btn-primary-red text-xs py-2.5 rounded-lg"
              >
                {isSubmitting ? 'Memproses...' : 'Ya, Konfirmasi'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* CONFIRM CANCEL MODAL */}
      {showCancelConfirmModal && selectedIpo && (
        <div className="modal-overlay">
          <div className="modal-content-premium max-w-sm">
            <h3 className="text-base font-bold text-white mb-2">Batalkan Pemesanan IPO</h3>
            <p className="text-xs text-[var(--text-muted)] mb-4">
              Apakah Anda yakin ingin membatalkan pemesanan IPO untuk saham {selectedIpo.symbol}? 
              Dana cadangan Anda akan dikembalikan secara utuh ke saldo Buying Power RDN Anda.
            </p>

            <div className="flex gap-3">
              <button 
                type="button" 
                onClick={() => { setShowCancelConfirmModal(false); setCancellingSubscriptionId(null); }}
                disabled={isCancelling}
                className="flex-grow btn-secondary-dark text-xs py-2.5 rounded-lg"
              >
                Jangan Batalkan
              </button>
              <button 
                type="button" 
                onClick={handleExecuteCancel}
                disabled={isCancelling}
                className="flex-grow btn-primary-red text-xs py-2.5 rounded-lg bg-red-600 hover:bg-red-500"
              >
                {isCancelling ? 'Memproses...' : 'Ya, Batalkan Pesanan'}
              </button>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
