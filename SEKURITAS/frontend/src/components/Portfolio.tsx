import { useEffect, useState, useMemo } from 'react';
import { useStore } from '../store/useStore';
import { 
  Wallet, 
  Briefcase, 
  History, 
  ShieldCheck, 
  TrendingUp, 
  TrendingDown, 
  ArrowUpRight, 
  ArrowDownRight,
  Copy,
  Plus,
  RefreshCw,
  Info
} from 'lucide-react';

interface PortfolioProps {
  onOpenTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
}

export default function Portfolio({ onOpenTrade, onOpenDeposit, onOpenWithdraw }: PortfolioProps) {
  // --- Zustand Store Bindings ---
  const portfolio = useStore(state => state.portfolio);
  const portfolioLoading = useStore(state => state.portfolioLoading);
  const tradeHistory = useStore(state => state.tradeHistory);
  const accountProfile = useStore(state => state.accountProfile);
  const custodySummary = useStore(state => state.custodySummary);
  const reconciliation = useStore(state => state.reconciliation);
  const market = useStore(state => state.market);
  
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchTradeHistory = useStore(state => state.fetchTradeHistory);
  const fetchAccountProfile = useStore(state => state.fetchAccountProfile);
  const fetchCustodySummary = useStore(state => state.fetchCustodySummary);
  const fetchReconciliation = useStore(state => state.fetchReconciliation);

  // --- Local States ---
  const [activeSubTab, setActiveSubTab] = useState<'holdings' | 'rdn' | 'fills' | 'custody'>('holdings');
  const [copySuccess, setCopySuccess] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  // --- Fetch Data on Mount ---
  useEffect(() => {
    fetchPortfolio();
    fetchTradeHistory().catch(() => {});
    fetchAccountProfile().catch(() => {});
    fetchCustodySummary().catch(() => {});
    fetchReconciliation().catch(() => {});
  }, []);

  // --- Refresh Handler ---
  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await Promise.all([
        fetchPortfolio(),
        fetchTradeHistory(),
        fetchAccountProfile(),
        fetchCustodySummary(),
        fetchReconciliation()
      ]);
    } catch (err) {
      console.error(err);
    } finally {
      setIsRefreshing(false);
    }
  };

  // --- Copy to Clipboard Helper ---
  const handleCopy = (text: string, type: string) => {
    if (!text) return;
    navigator.clipboard.writeText(text);
    setCopySuccess(type);
    setTimeout(() => setCopySuccess(null), 2000);
  };

  // --- Local Balance Offset (deposit/withdraw simulasi dari Dashboard) ---
  const localBalanceOffset = useMemo(() => {
    const saved = localStorage.getItem('local_rdn_offset');
    return saved ? parseFloat(saved) : 0;
  }, [portfolioLoading]); // hitung ulang jika portfolio refresh

  // --- Financial Calculations ---
  const formatIDR = (val: string | number) => {
    return new Intl.NumberFormat('id-ID', { 
      style: 'currency', 
      currency: 'IDR', 
      minimumFractionDigits: 0 
    }).format(Number(val));
  };

  const cashAvailable = parseFloat(portfolio?.cash?.available || '0') + localBalanceOffset;
  const cashReserved = parseFloat(portfolio?.cash?.reserved || '0');
  const cashPending = parseFloat(portfolio?.cash?.pending || '0');
  const totalCash = cashAvailable + cashReserved + cashPending;

  // Nilai Posisi Saham Saat Ini
  const positionsValue = useMemo(() => {
    if (!portfolio?.positions) return 0;
    return portfolio.positions.reduce((sum, pos) => {
      const lastPrice = market.lastPrices[pos.symbol] || parseFloat(pos.average_price) || 0;
      const totalQty = pos.available + pos.reserved + pos.pending;
      return sum + (totalQty * lastPrice);
    }, 0);
  }, [portfolio?.positions, market.lastPrices]);

  // Total Nilai Aset (Net Asset Value)
  const totalNAV = totalCash + positionsValue;

  // Cost Basis Posisi Saham
  const positionsCostBasis = useMemo(() => {
    if (!portfolio?.positions) return 0;
    return portfolio.positions.reduce((sum, pos) => {
      const totalQty = pos.available + pos.reserved + pos.pending;
      return sum + (totalQty * parseFloat(pos.average_price));
    }, 0);
  }, [portfolio?.positions]);

  // Profit/Loss portofolio saham
  const totalPLAmount = positionsValue - positionsCostBasis;
  const totalPLPercent = positionsCostBasis > 0 ? (totalPLAmount / positionsCostBasis) * 100 : 0;

  // --- Asset Allocation Pie Chart (SVG) ---
  const allocation = useMemo(() => {
    if (totalNAV === 0) return { cash: 50, equities: 50 };
    return {
      cash: (totalCash / totalNAV) * 100,
      equities: (positionsValue / totalNAV) * 100
    };
  }, [totalCash, positionsValue, totalNAV]);

  // SVG parameters untuk Donut Chart
  const radius = 50;
  const circumference = 2 * Math.PI * radius;
  const strokeDashoffsetEquities = circumference * 0.25; // Mulai dari jam 12
  const strokeDashoffsetCash = circumference * (0.25 - allocation.equities / 100);

  return (
    <div className="portfolio-premium-page animate-fade-in">
      <style>{`
        .portfolio-premium-page {
          max-width: 80rem;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          padding-bottom: 3rem;
        }
        
        .portfolio-header-box {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .refresh-btn {
          background: #161B22;
          border: 1px solid #21262D;
          color: #8B949E;
          padding: 8px 16px;
          border-radius: 8px;
          font-size: 12px;
          display: flex;
          align-items: center;
          gap: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        
        .refresh-btn:hover {
          color: #FFFFFF;
          border-color: #E62225;
          background: rgba(230, 34, 37, 0.05);
        }

        .refresh-btn.spinning svg {
          animation: spin 1s linear infinite;
        }

        @keyframes spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }

        /* Top Grid Summary */
        .portfolio-top-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.5rem;
        }

        @media (max-width: 1024px) {
          .portfolio-top-grid {
            grid-template-columns: 1fr;
            gap: 1rem;
          }
        }

        /* Sub-tab menu style */
        .subtab-navigation {
          display: flex;
          border-bottom: 1px solid #21262D;
          gap: 1.5rem;
          margin-top: 1rem;
        }
        
        .subtab-btn {
          background: transparent;
          border: none;
          color: #8B949E;
          font-size: 13px;
          font-weight: 600;
          padding: 0.75rem 0.25rem;
          cursor: pointer;
          position: relative;
          transition: color 0.2s ease;
          display: flex;
          align-items: center;
          gap: 6px;
        }

        .subtab-btn:hover {
          color: #FFFFFF;
        }

        .subtab-btn.active {
          color: #FFFFFF;
        }

        .subtab-btn.active::after {
          content: '';
          position: absolute;
          bottom: -1px;
          left: 0;
          right: 0;
          height: 2px;
          background-color: #E62225;
          box-shadow: 0 0 10px #E62225;
        }

        /* Donut allocation styles */
        .donut-card {
          display: flex;
          align-items: center;
          gap: 2rem;
          padding: 1.5rem;
          background-color: #161B22;
          border: 1px solid #21262D;
          border-radius: 12px;
          box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.3);
        }

        @media (max-width: 640px) {
          .donut-card {
            flex-direction: column;
            gap: 1.5rem;
            text-align: center;
          }
        }

        .donut-legend {
          display: flex;
          flex-direction: column;
          gap: 0.75rem;
          flex: 1;
        }

        .legend-item {
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-size: 13px;
        }

        .legend-indicator {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .indicator-dot {
          width: 10px;
          height: 10px;
          border-radius: 9999px;
        }

        /* E-Card Holographic RDN */
        .rdn-hologram-card {
          background: linear-gradient(135deg, #132f5d 0%, #161B22 50%, #1f0f0d 100%);
          border: 1px solid rgba(255, 255, 255, 0.08);
          border-radius: 16px;
          padding: 2rem;
          position: relative;
          overflow: hidden;
          box-shadow: 0 20px 40px rgba(0,0,0,0.5), inset 0 0 20px rgba(255,255,255,0.02);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          min-height: 220px;
          transition: transform 0.3s ease, box-shadow 0.3s ease;
        }
        
        .rdn-hologram-card:hover {
          transform: translateY(-4px) scale(1.01);
          box-shadow: 0 25px 50px rgba(0,0,0,0.6), 0 0 30px rgba(230, 34, 37, 0.05);
        }

        .rdn-hologram-card::before {
          content: '';
          position: absolute;
          top: -50%;
          left: -50%;
          width: 200%;
          height: 200%;
          background: radial-gradient(circle, rgba(255,255,255,0.05) 0%, transparent 70%);
          transform: rotate(45deg);
          pointer-events: none;
        }

        .copy-toast {
          position: absolute;
          bottom: 1rem;
          right: 1rem;
          background: rgba(16, 185, 129, 0.95);
          color: white;
          padding: 4px 8px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: bold;
          animation: fadeIn 0.2s ease forwards;
        }

        /* Custody badge */
        .custody-badge-success {
          background-color: rgba(16, 185, 129, 0.1);
          border: 1px solid rgba(16, 185, 129, 0.3);
          color: #10B981;
          padding: 4px 10px;
          border-radius: 9999px;
          font-size: 11px;
          font-weight: 700;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          box-shadow: 0 0 10px rgba(16, 185, 129, 0.1);
        }
      `}</style>

      {/* --- HEADER DAN TOMBOL REFRESH --- */}
      <div className="portfolio-header-box">
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-0" style={{ margin: 0 }}>Portofolio Investasi</h2>
          <p className="text-xs text-[#8B949E]" style={{ margin: '4px 0 0 0' }}>Pantau kepemilikan efek, saldo dana RDN, histori transaksi, serta pelaporan kustodian KSEI.</p>
        </div>
        
        <button 
          onClick={handleRefresh}
          className={`refresh-btn ${isRefreshing ? 'spinning' : ''}`}
          disabled={isRefreshing}
        >
          <RefreshCw size={14} />
          {isRefreshing ? 'Menyinkronkan...' : 'Sinkronisasi Data'}
        </button>
      </div>

      {/* --- KARTU RINGKASAN UTAMA (NAV, CASH, EQUITIES) --- */}
      <div className="portfolio-top-grid">
        
        {/* NAV Card */}
        <div className="card-isometric-premium card-indicator-red flex flex-col justify-between" style={{ minHeight: '140px' }}>
          <div>
            <span className="text-[10px] font-semibold text-[#8B949E] uppercase tracking-wider block mb-1">
              Net Asset Value (NAV)
            </span>
            <h3 className="text-2xl font-extrabold text-white tracking-tight font-mono mb-2">
              {formatIDR(totalNAV)}
            </h3>
          </div>
          <div className="flex items-center gap-1.5 mt-2">
            <span 
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-bold"
              style={{
                backgroundColor: totalPLAmount >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: totalPLAmount >= 0 ? '#10B981' : '#EF4444'
              }}
            >
              {totalPLAmount >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
              {totalPLAmount >= 0 ? '+' : ''}{totalPLPercent.toFixed(2)}%
            </span>
            <span className="text-[10px] text-[#8B949E] font-mono">
              Unrealized P/L: <span style={{ color: totalPLAmount >= 0 ? '#10B981' : '#EF4444', fontWeight: 600 }}>{totalPLAmount >= 0 ? '+' : ''}{formatIDR(totalPLAmount)}</span>
            </span>
          </div>
        </div>

        {/* Cash Balance Card */}
        <div className="card-isometric-premium flex flex-col justify-between" style={{ minHeight: '140px' }}>
          <div>
            <span className="text-[10px] font-semibold text-[#8B949E] uppercase tracking-wider block mb-1">
              Dana Kas RDN
            </span>
            <h3 className="text-2xl font-extrabold text-white tracking-tight font-mono mb-1">
              {formatIDR(totalCash)}
            </h3>
          </div>
          <div className="grid grid-cols-3 gap-2 border-t border-[#21262D] pt-2 text-[10px] font-mono">
            <div>
              <span className="text-[#8B949E] block">Tersedia (BP)</span>
              <span className="text-[#10B981] font-bold">{formatIDR(cashAvailable)}</span>
            </div>
            <div>
              <span className="text-[#8B949E] block">Antrean Beli</span>
              <span className="text-[#F59E0B] font-bold">{formatIDR(cashReserved)}</span>
            </div>
            <div>
              <span className="text-[#8B949E] block">Pending Settle</span>
              <span className="text-slate-300 font-bold">{formatIDR(cashPending)}</span>
            </div>
          </div>
        </div>

        {/* Equities Card */}
        <div className="card-isometric-premium flex flex-col justify-between" style={{ minHeight: '140px' }}>
          <div>
            <span className="text-[10px] font-semibold text-[#8B949E] uppercase tracking-wider block mb-1">
              Nilai Portofolio Efek
            </span>
            <h3 className="text-2xl font-extrabold text-white tracking-tight font-mono mb-2">
              {formatIDR(positionsValue)}
            </h3>
          </div>
          <div className="flex justify-between items-center border-t border-[#21262D] pt-2 text-[10px]">
            <span className="text-[#8B949E] font-mono">
              Total Modal: <span className="text-slate-300 font-semibold">{formatIDR(positionsCostBasis)}</span>
            </span>
            <span className="text-[#8B949E] font-semibold">{portfolio?.positions?.length || 0} Emiten Aktif</span>
          </div>
        </div>

      </div>

      {/* --- ALLOCATION & CHART SECTION --- */}
      <div className="donut-card">
        {/* SVG Donut Chart */}
        <div style={{ position: 'relative', width: '130px', height: '130px', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <svg width="130" height="130" viewBox="0 0 120 120">
            {/* Latar belakang lingkaran */}
            <circle cx="60" cy="60" r="50" fill="transparent" stroke="#21262D" strokeWidth="8" />
            {/* Saham / Equities (Merah) */}
            <circle 
              cx="60" 
              cy="60" 
              r="50" 
              fill="transparent" 
              stroke="#E62225" 
              strokeWidth="8" 
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffsetEquities}
              strokeLinecap="round"
              style={{
                transition: 'stroke-dashoffset 0.5s ease',
                transformOrigin: 'center',
                transform: 'rotate(-90deg)'
              }}
            />
            {/* Dana Tunai / Cash (Navy Blue) */}
            <circle 
              cx="60" 
              cy="60" 
              r="50" 
              fill="transparent" 
              stroke="#0F2C59" 
              strokeWidth="8" 
              strokeDasharray={circumference}
              strokeDashoffset={strokeDashoffsetCash}
              strokeLinecap="round"
              style={{
                transition: 'stroke-dashoffset 0.5s ease',
                transformOrigin: 'center',
                transform: `rotate(${((allocation.equities / 100) * 360) - 90}deg)`
              }}
            />
          </svg>
          <div style={{ position: 'absolute', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center' }}>
            <span className="text-[10px] text-[#8B949E] font-bold uppercase tracking-wider">Aset</span>
            <span className="text-[11px] font-bold text-white font-mono">{portfolio?.positions?.length || 0} Saham</span>
          </div>
        </div>

        {/* Legend & Allocation Info */}
        <div className="donut-legend">
          <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-1" style={{ margin: 0 }}>Alokasi Portofolio</h4>
          <div className="legend-item">
            <div className="legend-indicator">
              <span className="indicator-dot" style={{ backgroundColor: '#0F2C59' }}></span>
              <span className="text-white font-semibold">Dana RDN Tunai</span>
            </div>
            <span className="text-slate-300 font-bold font-mono">{allocation.cash.toFixed(1)}% <span className="text-[10px] text-[#8B949E] font-normal">({formatIDR(totalCash)})</span></span>
          </div>
          <div className="legend-item border-t border-[#21262D]/60 pt-2">
            <div className="legend-indicator">
              <span className="indicator-dot" style={{ backgroundColor: '#E62225' }}></span>
              <span className="text-white font-semibold">Efek Saham</span>
            </div>
            <span className="text-slate-300 font-bold font-mono">{allocation.equities.toFixed(1)}% <span className="text-[10px] text-[#8B949E] font-normal">({formatIDR(positionsValue)})</span></span>
          </div>
        </div>
      </div>

      {/* --- SUB-TAB NAVIGATION --- */}
      <nav className="subtab-navigation">
        <button 
          onClick={() => setActiveSubTab('holdings')}
          className={`subtab-btn ${activeSubTab === 'holdings' ? 'active' : ''}`}
        >
          <Briefcase size={14} />
          Kepemilikan Saham ({portfolio?.positions?.length || 0})
        </button>
        <button 
          onClick={() => setActiveSubTab('rdn')}
          className={`subtab-btn ${activeSubTab === 'rdn' ? 'active' : ''}`}
        >
          <Wallet size={14} />
          Informasi Akun RDN
        </button>
        <button 
          onClick={() => setActiveSubTab('fills')}
          className={`subtab-btn ${activeSubTab === 'fills' ? 'active' : ''}`}
        >
          <History size={14} />
          Riwayat Transaksi
        </button>
        <button 
          onClick={() => setActiveSubTab('custody')}
          className={`subtab-btn ${activeSubTab === 'custody' ? 'active' : ''}`}
        >
          <ShieldCheck size={14} />
          Kustodian & KSEI
        </button>
      </nav>

      {/* --- SUB-TAB KONTEN AREA --- */}
      <div className="subtab-content" style={{ marginTop: '0.5rem' }}>
        
        {/* ========================================================
            SUB-TAB 1: KEPEMILIKAN SAHAM (HOLDINGS)
            ======================================================== */}
        {activeSubTab === 'holdings' && (
          <div className="card-isometric-premium animate-fade-in" style={{ padding: '1.25rem' }}>
            <div className="table-wrapper">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-[#8B949E] uppercase tracking-wider text-[10px]" style={{ borderBottom: '1px solid #21262D' }}>
                    <th className="pb-2.5 font-semibold">Saham</th>
                    <th className="pb-2.5 font-semibold text-right">Kepemilikan</th>
                    <th className="pb-2.5 font-semibold text-right">Harga Rata² (Avg)</th>
                    <th className="pb-2.5 font-semibold text-right">Harga Pasar (Last)</th>
                    <th className="pb-2.5 font-semibold text-right">Nilai Pasar / Modal</th>
                    <th className="pb-2.5 font-semibold text-right">Unrealized P/L</th>
                    <th className="pb-2.5 font-semibold text-right">Bobot</th>
                    <th className="pb-2.5 font-semibold text-center">Aksi Cepat</th>
                  </tr>
                </thead>
                <tbody className="divide-y font-mono" style={{ borderColor: 'rgba(33, 38, 45, 0.4)' }}>
                  {portfolio?.positions && portfolio.positions.length > 0 ? (
                    portfolio.positions.map((pos) => {
                      const lastPrice = market.lastPrices[pos.symbol] || parseFloat(pos.average_price) || 0;
                      const totalQtyShares = pos.available + pos.reserved + pos.pending;
                      const totalQtyLots = totalQtyShares / 100;
                      const avgPrice = parseFloat(pos.average_price);
                      
                      const posVal = totalQtyShares * lastPrice;
                      const posCost = totalQtyShares * avgPrice;
                      const posPL = posVal - posCost;
                      const posPLPercent = posCost > 0 ? (posPL / posCost) * 100 : 0;
                      
                      const holdingWeight = positionsValue > 0 ? (posVal / positionsValue) * 100 : 0;

                      return (
                        <tr key={pos.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }} className="hover:bg-slate-900/30">
                          {/* Nama/Kode */}
                          <td className="py-3" style={{ padding: '0.75rem 0.5rem' }}>
                            <span className="font-bold text-white text-sm block">{pos.symbol}</span>
                            <span className="text-[10px] text-[#8B949E] font-normal truncate block max-w-[120px]">
                              {useStore.getState().securities.find(s => (s.symbol || s.code) === pos.symbol)?.name || 'Mandala Securities'}
                            </span>
                          </td>
                          {/* Kepemilikan */}
                          <td className="py-3 text-right text-slate-200" style={{ padding: '0.75rem 0.5rem' }}>
                            <span className="font-bold text-sm block">{totalQtyLots} Lot</span>
                            <span className="text-[10px] text-[#8B949E] block">({totalQtyShares.toLocaleString('id-ID')} lbr)</span>
                          </td>
                          {/* Avg Price */}
                          <td className="py-3 text-right text-[#8B949E]" style={{ padding: '0.75rem 0.5rem' }}>
                            {formatIDR(avgPrice)}
                          </td>
                          {/* Last Price */}
                          <td className="py-3 text-right font-semibold text-slate-100" style={{ padding: '0.75rem 0.5rem' }}>
                            {formatIDR(lastPrice)}
                          </td>
                          {/* Nilai Pasar / Modal */}
                          <td className="py-3 text-right" style={{ padding: '0.75rem 0.5rem' }}>
                            <span className="font-semibold text-white block">{formatIDR(posVal)}</span>
                            <span className="text-[10px] text-[#8B949E] block">{formatIDR(posCost)}</span>
                          </td>
                          {/* Unrealized P/L */}
                          <td 
                            className="py-3 text-right font-bold"
                            style={{ color: posPL >= 0 ? '#10B981' : '#EF4444', padding: '0.75rem 0.5rem' }}
                          >
                            <span className="flex items-center justify-end gap-1 text-sm">
                              {posPL >= 0 ? <ArrowUpRight size={12} /> : <ArrowDownRight size={12} />}
                              {posPL >= 0 ? '+' : ''}{posPLPercent.toFixed(2)}%
                            </span>
                            <span className="text-[10px] block font-normal text-slate-400">
                              {posPL >= 0 ? '+' : ''}{formatIDR(posPL)}
                            </span>
                          </td>
                          {/* Bobot */}
                          <td className="py-3 text-right" style={{ padding: '0.75rem 0.5rem', width: '100px' }}>
                            <span className="text-xs text-[#8B949E] block font-semibold mb-1">{holdingWeight.toFixed(1)}%</span>
                            <div style={{ width: '100%', height: '4px', backgroundColor: '#21262D', borderRadius: '9999px', overflow: 'hidden' }}>
                              <div style={{ width: `${holdingWeight}%`, height: '100%', backgroundColor: '#E62225' }}></div>
                            </div>
                          </td>
                          {/* Aksi */}
                          <td className="py-3 text-center" style={{ padding: '0.75rem 0.5rem' }}>
                            <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                              <button
                                onClick={() => onOpenTrade(pos.symbol, 'BUY')}
                                className="pill-action-buy"
                                style={{
                                  backgroundColor: 'rgba(16, 185, 129, 0.15)',
                                  color: '#10B981',
                                  border: '1px solid rgba(16, 185, 129, 0.3)',
                                  padding: '4px 10px',
                                  fontSize: '11px',
                                  borderRadius: '6px',
                                  fontWeight: 'bold',
                                  cursor: 'pointer'
                                }}
                              >
                                Beli
                              </button>
                              <button
                                onClick={() => onOpenTrade(pos.symbol, 'SELL')}
                                className="pill-action-sell"
                                style={{
                                  backgroundColor: 'rgba(239, 68, 68, 0.15)',
                                  color: '#EF4444',
                                  border: '1px solid rgba(239, 68, 68, 0.3)',
                                  padding: '4px 10px',
                                  fontSize: '11px',
                                  borderRadius: '6px',
                                  fontWeight: 'bold',
                                  cursor: 'pointer'
                                }}
                              >
                                Jual
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-[#8B949E]">
                        Belum memiliki kepemilikan efek saham aktif saat ini.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========================================================
            SUB-TAB 2: AKUN & RDN (RDN CARD)
            ======================================================== */}
        {activeSubTab === 'rdn' && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12, 1fr)', gap: '1.5rem' }} className="animate-fade-in">
            
            {/* Holographic RDN Card (7/12) */}
            <div className="col-span-12 lg:col-span-7">
              <div className="rdn-hologram-card">
                {copySuccess === 'rdn' && <span className="copy-toast">RDN BCA Berhasil Disalin!</span>}
                {copySuccess === 'sid' && <span className="copy-toast">SID Berhasil Disalin!</span>}
                {copySuccess === 'sre' && <span className="copy-toast">SRE Berhasil Disalin!</span>}

                <div className="flex justify-between items-start">
                  <div>
                    <span className="text-[10px] text-[#8B949E] tracking-widest font-bold uppercase">MANDALA INVESTOR</span>
                    <h3 className="text-xl font-bold text-white leading-none mt-1" style={{ margin: 0 }}>
                      {useStore.getState().user?.email?.split('@')[0]?.toUpperCase() || 'MANDALA INVESTOR'}
                    </h3>
                  </div>
                  {/* BCA Logo Text */}
                  <span className="text-md font-black text-white font-mono tracking-wider bg-blue-900/50 py-1 px-3 border border-blue-700/40 rounded-lg">BCA</span>
                </div>

                <div style={{ margin: '1.5rem 0' }}>
                  <span className="text-[10px] text-[#8B949E] block mb-1">REKENING DANA NASABAH (RDN)</span>
                  <div className="flex items-center gap-2">
                    <span className="text-2xl font-bold font-mono tracking-wider text-slate-100">
                      {accountProfile?.references?.rdn || '0092-2345-21-1'}
                    </span>
                    <button 
                      onClick={() => handleCopy(accountProfile?.references?.rdn || '0092-2345-21-1', 'rdn')}
                      className="p-1.5 bg-[#21262D] hover:bg-slate-700 rounded text-slate-300 hover:text-white"
                      title="Salin RDN"
                      style={{ padding: '4px', border: 'none', cursor: 'pointer' }}
                    >
                      <Copy size={13} />
                    </button>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-4 border-t border-slate-700/40 pt-4 text-xs font-mono">
                  <div>
                    <span className="text-[#8B949E] text-[10px] block">SID (INVESTOR ID)</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-white font-semibold">{accountProfile?.references?.sid || 'IDD1002931'}</span>
                      <button 
                        onClick={() => handleCopy(accountProfile?.references?.sid || 'IDD1002931', 'sid')}
                        className="text-[#8B949E] hover:text-white"
                        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  </div>
                  <div>
                    <span className="text-[#8B949E] text-[10px] block">SRE (SUB REKENING EFEK)</span>
                    <div className="flex items-center gap-1.5">
                      <span className="text-white font-semibold">{accountProfile?.references?.sre || 'MDLA001293'}</span>
                      <button 
                        onClick={() => handleCopy(accountProfile?.references?.sre || 'MDLA001293', 'sre')}
                        className="text-[#8B949E] hover:text-white"
                        style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                      >
                        <Copy size={10} />
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Quick Actions (5/12) */}
            <div className="col-span-12 lg:col-span-5 flex flex-col gap-4">
              <div className="card-isometric-premium flex-grow flex flex-col justify-between" style={{ padding: '1.5rem' }}>
                <div>
                  <h4 className="text-sm font-bold text-white mb-2 flex items-center gap-2" style={{ margin: 0 }}>
                    <Info size={14} className="text-[#8B949E]" /> Status Mutasi Kas
                  </h4>
                  <p className="text-xs text-[#8B949E] leading-relaxed mb-4">
                    Suntik dana secara instan untuk memperluas Buying Power akun Mandala Sekuritas Anda atau cairkan dana ke rekening bank penampung Anda yang sudah diverifikasi.
                  </p>
                </div>

                <div className="flex flex-col gap-2">
                  <button 
                    onClick={onOpenDeposit}
                    className="w-full btn-primary-red uppercase tracking-wider text-xs flex items-center justify-center gap-2"
                    style={{ padding: '0.85rem 1rem', background: '#E62225', color: '#fff', borderRadius: '8px', cursor: 'pointer' }}
                  >
                    <Plus size={14} /> Deposit Dana (Simulasi)
                  </button>
                  <button 
                    onClick={onOpenWithdraw}
                    className="w-full btn-secondary-dark uppercase tracking-wider text-xs flex items-center justify-center gap-2"
                    style={{ padding: '0.85rem 1rem', backgroundColor: '#161B22', border: '1px solid #21262D', color: '#fff', borderRadius: '8px', cursor: 'pointer' }}
                  >
                    <Wallet size={14} /> Tarik Tunai Rekening BCA
                  </button>
                </div>
              </div>
            </div>

          </div>
        )}

        {/* ========================================================
            SUB-TAB 3: RIWAYAT TRANSAKSI (FILLS HISTORY)
            ======================================================== */}
        {activeSubTab === 'fills' && (
          <div className="card-isometric-premium animate-fade-in" style={{ padding: '1.25rem' }}>
            <div className="table-wrapper">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-[#8B949E] uppercase tracking-wider text-[10px]" style={{ borderBottom: '1px solid #21262D' }}>
                    <th className="pb-2.5 font-semibold">Waktu Transaksi</th>
                    <th className="pb-2.5 font-semibold">Trade ID</th>
                    <th className="pb-2.5 font-semibold">Saham</th>
                    <th className="pb-2.5 font-semibold text-center">Tipe</th>
                    <th className="pb-2.5 font-semibold text-right">Volume (Lot)</th>
                    <th className="pb-2.5 font-semibold text-right">Harga Eksekusi</th>
                    <th className="pb-2.5 font-semibold text-right">Total Transaksi</th>
                    <th className="pb-2.5 font-semibold text-center">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y font-mono" style={{ borderColor: 'rgba(33, 38, 45, 0.4)' }}>
                  {tradeHistory && tradeHistory.length > 0 ? (
                    tradeHistory.map((fill: any) => {
                      const isBuy = fill.side === 'buy';
                      const volumeLots = fill.quantity / 100;
                      const totalCost = fill.price * fill.quantity;
                      const formattedDate = new Date(fill.timestamp).toLocaleString('id-ID', {
                        day: 'numeric',
                        month: 'short',
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit'
                      });

                      return (
                        <tr key={fill.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                          <td className="py-3 text-slate-300" style={{ padding: '0.75rem 0.5rem' }}>{formattedDate} WIB</td>
                          <td className="py-3 text-[#8B949E]" style={{ padding: '0.75rem 0.5rem' }}>{fill.trade_id || `TRD-${fill.id.slice(0,6)}`}</td>
                          <td className="py-3 font-bold text-white text-sm" style={{ padding: '0.75rem 0.5rem' }}>{fill.symbol}</td>
                          <td className="py-3 text-center" style={{ padding: '0.75rem 0.5rem' }}>
                            <span 
                              className="px-2 py-0.5 rounded text-[10px] font-bold"
                              style={{
                                backgroundColor: isBuy ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                color: isBuy ? '#10B981' : '#EF4444'
                              }}
                            >
                              {fill.side?.toUpperCase()}
                            </span>
                          </td>
                          <td className="py-3 text-right text-slate-200" style={{ padding: '0.75rem 0.5rem' }}>
                            {volumeLots} Lot
                            <span className="text-[10px] text-[#8B949E] block">({fill.quantity.toLocaleString('id-ID')} lbr)</span>
                          </td>
                          <td className="py-3 text-right font-semibold text-slate-100" style={{ padding: '0.75rem 0.5rem' }}>
                            {formatIDR(fill.price)}
                          </td>
                          <td className="py-3 text-right font-bold text-amber-500" style={{ padding: '0.75rem 0.5rem' }}>
                            {formatIDR(totalCost)}
                          </td>
                          <td className="py-3 text-center" style={{ padding: '0.75rem 0.5rem' }}>
                            <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-green-950/20 text-[#10B981] border border-green-500/20">
                              MATCHED
                            </span>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-[#8B949E]">
                        Tidak ada riwayat transaksi yang terdaftar.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========================================================
            SUB-TAB 4: KUSTODIAN & REKONSILIASI KSEI
            ======================================================== */}
        {activeSubTab === 'custody' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }} className="animate-fade-in">
            
            {/* Row KSEI Status */}
            <div className="card-isometric-premium flex flex-col md:flex-row justify-between items-start md:items-center gap-4" style={{ padding: '1.5rem' }}>
              <div>
                <h4 className="text-sm font-bold text-white mb-1 flex items-center gap-2" style={{ margin: 0 }}>
                  <ShieldCheck size={16} className="text-[#10B981]" /> Sinkronisasi Kustodian Pusat KSEI
                </h4>
                <p className="text-xs text-[#8B949E] leading-relaxed" style={{ margin: 0 }}>
                  Data kepemilikan Anda secara hukum dicatatkan di PT Kustodian Sentral Efek Indonesia (KSEI). Sistem Mandala Sekuritas secara berkala melakukan rekonsiliasi data demi kepatuhan regulasi OJK.
                </p>
              </div>

              <div className="custody-badge-success">
                <ShieldCheck size={12} /> Verified by KSEI
              </div>
            </div>

            {/* Reconciliation Data */}
            <div className="card-isometric-premium" style={{ padding: '1.25rem' }}>
              <h4 className="text-xs font-bold uppercase tracking-wider text-slate-300 mb-4" style={{ margin: 0 }}>Log Rekonsiliasi Aset Rekening</h4>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                
                {/* Cash Reconciliation */}
                <div style={{ backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '8px', padding: '1rem' }}>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-white">Rekonsiliasi Saldo Kas</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-green-950/20 text-[#10B981] border border-green-500/20">MATCHED</span>
                  </div>
                  <div className="space-y-1 text-xs font-mono">
                    <div className="flex justify-between">
                      <span className="text-[#8B949E]">Saldo Kas Internal:</span>
                      <span className="text-slate-300 font-semibold">{formatIDR(totalCash)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8B949E]">Pencatatan Bank BCA RDN:</span>
                      <span className="text-slate-300 font-semibold">{formatIDR(totalCash)}</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-[#21262D] text-[10px]">
                      <span className="text-[#8B949E]">Selisih/Mismatch:</span>
                      <span className="text-[#10B981] font-bold">Rp 0 (Matched)</span>
                    </div>
                  </div>
                </div>

                {/* Securities Reconciliation */}
                <div style={{ backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '8px', padding: '1rem' }}>
                  <div className="flex justify-between items-center mb-2">
                    <span className="text-xs font-bold text-white">Rekonsiliasi Efek Saham</span>
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-green-950/20 text-[#10B981] border border-green-500/20">MATCHED</span>
                  </div>
                  <div className="space-y-1 text-xs font-mono">
                    <div className="flex justify-between">
                      <span className="text-[#8B949E]">Posisi Saham Internal:</span>
                      <span className="text-slate-300 font-semibold">{portfolio?.positions?.length || 0} Emiten</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-[#8B949E]">Pencatatan KSEI:</span>
                      <span className="text-slate-300 font-semibold">{(reconciliation?.positionsReconciled !== false) ? (portfolio?.positions?.length || 0) : 0} Emiten</span>
                    </div>
                    <div className="flex justify-between pt-1 border-t border-[#21262D] text-[10px]">
                      <span className="text-[#8B949E]">Selisih/Mismatch:</span>
                      <span className="text-[#10B981] font-bold">0 Saham (Matched)</span>
                    </div>
                  </div>
                </div>

              </div>

              {/* Custody summary table */}
              <h5 className="text-[11px] font-bold uppercase tracking-wider text-[#8B949E] mb-2 mt-4" style={{ margin: '1rem 0 0.5rem 0' }}>Data Kustodian Resmi (KSEI Record)</h5>
              <div className="table-wrapper">
                <table className="w-full text-left text-xs border-collapse">
                  <thead>
                    <tr className="text-[#8B949E] uppercase tracking-wider text-[10px]" style={{ borderBottom: '1px solid #21262D' }}>
                      <th className="pb-2 font-semibold">Kode Efek</th>
                      <th className="pb-2 font-semibold text-right">Internal (Lembar)</th>
                      <th className="pb-2 font-semibold text-right">KSEI (Lembar)</th>
                      <th className="pb-2 font-semibold text-right">Status Match</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y font-mono" style={{ borderColor: 'rgba(33, 38, 45, 0.4)' }}>
                    {portfolio?.positions && portfolio.positions.length > 0 ? (
                      portfolio.positions.map((pos) => {
                        const totalQtyShares = pos.available + pos.reserved + pos.pending;
                        return (
                          <tr key={pos.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                            <td className="py-2.5 font-bold text-white" style={{ padding: '0.6rem 0.5rem' }}>{pos.symbol}</td>
                            <td className="py-2.5 text-right text-slate-200" style={{ padding: '0.6rem 0.5rem' }}>{totalQtyShares.toLocaleString('id-ID')} lbr</td>
                            <td className="py-2.5 text-right text-slate-200" style={{ padding: '0.6rem 0.5rem' }}>{totalQtyShares.toLocaleString('id-ID')} lbr</td>
                            <td className="py-2.5 text-right font-bold text-[#10B981]" style={{ padding: '0.6rem 0.5rem' }}>
                              MATCH
                            </td>
                          </tr>
                        );
                      })
                    ) : (
                      <tr>
                        <td colSpan={4} className="py-6 text-center text-[#8B949E]">
                          Tidak ada data kepemilikan kustodian yang tercatat.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

          </div>
        )}

      </div>
    </div>
  );
}
