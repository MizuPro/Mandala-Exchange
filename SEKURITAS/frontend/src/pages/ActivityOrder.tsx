import { useEffect, useState, useMemo } from 'react';
import { useStore, Order } from '../store/useStore';
import { 
  Clock, 
  Search, 
  Trash2, 
  Edit3, 
  CheckCircle2, 
  AlertCircle, 
  X, 
  Filter,
  TrendingUp,
  TrendingDown,
  Info
} from 'lucide-react';

const LOT_SIZE = 100;

export default function ActivityOrder() {
  const orders = useStore(state => state.orders);
  const fetchOrders = useStore(state => state.fetchOrders);
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const cancelOrder = useStore(state => state.cancelOrder);
  const amendOrder = useStore(state => state.amendOrder);
  const orderActionLoading = useStore(state => state.orderActionLoading);

  // --- Local States ---
  const [searchTerm, setSearchTerm] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | 'BUY' | 'SELL' | 'MATCHED' | 'PENDING' | 'CANCELLED_REJECTED'>('ALL');
  
  // Toast notifications
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Modals States
  const [amendModalOpen, setAmendModalOpen] = useState(false);
  const [selectedOrderForAmend, setSelectedOrderForAmend] = useState<Order | null>(null);
  const [amendPrice, setAmendPrice] = useState<number>(0);
  const [amendQty, setAmendQty] = useState<number>(0); // dalam Lot

  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [selectedOrderForCancel, setSelectedOrderForCancel] = useState<Order | null>(null);

  // --- Toast Helper ---
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // --- Fetch Data on Mount ---
  useEffect(() => {
    fetchOrders();
  }, [fetchOrders]);

  // --- Normalisasi dan Formatting ---
  const normalizeStatus = (status: string) => status?.toLowerCase() || '';
  const formatStatusText = (status: string) => {
    const s = normalizeStatus(status);
    if (s === 'filled') return 'Matched';
    if (s === 'open' || s === 'accepted' || s === 'amended' || s === 'partially_filled') return 'Pending';
    if (s === 'cancelled') return 'Cancelled';
    if (s === 'rejected') return 'Rejected';
    return s.toUpperCase();
  };

  const getStatusColor = (status: string) => {
    const s = formatStatusText(status);
    if (s === 'Matched') return { bg: 'rgba(16, 185, 129, 0.1)', text: '#10B981', border: 'rgba(16, 185, 129, 0.3)' };
    if (s === 'Pending') return { bg: 'rgba(245, 158, 11, 0.1)', text: '#F59E0B', border: 'rgba(245, 158, 11, 0.3)' };
    if (s === 'Cancelled') return { bg: 'rgba(139, 92, 246, 0.1)', text: '#8B949E', border: 'rgba(139, 92, 246, 0.3)' };
    return { bg: 'rgba(239, 68, 68, 0.1)', text: '#EF4444', border: 'rgba(239, 68, 68, 0.3)' }; // Rejected
  };

  // --- Calculations for Summary Cards ---
  const summaryMetrics = useMemo(() => {
    let total = 0;
    let matched = 0;
    let pending = 0;
    let cancelledOrRejected = 0;

    orders.forEach(o => {
      total++;
      const s = formatStatusText(o.status || '');
      if (s === 'Matched') matched++;
      else if (s === 'Pending') pending++;
      else cancelledOrRejected++;
    });

    return { total, matched, pending, cancelledOrRejected };
  }, [orders]);

  // --- Filtered Orders ---
  const filteredOrders = useMemo(() => {
    return orders.filter(o => {
      // 1. Search filter
      const matchesSearch = o.symbol?.toLowerCase().includes(searchTerm.toLowerCase());
      if (!matchesSearch) return false;

      // 2. Status filter
      if (statusFilter === 'ALL') return true;
      if (statusFilter === 'BUY') return o.side === 'buy';
      if (statusFilter === 'SELL') return o.side === 'sell';
      
      const s = formatStatusText(o.status || '');
      if (statusFilter === 'MATCHED') return s === 'Matched';
      if (statusFilter === 'PENDING') return s === 'Pending';
      if (statusFilter === 'CANCELLED_REJECTED') return s === 'Cancelled' || s === 'Rejected';

      return true;
    });
  }, [orders, searchTerm, statusFilter]);

  // --- Amend Order Handler ---
  const openAmendModal = (order: Order) => {
    setSelectedOrderForAmend(order);
    setAmendPrice(order.price || 0);
    setAmendQty((order.original_quantity || 0) / LOT_SIZE);
    setAmendModalOpen(true);
  };

  const executeAmend = async () => {
    if (!selectedOrderForAmend?.id) return;
    const finalQty = amendQty * LOT_SIZE;

    if (!Number.isInteger(amendPrice) || amendPrice <= 0) {
      showToast('Harga limit harus berupa bilangan bulat positif', 'error');
      return;
    }
    if (!Number.isInteger(amendQty) || amendQty <= 0) {
      showToast('Kuantitas Lot harus bernilai positif', 'error');
      return;
    }

    try {
      await amendOrder(selectedOrderForAmend.id, { 
        price: amendPrice, 
        quantity: finalQty 
      });
      showToast(`Order ${selectedOrderForAmend.symbol} berhasil diubah!`, 'success');
      setAmendModalOpen(false);
      fetchOrders();
      fetchPortfolio();
    } catch (err: any) {
      showToast(`Gagal mengubah order: ${err.message}`, 'error');
    }
  };

  // --- Cancel Order Handler ---
  const openCancelModal = (order: Order) => {
    setSelectedOrderForCancel(order);
    setCancelModalOpen(true);
  };

  const executeCancel = async () => {
    if (!selectedOrderForCancel?.id) return;
    try {
      await cancelOrder(selectedOrderForCancel.id);
      showToast(`Order ${selectedOrderForCancel.symbol} berhasil dibatalkan!`, 'success');
      setCancelModalOpen(false);
      fetchOrders();
      fetchPortfolio();
    } catch (err: any) {
      showToast(`Gagal membatalkan order: ${err.message}`, 'error');
    }
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
            fontWeight: 600,
            transition: 'all 0.3s ease'
          }}
        >
          {toast.type === 'success' ? <CheckCircle2 size={18} /> : <AlertCircle size={18} />}
          <span>{toast.message}</span>
        </div>
      )}

      {/* HEADER SECTION */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-1" style={{ margin: 0 }}>
            Aktivitas Order
          </h2>
          <p className="text-xs text-[#8B949E]" style={{ margin: 0 }}>
            Kelola dan pantau seluruh transaksi pembelian serta penjualan saham Anda secara real-time.
          </p>
        </div>
        <button 
          onClick={() => { fetchOrders(); fetchPortfolio(); showToast('Data diperbarui', 'success'); }}
          className="bg-[#161B22] hover:bg-[#21262D] text-xs text-slate-300 font-semibold px-4 py-2 rounded-lg border border-[#21262D] transition flex items-center gap-2"
        >
          <Clock size={14} />
          Segarkan Data
        </button>
      </div>

      {/* METRICS SUMMARY CARDS */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Metric 1: Total Orders */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#0F2C59]"></div>
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Total Order</span>
            <span className="text-2xl font-bold text-white font-mono">{summaryMetrics.total}</span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#0F2C59]/20 border border-[#0F2C59]/30 flex items-center justify-center text-[#8B949E]">
            <Clock size={18} />
          </div>
        </div>

        {/* Metric 2: Matched Orders */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#10B981]"></div>
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Matched (Terisi)</span>
            <span className="text-2xl font-bold text-[#10B981] font-mono">{summaryMetrics.matched}</span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#10B981]/15 border border-[#10B981]/20 flex items-center justify-center text-[#10B981]">
            <TrendingUp size={18} />
          </div>
        </div>

        {/* Metric 3: Pending Orders */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#F59E0B]"></div>
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Pending (Antrean)</span>
            <span className="text-2xl font-bold text-[#F59E0B] font-mono">{summaryMetrics.pending}</span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#F59E0B]/15 border border-[#F59E0B]/20 flex items-center justify-center text-[#F59E0B]">
            <Info size={18} />
          </div>
        </div>

        {/* Metric 4: Cancelled & Rejected */}
        <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-4 flex items-center justify-between shadow-lg relative overflow-hidden">
          <div className="absolute top-0 left-0 w-1 h-full bg-[#EF4444]"></div>
          <div>
            <span className="text-[10px] uppercase font-bold tracking-wider text-[#8B949E] block mb-1">Batal / Ditolak</span>
            <span className="text-2xl font-bold text-[#EF4444] font-mono">{summaryMetrics.cancelledOrRejected}</span>
          </div>
          <div className="w-9 h-9 rounded-lg bg-[#EF4444]/15 border border-[#EF4444]/20 flex items-center justify-center text-[#EF4444]">
            <TrendingDown size={18} />
          </div>
        </div>
      </div>

      {/* FILTER BAR & SEARCH SECTION */}
      <div className="bg-[#161B22] border border-[#21262D] rounded-xl p-4 space-y-4 shadow-lg">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem' }}>
          
          {/* Status Tabs Filter */}
          <div style={{ display: 'flex', gap: '0.35rem', overflowX: 'auto', paddingBottom: '2px', flexWrap: 'wrap' }}>
            {[
              { key: 'ALL', label: 'Semua' },
              { key: 'BUY', label: 'Beli (BUY)' },
              { key: 'SELL', label: 'Jual (SELL)' },
              { key: 'MATCHED', label: 'Matched' },
              { key: 'PENDING', label: 'Pending' },
              { key: 'CANCELLED_REJECTED', label: 'Batal/Gagal' }
            ].map(tab => (
              <button
                key={tab.key}
                onClick={() => setStatusFilter(tab.key as any)}
                className="text-xs px-3.5 py-2 rounded-lg font-semibold transition"
                style={{
                  backgroundColor: statusFilter === tab.key ? '#0F2C59' : '#0D1117',
                  color: statusFilter === tab.key ? '#FFFFFF' : '#8B949E',
                  border: `1px solid ${statusFilter === tab.key ? 'rgba(15, 44, 89, 0.6)' : '#21262D'}`,
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative" style={{ minWidth: '240px', flex: '1 1 auto', maxWidth: '360px' }}>
            <span className="absolute inset-y-0 left-0 pl-3 flex items-center text-[#8B949E]">
              <Search size={14} />
            </span>
            <input 
              type="text"
              placeholder="Cari kode saham (misal: MNDL)..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg pl-9 pr-4 py-2 text-xs text-white placeholder-[#8B949E] focus:outline-none focus:border-[#E62225] transition"
            />
            {searchTerm && (
              <button 
                onClick={() => setSearchTerm('')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-[#8B949E] hover:text-white"
                style={{ background: 'transparent', border: 'none' }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        {/* MAIN ORDER LIST TABLE */}
        <div className="table-wrapper" style={{ margin: 0 }}>
          <table className="min-w-full" style={{ borderCollapse: 'separate', borderSpacing: '0 4px' }}>
            <thead>
              <tr style={{ backgroundColor: '#0D1117' }}>
                <th className="rounded-l-lg" style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Waktu</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Saham</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Tipe</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Aksi</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Harga</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Kuantitas</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Total Nilai</th>
                <th style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Status</th>
                <th className="rounded-r-lg text-right" style={{ padding: '0.75rem 1rem', borderBottom: 'none' }}>Tindakan</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#21262D]/20">
              {filteredOrders.length > 0 ? (
                filteredOrders.map((order) => {
                  const isBuy = order.side === 'buy';
                  const totalVal = (order.price || 0) * (order.original_quantity || 0);
                  const formattedTime = order.created_at ? new Date(order.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-';
                  const formattedDate = order.created_at ? new Date(order.created_at).toLocaleDateString('id-ID', { day: '2-digit', month: 'short' }) : '';
                  const statusColors = getStatusColor(order.status || '');
                  const currentStatus = order.status || 'open';
                  const orderType = order.order_type || 'limit';

                  const canCancel = ['accepted', 'open', 'amended', 'partially_filled'].includes(currentStatus);
                  const canAmend = orderType !== 'market' && ['accepted', 'open', 'amended', 'partially_filled'].includes(currentStatus);

                  return (
                    <tr 
                      key={order.id} 
                      className="hover:bg-[#1f2630]/40 transition-colors"
                      style={{ backgroundColor: 'rgba(13, 17, 23, 0.3)' }}
                    >
                      {/* Waktu */}
                      <td className="font-mono text-[11px] text-[#8B949E]" style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <span className="block text-white font-semibold">{formattedTime}</span>
                        <span className="text-[10px]">{formattedDate}</span>
                      </td>

                      {/* Saham */}
                      <td style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <span className="text-sm font-bold text-white block">{order.symbol}</span>
                      </td>

                      {/* Tipe Order */}
                      <td style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <span className="text-[11px] font-semibold text-[#8B949E] uppercase px-2 py-0.5 rounded bg-[#161B22] border border-[#21262D] font-mono">
                          {orderType}
                        </span>
                      </td>

                      {/* Aksi */}
                      <td style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <span 
                          className="text-[11px] font-bold px-2 py-0.5 rounded font-mono"
                          style={{
                            backgroundColor: isBuy ? 'rgba(16, 185, 129, 0.12)' : 'rgba(239, 68, 68, 0.12)',
                            color: isBuy ? '#10B981' : '#EF4444'
                          }}
                        >
                          {order.side?.toUpperCase()}
                        </span>
                      </td>

                      {/* Harga */}
                      <td className="font-mono text-xs text-white font-semibold" style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        {orderType === 'market' ? 'Market Price' : `Rp ${(order.price || 0).toLocaleString('id-ID')}`}
                      </td>

                      {/* Kuantitas (Lot & Shares) */}
                      <td className="font-mono text-xs text-slate-200" style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <span className="block font-bold text-white">{(order.original_quantity || 0) / LOT_SIZE} Lot</span>
                        <span className="text-[10px] text-[#8B949E]">{(order.original_quantity || 0).toLocaleString('id-ID')} Lembar</span>
                      </td>

                      {/* Total Nilai */}
                      <td className="font-mono text-xs text-white font-semibold" style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        Rp {totalVal.toLocaleString('id-ID')}
                      </td>

                      {/* Status */}
                      <td style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <div style={{ display: 'inline-flex', flexDirection: 'column' }}>
                          <span 
                            className="px-2.5 py-0.5 rounded text-[10px] font-bold text-center font-mono border"
                            style={{
                              backgroundColor: statusColors.bg,
                              color: statusColors.text,
                              borderColor: statusColors.border
                            }}
                          >
                            {formatStatusText(order.status || '')}
                          </span>
                          {order.reject_reason && (
                            <span className="text-[9px] text-[#EF4444] mt-1 max-w-[130px] leading-tight block">
                              {order.reject_reason}
                            </span>
                          )}
                        </div>
                      </td>

                      {/* Tindakan */}
                      <td className="text-right" style={{ padding: '1rem', borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D' }}>
                        <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'flex-end' }}>
                          {canAmend && (
                            <button
                              onClick={() => openAmendModal(order)}
                              disabled={orderActionLoading}
                              className="p-2 rounded bg-amber-500/10 border border-amber-500/20 text-amber-500 hover:bg-amber-500 hover:text-[#0D1117] transition-all duration-200"
                              title="Ubah Order"
                            >
                              <Edit3 size={13} />
                            </button>
                          )}
                          {canCancel && (
                            <button
                              onClick={() => openCancelModal(order)}
                              disabled={orderActionLoading}
                              className="p-2 rounded bg-red-500/10 border border-red-500/20 text-red-500 hover:bg-red-500 hover:text-white transition-all duration-200"
                              title="Batalkan Order"
                            >
                              <Trash2 size={13} />
                            </button>
                          )}
                          {!canAmend && !canCancel && (
                            <span className="text-[10px] text-[#8B949E] pr-2 font-mono">-</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })
              ) : (
                <tr>
                  <td colSpan={9} className="py-12 text-center text-[#8B949E] text-xs">
                    <Info size={24} className="mx-auto text-[#8B949E] mb-2 opacity-50" />
                    Tidak ada aktivitas order yang cocok dengan kriteria filter saat ini.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ==========================================
          MODALS AREA (AMEND & CANCEL DIALOGS)
          ========================================== */}

      {/* Modal 1: AMEND ORDER */}
      {amendModalOpen && selectedOrderForAmend && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#161B22] border border-[#21262D] rounded-2xl w-full max-w-md p-6 relative shadow-2xl animate-scale-up">
            
            {/* Top indicator line */}
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-gradient-to-r from-amber-500 to-[#0F2C59] rounded-t-2xl"></div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.25rem' }}>
              <h3 className="text-base font-bold text-white flex items-center gap-2" style={{ margin: 0 }}>
                <Edit3 size={18} className="text-amber-500" />
                Ubah Antrean Order ({selectedOrderForAmend.symbol})
              </h3>
              <button 
                onClick={() => setAmendModalOpen(false)}
                className="text-[#8B949E] hover:text-white p-1 rounded-lg hover:bg-[#21262D]"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs text-[#8B949E] mb-4">
              Ubah harga atau kuantitas order Anda yang sedang mengantre di bursa.
            </p>

            <div className="space-y-4">
              {/* Info panel */}
              <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D] grid grid-cols-2 gap-2 text-xs font-mono">
                <div>
                  <span className="text-[#8B949E] block text-[10px]">TIPE ORDER</span>
                  <span className="text-white font-bold">{selectedOrderForAmend.side?.toUpperCase()} {(selectedOrderForAmend.order_type || 'limit').toUpperCase()}</span>
                </div>
                <div>
                  <span className="text-[#8B949E] block text-[10px]">KUANTITAS LAMA</span>
                  <span className="text-white font-bold">{(selectedOrderForAmend.original_quantity || 0) / LOT_SIZE} Lot ({(selectedOrderForAmend.original_quantity || 0).toLocaleString('id-ID')} Lembar)</span>
                </div>
                <div className="col-span-2 pt-2 border-t border-[#21262D]/60">
                  <span className="text-[#8B949E] block text-[10px]">HARGA LAMA</span>
                  <span className="text-white font-bold">Rp {(selectedOrderForAmend.price || 0).toLocaleString('id-ID')}</span>
                </div>
              </div>

              {/* Amend Inputs */}
              <div className="space-y-3">
                <div>
                  <label className="text-xs text-[#8B949E] font-bold block mb-1">HARGA BARU (Rp)</label>
                  <input 
                    type="number" 
                    value={amendPrice}
                    onChange={(e) => setAmendPrice(Math.max(0, parseInt(e.target.value) || 0))}
                    className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-amber-500 font-mono font-bold"
                  />
                </div>

                <div>
                  <label className="text-xs text-[#8B949E] font-bold block mb-1">KUANTITAS BARU (LOT)</label>
                  <div className="flex gap-2">
                    <input 
                      type="number" 
                      value={amendQty}
                      onChange={(e) => setAmendQty(Math.max(1, parseInt(e.target.value) || 1))}
                      className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-amber-500 font-mono font-bold"
                    />
                    <span className="flex items-center text-[10px] text-[#8B949E] bg-[#0D1117] px-3 rounded-lg border border-[#21262D] font-mono shrink-0">
                      = {(amendQty * LOT_SIZE).toLocaleString('id-ID')} Lbr
                    </span>
                  </div>
                </div>
              </div>

              {/* Estimation */}
              <div className="bg-amber-500/5 border border-amber-500/10 rounded-lg p-3 text-[11px] flex justify-between items-center font-mono">
                <span className="text-[#8B949E]">Estimasi Total Baru:</span>
                <span className="text-white font-bold text-sm">Rp {(amendPrice * amendQty * LOT_SIZE).toLocaleString('id-ID')}</span>
              </div>

              {/* Buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  onClick={() => setAmendModalOpen(false)}
                  className="w-full bg-[#0D1117] hover:bg-[#21262D] border border-[#21262D] text-xs text-[#8B949E] font-bold py-2.5 rounded-lg transition"
                >
                  Batal
                </button>
                <button
                  onClick={executeAmend}
                  disabled={orderActionLoading}
                  className="w-full bg-amber-500 hover:brightness-110 text-xs text-[#0D1117] font-bold py-2.5 rounded-lg transition-all"
                >
                  {orderActionLoading ? 'Memproses...' : 'Kirim Perubahan'}
                </button>
              </div>

            </div>
          </div>
        </div>
      )}

      {/* Modal 2: CANCEL ORDER */}
      {cancelModalOpen && selectedOrderForCancel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#161B22] border border-[#21262D] rounded-2xl w-full max-w-sm p-6 relative shadow-2xl animate-scale-up">
            
            {/* Top red warning line */}
            <div className="absolute top-0 left-0 right-0 h-1.5 bg-[#EF4444] rounded-t-2xl"></div>

            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 className="text-base font-bold text-white flex items-center gap-2" style={{ margin: 0 }}>
                <AlertCircle size={18} className="text-[#EF4444]" />
                Konfirmasi Batal Order
              </h3>
              <button 
                onClick={() => setCancelModalOpen(false)}
                className="text-[#8B949E] hover:text-white p-1 rounded-lg hover:bg-[#21262D]"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
              >
                <X size={18} />
              </button>
            </div>

            <div className="space-y-4">
              <p className="text-xs text-[#8B949E]">
                Apakah Anda yakin ingin membatalkan pesanan berikut dari antrean bursa?
              </p>

              <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D] text-xs font-mono space-y-1.5">
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">SAHAM:</span>
                  <span className="text-white font-bold">{selectedOrderForCancel.symbol}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">AKSI:</span>
                  <span className={selectedOrderForCancel.side === 'buy' ? 'text-[#10B981] font-bold' : 'text-[#EF4444] font-bold'}>
                    {selectedOrderForCancel.side?.toUpperCase()}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">HARGA:</span>
                  <span className="text-white font-bold">Rp {(selectedOrderForCancel.price || 0).toLocaleString('id-ID')}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">KUANTITAS:</span>
                  <span className="text-white font-bold">{(selectedOrderForCancel.original_quantity || 0) / LOT_SIZE} Lot ({(selectedOrderForCancel.original_quantity || 0).toLocaleString('id-ID')} Lbr)</span>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  onClick={() => setCancelModalOpen(false)}
                  className="w-full bg-[#0D1117] hover:bg-[#21262D] border border-[#21262D] text-xs text-[#8B949E] font-bold py-2.5 rounded-lg transition"
                >
                  Tutup
                </button>
                <button
                  onClick={executeCancel}
                  disabled={orderActionLoading}
                  className="w-full bg-[#EF4444] hover:bg-red-600 text-xs text-white font-bold py-2.5 rounded-lg transition"
                >
                  {orderActionLoading ? 'Membatalkan...' : 'Batal Order'}
                </button>
              </div>
            </div>

          </div>
        </div>
      )}

    </div>
  );
}
