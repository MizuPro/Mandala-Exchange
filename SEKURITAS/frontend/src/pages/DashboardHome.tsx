import { useEffect, useState, useMemo, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { useStore } from '../store/useStore';
import { useOutletContext } from 'react-router-dom';
import { 
  Wallet, 
  Clock, 
  Plus, 
  Trash2, 
  AlertTriangle 
} from 'lucide-react';

const LOT_SIZE = 100;

interface DashboardContext {
  onOpenTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  onOpenDeposit: () => void;
  onOpenWithdraw: () => void;
  buyingPower: number;
}

export default function DashboardHome() {
  const { onOpenTrade, onOpenDeposit, onOpenWithdraw, buyingPower } = useOutletContext<DashboardContext>();

  // --- Store States ---
  const portfolio = useStore(state => state.portfolio);
  const orders = useStore(state => state.orders);
  const securities = useStore(state => state.securities);
  const feeSchedule = useStore(state => state.feeSchedule);
  const ipoEvents = useStore(state => state.ipoEvents);
  const corporateActions = useStore(state => state.corporateActions);
  const market = useStore(state => state.market);
  
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchOrders = useStore(state => state.fetchOrders);
  const cancelOrder = useStore(state => state.cancelOrder);

  // --- Local States ---
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  
  // Watchlist (persisten di localStorage)
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const saved = localStorage.getItem('mandala_watchlist');
    return saved ? JSON.parse(saved) : ['MNDL', 'NUSA', 'BARA'];
  });

  // Chart Timeframe
  const [chartTimeframe, setChartTimeframe] = useState<'1S' | '1m' | '1H' | '1D'>('1H');

  // MDX Index Simulation states
  const [mdxHistory, setMdxHistory] = useState<{ time: string; value: number }[]>([]);
  const [mdxCurrent, setMdxCurrent] = useState<{ value: number; baseValue: number } | null>(null);
  const [mdxLoading, setMdxLoading] = useState(false);
  const [isChartMaximized, setIsChartMaximized] = useState(false);
  
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const maximizedChartContainerRef = useRef<HTMLDivElement>(null);

  // --- Toast helper ---
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // --- Fetch MDX Data ---
  const fetchMdxData = async (period: string = chartTimeframe) => {
    setMdxLoading(true);
    try {
      const { resolveApiBase } = await import('../config/endpoints');
      const apiBase = resolveApiBase();
      const [indicesRes, histRes] = await Promise.all([
        fetch(`${apiBase}/market/indices`),
        fetch(`${apiBase}/market/indices/MDX/history?period=${period}`),
      ]);
      if (indicesRes.ok) {
        const indices = await indicesRes.json();
        const mdx = Array.isArray(indices) ? indices.find((i: any) => i.code === 'MDX') : null;
        if (mdx) {
          setMdxCurrent({ value: parseFloat(mdx.last_value), baseValue: parseFloat(mdx.base_value) });
        }
      }
      if (histRes.ok) {
        const hist = await histRes.json();
        if (Array.isArray(hist) && hist.length > 0) {
          setMdxHistory(hist);
        } else {
          setMdxHistory([]);
        }
      }
    } catch (err) {
      console.warn("Failed to fetch MDX composite history from BEI", err);
    } finally {
      setMdxLoading(false);
    }
  };

  useEffect(() => {
    fetchMdxData(chartTimeframe);
  }, [chartTimeframe]);

  // --- Watchlist Handler ---
  const toggleWatchlist = (symbol: string) => {
    let nextWatchlist: string[];
    if (watchlist.includes(symbol)) {
      nextWatchlist = watchlist.filter(s => s !== symbol);
      showToast(`${symbol} dihapus dari watchlist`, 'error');
    } else {
      nextWatchlist = [...watchlist, symbol];
      showToast(`${symbol} ditambahkan ke watchlist`, 'success');
    }
    setWatchlist(nextWatchlist);
    localStorage.setItem('mandala_watchlist', JSON.stringify(nextWatchlist));
  };

  // --- Cancel Order ---
  const handleCancelOrder = async (orderId: string, symbol: string) => {
    try {
      await cancelOrder(orderId);
      showToast(`Order ${symbol} berhasil dibatalkan!`, 'success');
      fetchOrders();
      fetchPortfolio();
    } catch (err: any) {
      showToast(`Gagal membatalkan order: ${err.message}`, 'error');
    }
  };

  // --- Financial Calculations ---
  const positionsValue = useMemo(() => {
    if (!portfolio?.positions) return 0;
    return portfolio.positions.reduce((sum, pos) => {
      const lastPrice = market.lastPrices[pos.symbol] || parseFloat(pos.average_price) || 0;
      const totalQty = pos.available + pos.reserved + pos.pending;
      return sum + (totalQty * lastPrice);
    }, 0);
  }, [portfolio?.positions, market.lastPrices]);

  const totalNAV = buyingPower + positionsValue;

  const positionsCostBasis = useMemo(() => {
    if (!portfolio?.positions) return 0;
    return portfolio.positions.reduce((sum, pos) => {
      const totalQty = pos.available + pos.reserved + pos.pending;
      return sum + (totalQty * parseFloat(pos.average_price));
    }, 0);
  }, [portfolio?.positions]);

  const totalPLAmount = positionsValue - positionsCostBasis;
  const totalPLPercent = positionsCostBasis > 0 ? (totalPLAmount / positionsCostBasis) * 100 : 0;

  // Securities calculations
  const processedSecurities = useMemo(() => {
    return securities.map((sec) => {
      const symbol = sec.symbol || sec.code || '';
      const name = sec.name || symbol;
      
      const rawSec = sec as any;
      const prevClose = parseFloat(rawSec.previous_close || rawSec.reference_price || '0');
      const lastPrice = market.lastPrices[symbol] || prevClose || 0;
      
      const changeVal = lastPrice - prevClose;
      const changePercent = prevClose > 0 ? (changeVal / prevClose) * 100 : 0;

      return {
        symbol,
        name,
        lastPrice,
        prevClose,
        change: parseFloat(changePercent.toFixed(2)),
        isGainer: changePercent >= 0,
        volume: rawSec.shares_outstanding ? `${(rawSec.shares_outstanding / 1000000).toFixed(1)}M` : 'N/A'
      };
    });
  }, [securities, market.lastPrices]);

  const topGainers = useMemo(() => {
    return [...processedSecurities]
      .filter(s => s.lastPrice > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 3);
  }, [processedSecurities]);

  const topLosers = useMemo(() => {
    return [...processedSecurities]
      .filter(s => s.lastPrice > 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, 3);
  }, [processedSecurities]);

  const mdxDisplayValue = mdxCurrent?.value ?? 1000;
  const mdxBaseValue = mdxCurrent?.baseValue ?? 1000;
  const mdxChangePercent = mdxBaseValue > 0 ? parseFloat((((mdxDisplayValue - mdxBaseValue) / mdxBaseValue) * 100).toFixed(2)) : 0;

  const chartPoints = useMemo(() => {
    if (mdxHistory.length > 0) {
      return mdxHistory.map(p => p.value);
    }
    const days = chartTimeframe === '1S' ? 30 :
                 chartTimeframe === '1m' ? 60 :
                 chartTimeframe === '1H' ? 24 : 90;
    return Array(days).fill(mdxDisplayValue);
  }, [mdxHistory, mdxDisplayValue, chartTimeframe]);

  // --- Chart 1: Small Chart ---
  useEffect(() => {
    if (!chartContainerRef.current) return;
    chartContainerRef.current.innerHTML = '';

    const containerWidth = chartContainerRef.current.clientWidth;
    const isPositive = mdxChangePercent >= 0;
    const themeColor = isPositive ? '#10B981' : '#EF4444';
    const topGlowColor = isPositive ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';

    const chartInstance = createChart(chartContainerRef.current, {
      width: containerWidth,
      height: 120,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8B949E',
        fontSize: 10,
        fontFamily: 'monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(33, 38, 45, 0.15)' },
        horzLines: { color: 'rgba(33, 38, 45, 0.15)' },
      },
      rightPriceScale: {
        borderVisible: false,
        textColor: '#8B949E',
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        horzLine: { visible: true, labelVisible: true },
        vertLine: { visible: true, labelVisible: true },
      },
      handleScale: false,
      handleScroll: false,
    });

    const areaSeries = chartInstance.addSeries(AreaSeries, {
      lineColor: themeColor,
      topColor: topGlowColor,
      bottomColor: 'rgba(0, 0, 0, 0)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const formattedData = chartPoints.map((val, idx) => {
      if (mdxHistory.length > 0 && mdxHistory[idx]) {
        return {
          time: Math.floor(new Date(mdxHistory[idx].time).getTime() / 1000) as any,
          value: val
        };
      }
      const date = new Date();
      date.setHours(date.getHours() - (chartPoints.length - idx));
      return {
        time: Math.floor(date.getTime() / 1000) as any,
        value: val
      };
    });

    formattedData.sort((a, b) => (a.time as number) - (b.time as number));
    const uniqueData: typeof formattedData = [];
    const seenTimes = new Set();
    for (const item of formattedData) {
      if (!seenTimes.has(item.time)) {
        seenTimes.add(item.time);
        uniqueData.push(item);
      }
    }

    areaSeries.setData(uniqueData);
    chartInstance.timeScale().fitContent();

    const handleResize = () => {
      if (chartContainerRef.current) {
        chartInstance.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chartInstance.remove();
    };
  }, [chartPoints, mdxHistory, chartTimeframe, mdxChangePercent]);

  // --- Chart 2: Maximized Chart ---
  useEffect(() => {
    if (!isChartMaximized || !maximizedChartContainerRef.current) return;
    maximizedChartContainerRef.current.innerHTML = '';

    const containerWidth = maximizedChartContainerRef.current.clientWidth;
    const isPositive = mdxChangePercent >= 0;
    const themeColor = isPositive ? '#10B981' : '#EF4444';
    const topGlowColor = isPositive ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';

    const chartInstance = createChart(maximizedChartContainerRef.current, {
      width: containerWidth,
      height: 400,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8B949E',
        fontSize: 11,
        fontFamily: 'monospace',
        attributionLogo: false,
      },
      grid: {
        vertLines: { color: 'rgba(33, 38, 45, 0.15)' },
        horzLines: { color: 'rgba(33, 38, 45, 0.15)' },
      },
      rightPriceScale: {
        borderVisible: false,
        textColor: '#8B949E',
      },
      timeScale: {
        borderVisible: false,
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: {
        horzLine: { visible: true, labelVisible: true },
        vertLine: { visible: true, labelVisible: true },
      },
      handleScale: true,
      handleScroll: true,
    });

    const areaSeries = chartInstance.addSeries(AreaSeries, {
      lineColor: themeColor,
      topColor: topGlowColor,
      bottomColor: 'rgba(0, 0, 0, 0)',
      lineWidth: 2,
      priceFormat: {
        type: 'price',
        precision: 2,
        minMove: 0.01,
      },
    });

    const formattedData = chartPoints.map((val, idx) => {
      if (mdxHistory.length > 0 && mdxHistory[idx]) {
        return {
          time: Math.floor(new Date(mdxHistory[idx].time).getTime() / 1000) as any,
          value: val
        };
      }
      const date = new Date();
      date.setHours(date.getHours() - (chartPoints.length - idx));
      return {
        time: Math.floor(date.getTime() / 1000) as any,
        value: val
      };
    });

    formattedData.sort((a, b) => (a.time as number) - (b.time as number));
    const uniqueData: typeof formattedData = [];
    const seenTimes = new Set();
    for (const item of formattedData) {
      if (!seenTimes.has(item.time)) {
        seenTimes.add(item.time);
        uniqueData.push(item);
      }
    }

    areaSeries.setData(uniqueData);
    chartInstance.timeScale().fitContent();

    const handleResize = () => {
      if (maximizedChartContainerRef.current) {
        chartInstance.applyOptions({ width: maximizedChartContainerRef.current.clientWidth });
      }
    };
    const resizeTimeout = setTimeout(handleResize, 400);
    window.addEventListener('resize', handleResize);

    return () => {
      clearTimeout(resizeTimeout);
      window.removeEventListener('resize', handleResize);
      chartInstance.remove();
    };
  }, [isChartMaximized, chartPoints, mdxHistory, mdxChangePercent]);

  return (
    <div className="dashboard-grid-layout animate-fade-in">
      <style>{`
        /* Maximize Overlay dengan Morph Effect */
        .chart-maximize-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background-color: rgba(13, 17, 23, 0.7);
          backdrop-filter: blur(12px);
          z-index: 10000;
          display: flex;
          justify-content: center;
          align-items: center;
          opacity: 0;
          pointer-events: none;
          transition: opacity 0.35s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .chart-maximize-overlay.active {
          opacity: 1;
          pointer-events: auto;
        }
        .chart-maximize-content {
          background-color: #0D1117;
          border: 1px solid #30363D;
          border-radius: 12px;
          width: 85vw;
          height: 75vh;
          padding: 1.5rem;
          box-shadow: 0 24px 48px rgba(0, 0, 0, 0.6);
          display: flex;
          flex-direction: column;
          justify-content: space-between;
          transform: scale(0.92) translate3d(0, 30px, 0);
          transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        .chart-maximize-overlay.active .chart-maximize-content {
          transform: scale(1) translate3d(0, 0, 0);
        }
        .maximize-btn {
          background: transparent;
          border: none;
          color: #8B949E;
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.2s ease;
        }
        .maximize-btn:hover {
          color: #FFFFFF;
          background-color: #21262D;
        }
      `}</style>
      
      {/* ==================== BARIS ATAS ==================== */}

      {/* SECTION A: RINGKASAN FINANSIAL PENGGUNA (7/12 Kolom) */}
      <section className="card-isometric-premium card-indicator-red grid-col-7 flex flex-col justify-between" style={{ minHeight: '220px' }}>
        <div>
          <div className="card-header-responsive">
            <div>
              <span className="text-[11px] font-semibold text-[#8B949E] uppercase tracking-wider block mb-1">
                Total Nilai Aset (Net Asset Value)
              </span>
              <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight font-mono" style={{ margin: 0 }}>
                Rp {totalNAV.toLocaleString('id-ID')}
              </h2>
            </div>
            <span 
              className="inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold animate-pulse"
              style={{
                backgroundColor: totalPLAmount >= 0 ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)',
                color: totalPLAmount >= 0 ? '#10B981' : '#EF4444'
              }}
            >
              {totalPLAmount >= 0 ? '+' : ''}{totalPLPercent.toFixed(2)}% ({totalPLAmount >= 0 ? 'Untung' : 'Rugi'})
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '1rem', paddingTop: '1rem', borderTop: '1px solid #21262D', marginBottom: '1.5rem' }}>
            <div>
              <span className="text-[10px] text-[#8B949E] uppercase tracking-wider" style={{ display: 'block', marginBottom: '0.25rem' }}>Total Profit & Loss (P/L)</span>
              <span 
                className="text-sm font-bold font-mono"
                style={{ color: totalPLAmount >= 0 ? '#10B981' : '#EF4444', display: 'block' }}
              >
                {totalPLAmount >= 0 ? '▲' : '▼'} Rp {Math.abs(totalPLAmount).toLocaleString('id-ID')}
              </span>
            </div>
            <div>
              <span className="text-[10px] text-[#8B949E] uppercase tracking-wider" style={{ display: 'block', marginBottom: '0.25rem' }}>Dana Siap Belanja (Buying Power)</span>
              <span className="text-sm font-bold text-white font-mono" style={{ display: 'block' }}>
                Rp {buyingPower.toLocaleString('id-ID')}
              </span>
            </div>
          </div>
        </div>
        
        {/* Tombol Aksi Cepat */}
        <div className="card-actions-responsive">
          <button 
            onClick={onOpenDeposit}
            className="flex-grow btn-primary-red uppercase tracking-wider text-xs flex items-center justify-center gap-2"
            style={{ padding: '0.85rem 1rem' }}
          >
            <Plus size={14} /> Deposit Dana
          </button>
          <button 
            onClick={onOpenWithdraw}
            className="flex-grow btn-secondary-dark uppercase tracking-wider text-xs flex items-center justify-center gap-2"
            style={{ padding: '0.85rem 1rem' }}
          >
            <Wallet size={14} /> Tarik Tunai
          </button>
        </div>
      </section>

      {/* SECTION B: GRAFIK MDX (5/12 Kolom) */}
      <section className="card-isometric-premium grid-col-5 flex flex-col justify-between" style={{ minHeight: '220px' }}>
        <div className="card-header-responsive">
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <span className="text-[11px] font-semibold text-[#8B949E] uppercase tracking-wider">MDX Index</span>
              {mdxHistory.length > 0 && (
                <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(16,185,129,0.15)', color: '#10B981', fontWeight: 700, border: '1px solid rgba(16,185,129,0.3)' }}>LIVE</span>
              )}
              {mdxLoading && (
                <span style={{ fontSize: '9px', color: '#8B949E' }}>...</span>
              )}
            </div>
            <span className="text-xs text-slate-400 font-mono">Mandala Composite Index</span>
          </div>
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            {/* Timeframe Selector */}
            <div style={{ display: 'flex', gap: '0.25rem', padding: '0.25rem', backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '6px' }}>
              {(['1S', '1m', '1H', '1D'] as const).map((tf) => (
                <button
                  key={tf}
                  onClick={() => setChartTimeframe(tf)}
                  style={{
                    padding: '0.25rem 0.5rem',
                    borderRadius: '4px',
                    fontSize: '10px',
                    fontWeight: 'bold',
                    border: 'none',
                    cursor: 'pointer',
                    backgroundColor: chartTimeframe === tf ? '#21262D' : 'transparent',
                    color: chartTimeframe === tf ? '#FFFFFF' : '#8B949E'
                  }}
                >
                  {tf}
                </button>
              ))}
            </div>

            {/* Maximize Button */}
            <button 
              onClick={() => setIsChartMaximized(true)}
              className="maximize-btn"
              title="Perbesar Grafik"
            >
              <svg className="w-3.5 h-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7" />
              </svg>
            </button>
          </div>
        </div>

        {/* Current value display */}
        <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', padding: '0 0 0.25rem' }}>
          <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '1.4rem', color: '#fff' }}>
            {mdxDisplayValue.toLocaleString('id-ID', { maximumFractionDigits: 2 })}
          </span>
          <span style={{ fontSize: '0.75rem', fontWeight: 700, color: mdxChangePercent >= 0 ? '#10B981' : '#EF4444' }}>
            {mdxChangePercent >= 0 ? '▲' : '▼'} {Math.abs(mdxChangePercent)}%
          </span>
        </div>

        {/* TradingView Lightweight Charts */}
        <div 
          ref={chartContainerRef}
          className="w-full rounded-lg overflow-hidden"
          style={{ flex: 1, minHeight: '120px', backgroundColor: 'rgba(13, 17, 23, 0.3)', border: '1px solid #21262D' }}
        />
        
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '9px', color: '#8B949E', fontFamily: 'monospace', padding: '0.25rem 0.5rem 0' }}>
          <span>Base: {mdxBaseValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span>
          <span style={{ color: mdxHistory.length > 0 ? '#10B981' : '#8B949E' }}>
            {mdxHistory.length > 0 ? `${mdxHistory.length} titik data` : 'Tidak ada transaksi'}
          </span>
        </div>
      </section>

      {/* ==================== BARIS KEDUA (GRID 12-KOLOM) ==================== */}

      {/* KOLOM UTAMA / KIRI (7/12 Kolom) */}
      <div className="grid-col-7 flex flex-col gap-6">
        
        {/* SECTION C: PORTOFOLIO AKTIF (NILAI NYATA) */}
        <section className="card-isometric-premium">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2" style={{ margin: 0 }}>
              <span className="w-2 h-2 rounded-full" style={{ backgroundColor: '#E62225' }}></span>
              Portofolio Aktif Anda
            </h3>
            <span className="text-[11px] font-mono text-[#8B949E]">{portfolio?.positions?.length || 0} Emiten</span>
          </div>

          <div className="table-wrapper">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="text-[#8B949E] uppercase tracking-wider text-[10px]" style={{ borderBottom: '1px solid #21262D' }}>
                  <th className="pb-2.5 font-semibold">Kode</th>
                  <th className="pb-2.5 font-semibold text-right">Kepemilikan (Lot)</th>
                  <th className="pb-2.5 font-semibold text-right">Harga Rata²</th>
                  <th className="pb-2.5 font-semibold text-right">Harga Pasar</th>
                  <th className="pb-2.5 font-semibold text-right">P/L Per Saham</th>
                  <th className="pb-2.5 font-semibold text-center">Aksi</th>
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

                    return (
                      <tr key={pos.symbol} style={{ borderBottom: '1px solid rgba(255,255,255,0.02)' }}>
                        <td className="py-3 font-bold text-white text-sm" style={{ padding: '0.75rem 0.5rem' }}>{pos.symbol}</td>
                        <td className="py-3 text-right text-slate-200" style={{ padding: '0.75rem 0.5rem' }}>
                          {totalQtyLots} Lot
                          <span className="text-[10px] text-[#8B949E] block">({totalQtyShares.toLocaleString('id-ID')} lbr)</span>
                        </td>
                        <td className="py-3 text-right text-[#8B949E]" style={{ padding: '0.75rem 0.5rem' }}>
                          Rp {avgPrice.toLocaleString('id-ID')}
                        </td>
                        <td className="py-3 text-right font-semibold text-slate-100" style={{ padding: '0.75rem 0.5rem' }}>
                          Rp {lastPrice.toLocaleString('id-ID')}
                        </td>
                        <td 
                          className="py-3 text-right font-bold"
                          style={{ color: posPL >= 0 ? '#10B981' : '#EF4444', padding: '0.75rem 0.5rem' }}
                        >
                          {posPL >= 0 ? '+' : ''}{posPLPercent.toFixed(1)}%
                          <span className="text-[10px] block font-normal text-slate-400">
                            Rp {((lastPrice - avgPrice) * 100).toLocaleString('id-ID')} / lot
                          </span>
                        </td>
                        <td className="py-3 text-center" style={{ padding: '0.75rem 0.5rem' }}>
                          <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                            <button
                              onClick={() => onOpenTrade(pos.symbol, 'BUY')}
                              className="pill-action-buy"
                              style={{ backgroundColor: 'rgba(16, 185, 129, 0.15)', color: '#10B981', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}
                            >
                              Beli
                            </button>
                            <button
                              onClick={() => onOpenTrade(pos.symbol, 'SELL')}
                              className="pill-action-sell"
                              style={{ backgroundColor: 'rgba(239, 68, 68, 0.15)', color: '#EF4444', padding: '2px 8px', borderRadius: '4px', fontSize: '11px', fontWeight: 'bold' }}
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
                    <td colSpan={6} className="py-8 text-center text-[#8B949E]">
                      Belum memiliki posisi saham terdaftar. Mulai bertransaksi melalui watchlist atau tombol Beli.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* SECTION F: ANTREAN ORDER TERAKHIR (NYATA) */}
        <section className="card-isometric-premium">
          <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-4 flex items-center gap-2" style={{ margin: 0 }}>
            <Clock size={16} className="text-[#8B949E]" />
            Antrean Order Terakhir (Recent Orders)
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column' }}>
            {orders && orders.length > 0 ? (
              orders.slice(0, 5).map((order) => {
                const isBuy = order.side === 'buy';
                const totalBill = (order.price || 0) * order.original_quantity;
                const formattedTime = order.created_at ? new Date(order.created_at).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : 'N/A';
                const mappedStatus = order.status === 'filled' ? 'Matched' : 
                                     (order.status === 'open' || order.status === 'accepted') ? 'Pending' : 'Cancelled';

                return (
                  <div 
                    key={order.id} 
                    style={{ 
                      display: 'flex', 
                      justifyContent: 'space-between', 
                      alignItems: 'center', 
                      padding: '0.75rem 0',
                      borderBottom: '1px solid rgba(33, 38, 45, 0.6)',
                      fontSize: '12px'
                    }}
                    className="font-mono"
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span 
                        style={{
                          width: '2.25rem',
                          height: '2.25rem',
                          borderRadius: '8px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontWeight: 'bold',
                          fontSize: '10px',
                          backgroundColor: isBuy ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                          color: isBuy ? '#10B981' : '#EF4444'
                        }}
                      >
                        {order.side?.toUpperCase()}
                      </span>
                      <div>
                        <span className="text-sm font-bold text-white block">{order.symbol}</span>
                        <span className="text-[10px] text-[#8B949E]">{formattedTime} WIB</span>
                      </div>
                    </div>

                    <div className="text-right">
                      <span className="text-slate-100 block">{(order.original_quantity / 100)} Lot @ Rp {(order.price || 0).toLocaleString('id-ID')}</span>
                      <span className="text-[10px] text-[#8B949E] block">Total: Rp {totalBill.toLocaleString('id-ID')}</span>
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <span 
                        className="px-2 py-0.5 rounded text-[10px] font-bold"
                        style={{
                          backgroundColor: 
                            mappedStatus === 'Matched' ? 'rgba(16, 185, 129, 0.1)' : 
                            mappedStatus === 'Pending' ? 'rgba(245, 158, 11, 0.1)' : 'rgba(139, 92, 246, 0.1)',
                          color: 
                            mappedStatus === 'Matched' ? '#10B981' : 
                            mappedStatus === 'Pending' ? '#F59E0B' : '#8B949E'
                        }}
                      >
                        {mappedStatus}
                      </span>
                      {(order.status === 'open' || order.status === 'accepted') && (
                        <button
                          onClick={() => handleCancelOrder(order.id!, order.symbol!)}
                          className="p-1 rounded text-red-500 hover:bg-red-950/20"
                          style={{ background: 'transparent', border: 'none', display: 'flex', cursor: 'pointer' }}
                          title="Batalkan Order"
                        >
                          <Trash2 size={13} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-6 text-center text-[#8B949E]">
                Tidak ada antrean order aktif saat ini.
              </div>
            )}
          </div>
        </section>

        {/* SECTION G: E-IPO & AKSI KORPORASI NYATA */}
        <section className="card-isometric-premium" style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1.25rem' }}>
          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3 flex items-center gap-2" style={{ margin: 0 }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#E62225' }}></span>
              Highlight e-IPO
            </h4>
            <div 
              className="p-3.5 rounded-lg flex flex-col justify-between h-32 relative overflow-hidden"
              style={{ backgroundColor: '#0D1117', border: '1px solid #21262D', boxSizing: 'border-box' }}
            >
              {ipoEvents && ipoEvents.length > 0 ? (
                <>
                  <div>
                    <span 
                      className="text-[9px] font-bold px-2 py-0.5 rounded-md border"
                      style={{ backgroundColor: 'rgba(230, 34, 37, 0.1)', borderColor: 'rgba(230, 34, 37, 0.3)', color: '#E62225' }}
                    >
                      ACTIVE
                    </span>
                    <p className="text-sm font-bold text-slate-100 mt-2 mb-1 truncate">
                      {ipoEvents[0].company_name || ipoEvents[0].symbol}
                    </p>
                    <p className="text-[10px] text-[#8B949E] font-mono">
                      Bookbuilding: Rp {ipoEvents[0].price_range_min || 210} - Rp {ipoEvents[0].price_range_max || 250}
                    </p>
                  </div>
                  <div className="flex justify-between items-center text-[10px] mt-2 pt-2" style={{ borderTop: '1px solid #21262D' }}>
                    <span className="text-[#8B949E]">Listing: {ipoEvents[0].listing_date ? new Date(ipoEvents[0].listing_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : 'Segera'}</span>
                    <button 
                      onClick={() => {
                        const code = ipoEvents[0].symbol || 'MEI';
                        onOpenTrade(code, 'BUY');
                      }}
                      className="text-[#E62225] hover:underline font-bold"
                      style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                    >
                      Pesan IPO ↗
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <span className="text-xs text-[#8B949E]">Tidak ada penawaran IPO aktif</span>
                </div>
              )}
            </div>
          </div>

          <div>
            <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3 flex items-center gap-2" style={{ margin: 0 }}>
              <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: '#E62225' }}></span>
              Aksi Korporasi Portofolio
            </h4>
            <div 
              className="p-3.5 rounded-lg flex flex-col justify-between h-32"
              style={{ backgroundColor: '#0D1117', border: '1px solid #21262D', boxSizing: 'border-box' }}
            >
              {corporateActions && corporateActions.length > 0 ? (
                <>
                  <div>
                    <span 
                      className="text-[9px] font-bold px-2 py-0.5 rounded-md border"
                      style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.3)', color: '#10B981' }}
                    >
                      {corporateActions[0].action_type?.toUpperCase() || 'DIVIDEND'}
                    </span>
                    <p className="text-sm font-bold text-slate-100 mt-2 mb-1 truncate">
                      {corporateActions[0].symbol} akan membagikan dividen
                    </p>
                    <p className="text-[10px] text-[#8B949E]">
                      Sebesar Rp {corporateActions[0].amount || '220'},- / lembar saham
                    </p>
                  </div>
                  <div className="flex justify-between items-center text-[10px] mt-2 pt-2" style={{ borderTop: '1px solid #21262D' }}>
                    <span className="text-[#8B949E] font-mono">Cum Date: {corporateActions[0].cum_date ? new Date(corporateActions[0].cum_date).toLocaleDateString('id-ID') : 'Segera'}</span>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
                  <span className="text-xs text-[#8B949E]">Tidak ada aksi korporasi baru</span>
                </div>
              )}
            </div>
          </div>
        </section>

      </div>

      {/* KOLOM KANAN / SIDEBAR UTAMA (5/12 Kolom) */}
      <div className="grid-col-5 flex flex-col gap-6">
        
        {/* SECTION D: KONDISI PASAR & INDEKS SAHAM */}
        <section className="card-isometric-premium">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem', paddingBottom: '0.5rem', borderBottom: '1px solid #21262D' }}>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2" style={{ margin: 0 }}>
              <svg className="w-4 h-4 text-[#8B949E]" width={16} height={16} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path>
              </svg>
              Pergerakan Emiten Hari Ini
            </h3>
            <span className="text-[10px] text-[#10B981] font-bold animate-pulse">LIVE FEED</span>
          </div>

          {/* Tabbed Component (Gainers / Losers) */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: '0.5rem' }}>
            <div style={{ padding: '0.75rem', backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '8px' }}>
              <p className="text-[9px] uppercase font-bold text-[#10B981] tracking-wider" style={{ margin: '0 0 0.5rem 0' }}>🚀 TOP GAINERS</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {topGainers.map((g) => (
                  <div 
                    key={g.symbol} 
                    onClick={() => onOpenTrade(g.symbol, 'BUY')}
                    className="flex justify-between items-center cursor-pointer hover:bg-slate-800/40 p-1 rounded transition"
                  >
                    <span className="font-bold text-xs text-white">{g.symbol}</span>
                    <span className="text-xs font-mono font-bold text-[#10B981]">+{g.change}%</span>
                  </div>
                ))}
              </div>
            </div>

            <div style={{ padding: '0.75rem', backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '8px' }}>
              <p className="text-[9px] uppercase font-bold text-[#EF4444] tracking-wider" style={{ margin: '0 0 0.5rem 0' }}>📉 TOP LOSERS</p>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem' }}>
                {topLosers.map((l) => (
                  <div 
                    key={l.symbol} 
                    onClick={() => onOpenTrade(l.symbol, 'BUY')}
                    className="flex justify-between items-center cursor-pointer hover:bg-slate-800/40 p-1 rounded transition"
                  >
                    <span className="font-bold text-xs text-white">{l.symbol}</span>
                    <span className="text-xs font-mono font-bold text-[#EF4444]">{l.change}%</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {/* SECTION E: WATCHLIST RINGKAS (PERSISTEN) */}
        <section className="card-isometric-premium">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2" style={{ margin: 0 }}>
              <svg className="w-4 h-4 text-yellow-500 fill-current" width={16} height={16} viewBox="0 0 20 20" style={{ display: 'inline' }}>
                <path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path>
              </svg>
              Daftar Pantauan (Watchlist)
            </h3>
            <span className="text-[10px] text-[#8B949E] font-semibold">Bintang untuk Hapus</span>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.65rem' }}>
            {processedSecurities.map((stock) => {
              const isStarred = watchlist.includes(stock.symbol);
              if (!isStarred) return null;

              return (
                <div 
                  key={stock.symbol} 
                  style={{
                    backgroundColor: '#0D1117',
                    border: '1px solid transparent',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '0.75rem',
                    borderRadius: '8px'
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <button 
                      onClick={() => toggleWatchlist(stock.symbol)} 
                      className="star-btn"
                      style={{ background: 'transparent', border: 'none', color: '#F59E0B', fontSize: '16px', cursor: 'pointer' }}
                    >
                      ★
                    </button>
                    <div>
                      <span className="font-bold text-sm text-white block">{stock.symbol}</span>
                      <span className="text-[10px] text-[#8B949E] max-w-[120px] truncate block">{stock.name}</span>
                    </div>
                  </div>

                  <div className="w-16 h-8 opacity-60">
                    <svg viewBox="0 0 100 30" width="100%" height="100%">
                      <path 
                        d={stock.isGainer ? "M 0 15 Q 25 5, 50 20 T 100 5" : "M 0 5 Q 25 25, 50 10 T 100 25"} 
                        fill="none" 
                        stroke={stock.isGainer ? "#10B981" : "#EF4444"} 
                        strokeWidth="2"
                      />
                    </svg>
                  </div>

                  <div className="text-right">
                    <span className="font-mono font-bold text-sm text-slate-100 block">
                      Rp {stock.lastPrice.toLocaleString('id-ID')}
                    </span>
                    <span 
                      className="text-[10px] font-bold font-mono"
                      style={{ color: stock.change >= 0 ? '#10B981' : '#EF4444' }}
                    >
                      {stock.change >= 0 ? '+' : ''}{stock.change}%
                    </span>
                  </div>

                  <div style={{ marginLeft: '0.5rem' }}>
                    <button 
                      onClick={() => onOpenTrade(stock.symbol, 'BUY')}
                      className="btn-primary-red font-bold text-[10px] px-2.5 py-1.5 rounded transition"
                      style={{ padding: '0.35rem 0.75rem', background: '#E62225', color: '#fff', border: 'none', cursor: 'pointer', borderRadius: '4px' }}
                    >
                      Beli
                    </button>
                  </div>
                </div>
              );
            })}
          </div>

          <div style={{ marginTop: '1rem', paddingTop: '0.75rem', borderTop: '1px solid #21262D' }}>
            <span className="text-[11px] text-[#8B949E] block mb-2">Tambahkan Saham Lain ke Pantauan:</span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.35rem' }}>
              {processedSecurities.map((s) => {
                if (watchlist.includes(s.symbol)) return null;
                return (
                  <button
                    key={s.symbol}
                    onClick={() => toggleWatchlist(s.symbol)}
                    className="btn-secondary-dark font-mono text-[10px] px-2 py-1 transition"
                    style={{ padding: '0.25rem 0.5rem', backgroundColor: '#161B22', border: '1px solid #21262D', color: '#8B949E', borderRadius: '4px', cursor: 'pointer' }}
                  >
                    + {s.symbol}
                  </button>
                );
              })}
            </div>
          </div>
        </section>

      </div>

      {/* Maximize Chart Overlay */}
      <div className={`chart-maximize-overlay ${isChartMaximized ? 'active' : ''}`}>
        <div className="chart-maximize-content">
          <div className="flex justify-between items-center pb-3" style={{ borderBottom: '1px solid #21262D' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span className="text-sm font-bold text-white uppercase tracking-wider">MDX Index (Fokus)</span>
                {mdxHistory.length > 0 && (
                  <span style={{ fontSize: '9px', padding: '1px 5px', borderRadius: '4px', background: 'rgba(16,185,129,0.15)', color: '#10B981', fontWeight: 700, border: '1px solid rgba(16,185,129,0.3)' }}>LIVE</span>
                )}
              </div>
              <span className="text-[11px] text-[#8B949E] font-mono block">Mandala Composite Index</span>
            </div>
            
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              {/* Timeframe Selector di Modal */}
              <div style={{ display: 'flex', gap: '0.25rem', padding: '0.25rem', backgroundColor: '#0D1117', border: '1px solid #21262D', borderRadius: '6px' }}>
                {(['1S', '1m', '1H', '1D'] as const).map((tf) => (
                  <button
                    key={tf}
                    onClick={() => setChartTimeframe(tf)}
                    style={{
                      padding: '0.25rem 0.5rem',
                      borderRadius: '4px',
                      fontSize: '10px',
                      fontWeight: 'bold',
                      border: 'none',
                      cursor: 'pointer',
                      backgroundColor: chartTimeframe === tf ? '#21262D' : 'transparent',
                      color: chartTimeframe === tf ? '#FFFFFF' : '#8B949E'
                    }}
                  >
                    {tf}
                  </button>
                ))}
              </div>

              <button 
                onClick={() => setIsChartMaximized(false)}
                className="text-[#8B949E] hover:text-white p-2 rounded-lg transition"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.25rem' }}
              >
                ✕
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'baseline', gap: '0.5rem', padding: '1rem 0' }}>
            <span style={{ fontFamily: 'monospace', fontWeight: 800, fontSize: '2rem', color: '#fff' }}>
              {mdxDisplayValue.toLocaleString('id-ID', { maximumFractionDigits: 2 })}
            </span>
            <span style={{ fontSize: '0.85rem', fontWeight: 700, color: mdxChangePercent >= 0 ? '#10B981' : '#EF4444' }}>
              {mdxChangePercent >= 0 ? '▲' : '▼'} {Math.abs(mdxChangePercent)}%
            </span>
          </div>

          {/* Maximized Chart Container */}
          <div 
            ref={maximizedChartContainerRef}
            className="w-full rounded-lg overflow-hidden"
            style={{ flex: 1, minHeight: '350px', backgroundColor: 'rgba(13, 17, 23, 0.3)', border: '1px solid #21262D' }}
          />

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '10px', color: '#8B949E', fontFamily: 'monospace', paddingTop: '1rem' }}>
            <span>Base: {mdxBaseValue.toLocaleString('id-ID', { maximumFractionDigits: 0 })}</span>
            <span style={{ color: mdxHistory.length > 0 ? '#10B981' : '#8B949E' }}>
              {mdxHistory.length > 0 ? `${mdxHistory.length} titik data` : 'Tidak ada transaksi'}
            </span>
          </div>
        </div>
      </div>

      {/* Toast Notification */}
      {toast && (
        <div 
          className="toast-premium"
          style={{ 
            position: 'fixed',
            bottom: '2rem',
            right: '2rem',
            backgroundColor: '#161B22',
            border: '1px solid #21262D',
            borderLeft: `4px solid ${toast.type === 'success' ? '#10B981' : '#EF4444'}`,
            padding: '1rem 1.5rem',
            borderRadius: '8px',
            boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
            display: 'flex',
            alignItems: 'center',
            gap: '1rem',
            zIndex: 99999
          }}
        >
          <div className="flex-1">
            <p className="text-xs text-white font-bold" style={{ margin: 0 }}>{toast.message}</p>
          </div>
          <button 
            onClick={() => setToast(null)} 
            className="text-slate-400 hover:text-white font-bold text-xs"
            style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            ✕
          </button>
        </div>
      )}

    </div>
  );
}
