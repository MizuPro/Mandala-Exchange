import { useEffect, useState, useMemo, useRef } from 'react';
import { useParams, useNavigate, useOutletContext } from 'react-router-dom';
import { createChart, CandlestickSeries } from 'lightweight-charts';
import { formatMarketSessionLabel, isOrderEntrySessionStatus, normalizeSessionStatus, useStore } from '../store/useStore';
import { 
  ArrowLeft, 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Layers, 
  Clock, 
  Wallet, 
  CheckCircle,
  AlertTriangle,
  Pencil,
  XCircle,
  AlertCircle,
  Building2,
  FileText
} from 'lucide-react';

const LOT_SIZE = 100;

const formatIDR = (value: string | number | undefined | null) => {
  if (value === undefined || value === null) return 'Rp 0';
  return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(value || 0));
};

interface DashboardContext {
  onOpenTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
  buyingPower: number;
}

export default function MarketDetail() {
  const { symbol } = useParams<{ symbol: string }>();
  const activeSymbol = (symbol || '').toUpperCase();
  const navigate = useNavigate();
  const { buyingPower } = useOutletContext<DashboardContext>();

  // --- Zustand Store Bindings ---
  const securities = useStore(state => state.securities);
  const market = useStore(state => state.market);
  const orders = useStore(state => state.orders);
  const portfolio = useStore(state => state.portfolio);
  const feeSchedule = useStore(state => state.feeSchedule);
  const company = useStore(state => state.company);
  
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchOrders = useStore(state => state.fetchOrders);
  const placeOrder = useStore(state => state.placeOrder);
  const amendOrder = useStore(state => state.amendOrder);
  const cancelOrder = useStore(state => state.cancelOrder);
  const fetchCompany = useStore(state => state.fetchCompany);

  // --- Local States ---
  const [resolution, setResolution] = useState<'1s' | '1m' | '1h' | '1d'>('1s');
  const [candlesData, setCandlesData] = useState<any[]>([]);
  const [chartLoading, setChartLoading] = useState(false);
  const [runningTrades, setRunningTrades] = useState<any[]>([]);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  
  // Tab & Collapse State
  const [activeTab, setActiveTab] = useState<'orders' | 'fundamentals' | 'announcements'>('orders');
  const [expandedAnnouncementId, setExpandedAnnouncementId] = useState<string | null>(null);

  // Order Entry State
  const [tradeSide, setTradeSide] = useState<'BUY' | 'SELL'>('BUY');
  const [orderType, setOrderType] = useState<'limit' | 'market'>('limit');
  const [qtyLots, setQtyLots] = useState<number>(1);
  const [limitPrice, setLimitPrice] = useState<string>('');
  const [orderActionLoading, setOrderActionLoading] = useState(false);

  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartInstanceRef = useRef<any>(null);
  const candleSeriesRef = useRef<any>(null);
  const candlesDataRef = useRef<any[]>([]);

  // Metadata Emiten Aktif
  const activeSecurity = useMemo(() => {
    return securities.find(s => (s.symbol || s.code) === activeSymbol);
  }, [securities, activeSymbol]);

  const prevClose = activeSecurity ? parseFloat((activeSecurity as any).previous_close || (activeSecurity as any).reference_price || '0') : 0;
  const lastPrice = market.lastPrices[activeSymbol] || prevClose || 0;
  
  const priceChange = lastPrice - prevClose;
  const priceChangePercent = prevClose > 0 ? (priceChange / prevClose) * 100 : 0;
  const isGainer = priceChange >= 0;

  const araArbValues = useMemo(() => {
    if (!activeSecurity) return null;
    const refPrice = parseFloat((activeSecurity as any).reference_price || (activeSecurity as any).previous_close || '0');
    const board = (activeSecurity as any).board || 'main';
    
    if (refPrice <= 0) return null;
    
    let araPercent = 0.25;
    let arbPercent = 0.15; // default arb 15% di seed data BEI

    if (refPrice <= 200) {
      araPercent = 0.35;
    } else if (refPrice <= 5000) {
      araPercent = 0.25;
    } else {
      araPercent = 0.20;
    }

    if (board.toLowerCase() === 'watchlist') {
      arbPercent = 0.10;
    }

    const ara = Math.floor(refPrice * (1 + araPercent));
    const arb = Math.max(1, Math.ceil(refPrice * (1 - arbPercent)));

    return { ara, arb };
  }, [activeSecurity]);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // --- 1. Fetch Candle Data dari Proxy Backend ---
  const fetchCandles = async (symbolStr: string, resStr: string) => {
    setChartLoading(true);
    try {
      const { resolveApiBase } = await import('../config/endpoints');
      const apiBase = resolveApiBase();
      const res = await fetch(`${apiBase}/market/securities/${encodeURIComponent(symbolStr)}/candles?resolution=${resStr}`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          // Urutkan data berdasarkan waktu
          const sorted = [...data].sort((a, b) => a.time - b.time);
          setCandlesData(sorted);
          candlesDataRef.current = sorted;
          if (candleSeriesRef.current) {
            candleSeriesRef.current.setData(sorted);
            chartInstanceRef.current?.timeScale().fitContent();
          }
        }
      } else {
        setCandlesData([]);
        candlesDataRef.current = [];
        if (candleSeriesRef.current) candleSeriesRef.current.setData([]);
      }
    } catch (err) {
      console.error("Failed to fetch security candles", err);
    } finally {
      setChartLoading(false);
    }
  };

  // Fetch riwayat transaksi sesi berjalan untuk running trades awal
  const fetchRunningTradesInitial = async () => {
    try {
      const { resolveApiBase } = await import('../config/endpoints');
      const apiBase = resolveApiBase();
      // Menggunakan sessionId aktif (jika ada trades berjalan)
      const lastTradeRes = await fetch(`${apiBase}/portfolio/fills`);
      if (lastTradeRes.ok) {
        const data = await lastTradeRes.json();
        if (Array.isArray(data)) {
          const filtered = data
            .filter((t: any) => t.symbol === activeSymbol)
            .slice(0, 15)
            .map((t: any) => ({
              price: parseFloat(t.price),
              quantity: parseInt(t.quantity),
              occurred_at: t.occurred_at || t.matched_at,
              symbol: t.symbol,
              id: t.id
            }));
          setRunningTrades(filtered);
        }
      }
    } catch (e) {
      console.warn("Failed to fetch initial running trades", e);
    }
  };

  useEffect(() => {
    if (activeSymbol) {
      fetchCandles(activeSymbol, resolution);
      fetchRunningTradesInitial();
      
      // Set default limit price ke harga terakhir
      if (lastPrice > 0) {
        setLimitPrice(String(lastPrice));
      }
    }
  }, [activeSymbol, resolution]);

  // Efek inisialisasi default limit price jika lastPrice baru termuat
  useEffect(() => {
    if (lastPrice > 0 && !limitPrice) {
      setLimitPrice(String(lastPrice));
    }
  }, [lastPrice]);

  // Fetch data profil emiten, fundamental, & pengumuman dari proxy backend Sekuritas
  useEffect(() => {
    if (activeSymbol) {
      fetchCompany(activeSymbol);
    }
  }, [activeSymbol]);

  // --- 2. Inisialisasi Grafik Lightweight Charts ---
  useEffect(() => {
    if (!chartContainerRef.current) return;
    chartContainerRef.current.innerHTML = '';

    const width = chartContainerRef.current.clientWidth;
    const chart = createChart(chartContainerRef.current, {
      width,
      height: 380,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8B949E',
        fontSize: 11,
        fontFamily: 'monospace',
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
        mode: 0, // Normal mode
        horzLine: { visible: true, labelVisible: true },
        vertLine: { visible: true, labelVisible: true },
      },
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: '#10B981',
      downColor: '#EF4444',
      borderVisible: false,
      wickUpColor: '#10B981',
      wickDownColor: '#EF4444',
    });

    series.setData(candlesDataRef.current);
    chart.timeScale().fitContent();

    chartInstanceRef.current = chart;
    candleSeriesRef.current = series;

    const handleResize = () => {
      if (chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, []);

  // --- 3. Update Grafik & Running Trades via WebSocket Events ---
  // Kita mendengarkan perubahan pada `market.trades` dan `market.lastPrices` di store.
  
  // Real-time matched trades (Running Trades)
  useEffect(() => {
    if (market.trades.length > 0) {
      const latestTrade = market.trades[0]; // Item pertama adalah yang terbaru
      if (latestTrade && latestTrade.symbol === activeSymbol) {
        // Cek duplikasi trade ID
        setRunningTrades(prev => {
          if (prev.some(t => t.id === latestTrade.id || (t.occurred_at === latestTrade.occurred_at && t.price === latestTrade.price && t.quantity === latestTrade.quantity))) {
            return prev;
          }
          return [latestTrade, ...prev].slice(0, 15);
        });
      }
    }
  }, [market.trades, activeSymbol]);

  // Real-time candlestick updater
  useEffect(() => {
    if (!candleSeriesRef.current || lastPrice <= 0) return;

    const nowSeconds = Math.floor(Date.now() / 1000);
    let timeBucket = Math.floor(nowSeconds / 60) * 60; // default 1m atau 1s

    if (resolution === '1h') {
      timeBucket = Math.floor(nowSeconds / 3600) * 3600;
    } else if (resolution === '1d') {
      timeBucket = Math.floor(nowSeconds / 86400) * 86400;
    }

    const currentCandles = [...candlesDataRef.current];
    const lastBar = currentCandles[currentCandles.length - 1];

    let updatedBar: any;
    if (lastBar && lastBar.time === timeBucket) {
      // Update bar berjalan
      updatedBar = {
        time: timeBucket,
        open: lastBar.open,
        high: Math.max(lastBar.high, lastPrice),
        low: Math.min(lastBar.low, lastPrice),
        close: lastPrice,
        volume: lastBar.volume // volume diupdate flat atau dari data trade
      };
      currentCandles[currentCandles.length - 1] = updatedBar;
    } else {
      // Buat bar baru
      updatedBar = {
        time: timeBucket,
        open: lastPrice,
        high: lastPrice,
        low: lastPrice,
        close: lastPrice,
        volume: 0
      };
      currentCandles.push(updatedBar);
    }

    candlesDataRef.current = currentCandles;
    candleSeriesRef.current.update(updatedBar);
  }, [lastPrice, resolution]);

  // Reset grafik "1 Session" saat sesi berubah menjadi closed atau pre_open
  useEffect(() => {
    const status = market.sessionStatus;
    if (resolution === '1s' && (status === 'closed' || status === 'pre_open')) {
      // Kosongkan data lilin
      setCandlesData([]);
      candlesDataRef.current = [];
      if (candleSeriesRef.current) {
        candleSeriesRef.current.setData([]);
      }
    }
  }, [market.sessionStatus, resolution]);

  // --- 4. Perhitungan Finansial Form Transaksi ---
  const calculatedEstValue = useMemo(() => {
    const priceNum = orderType === 'market' ? lastPrice : parseFloat(limitPrice || '0');
    return priceNum * qtyLots * LOT_SIZE;
  }, [orderType, limitPrice, qtyLots, lastPrice]);

  const calculatedEstFee = useMemo(() => {
    const brokerRate = Number(tradeSide === 'BUY' ? feeSchedule?.brokerBuyRate : feeSchedule?.brokerSellRate) || 0.0015;
    const vatRate = Number(feeSchedule?.vatRate) || 0.11;
    const sellTaxRate = tradeSide === 'SELL' ? Number(feeSchedule?.sellTaxRate) || 0.001 : 0;
    
    // Fee Broker + Pajak Jual (jika ada) + PPN 11% atas Fee Broker
    const baseFee = calculatedEstValue * (brokerRate + sellTaxRate);
    const vatAmount = calculatedEstValue * brokerRate * vatRate;
    return baseFee + vatAmount;
  }, [calculatedEstValue, tradeSide, feeSchedule]);

  const totalBill = useMemo(() => {
    return tradeSide === 'BUY' ? calculatedEstValue + calculatedEstFee : calculatedEstValue - calculatedEstFee;
  }, [calculatedEstValue, calculatedEstFee, tradeSide]);

  const ownedQtyLots = useMemo(() => {
    const pos = portfolio?.positions?.find(p => p.symbol === activeSymbol);
    if (!pos) return 0;
    return pos.available / LOT_SIZE;
  }, [portfolio?.positions, activeSymbol]);

  // --- 5. Order Action Handlers ---
  const handleExecuteTrade = async () => {
    if (orderActionLoading) return;
    const priceVal = orderType === 'market' ? undefined : Number(limitPrice);
    const sharesQty = qtyLots * LOT_SIZE;

    if (orderType === 'limit' && (!priceVal || priceVal <= 0 || !Number.isInteger(priceVal))) {
      showToast('Masukkan harga limit rupiah bulat yang valid', 'error');
      return;
    }

    if (tradeSide === 'BUY' && totalBill > buyingPower) {
      showToast('Buying Power RDN Anda tidak mencukupi untuk order ini', 'error');
      return;
    }

    if (tradeSide === 'SELL' && qtyLots > ownedQtyLots) {
      showToast(`Kepemilikan saham ${activeSymbol} Anda tidak mencukupi (${ownedQtyLots} Lot)`, 'error');
      return;
    }

    setOrderActionLoading(true);
    try {
      const res = await placeOrder(
        activeSymbol,
        tradeSide.toLowerCase() as 'buy' | 'sell',
        priceVal,
        sharesQty,
        orderType
      );

      if (res?.deferred) {
        showToast(`Order Beli ${activeSymbol} dikirim ke antrean deferred`, 'success');
      } else {
        showToast(`Order ${tradeSide} ${activeSymbol} sebanyak ${qtyLots} Lot sukses terkirim!`, 'success');
      }

      fetchOrders();
      fetchPortfolio();
    } catch (err: any) {
      showToast(`Gagal mengirimkan order: ${err.message}`, 'error');
    } finally {
      setOrderActionLoading(false);
    }
  };

  const handleCancelOrder = async (orderId: string) => {
    if (confirm("Apakah Anda yakin ingin membatalkan order ini?")) {
      try {
        await cancelOrder(orderId);
        showToast("Permintaan pembatalan order terkirim!", "success");
        fetchOrders();
        fetchPortfolio();
      } catch (err: any) {
        showToast(`Gagal membatalkan order: ${err.message}`, "error");
      }
    }
  };

  const handleAmendOrder = async (order: any) => {
    const newPriceStr = prompt('Masukkan harga baru (Rupiah):', String(order.price));
    if (newPriceStr === null) return;
    const newQtyStr = prompt('Masukkan total kuantitas baru (LOT):', String(order.original_quantity / LOT_SIZE));
    if (newQtyStr === null) return;

    const price = Number(newPriceStr);
    const quantity = Number(newQtyStr) * LOT_SIZE;

    if (!Number.isInteger(price) || !Number.isInteger(quantity) || price <= 0 || quantity <= 0) {
      alert(`Harga dan Kuantitas harus berupa bilangan bulat positif.`);
      return;
    }

    try {
      await amendOrder(order.id, { price, quantity });
      showToast('Permintaan perubahan order sukses terkirim!', 'success');
      fetchOrders();
      fetchPortfolio();
    } catch (err: any) {
      showToast(`Gagal mengubah order: ${err.message}`, 'error');
    }
  };

  // --- 6. Formulasi Data Order Book (Depth) ---
  const activeDepth = useMemo(() => {
    const depth = market.depth[activeSymbol] || { bids: [], asks: [] };
    
    // Sort asks (terendah ke tertinggi)
    const sortedAsks = [...depth.asks].sort((a, b) => b.price - a.price).slice(-5); // Ambil 5 terendah
    // Sort bids (tertinggi ke terendah)
    const sortedBids = [...depth.bids].sort((a, b) => b.price - a.price).slice(0, 5); // Ambil 5 tertinggi

    // Hitung max volume untuk scaling horizontal bar visualizer
    const allLevels = [...sortedAsks, ...sortedBids];
    const maxQty = allLevels.reduce((max, lvl) => Math.max(max, lvl.quantity || lvl.qty || 0), 1);

    return {
      asks: sortedAsks,
      bids: sortedBids,
      maxQty
    };
  }, [market.depth, activeSymbol]);

  // Spread (Selisih Harga Bid-Ask Terbaik)
  const marketSpread = useMemo(() => {
    const bestBid = activeDepth.bids[0]?.price || 0;
    const bestAsk = activeDepth.asks[activeDepth.asks.length - 1]?.price || 0;
    if (bestBid > 0 && bestAsk > 0) {
      return bestAsk - bestBid;
    }
    return 0;
  }, [activeDepth]);

  // Filter Antrean Order Aktif Milik User untuk Saham Ini
  const userStockOrders = useMemo(() => {
    return orders
      .filter(o => o.symbol === activeSymbol)
      .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
  }, [orders, activeSymbol]);

  const normalizeStatus = (status: string) => (status || '').toLowerCase();
  const formatStatus = (status: string) => normalizeStatus(status).replace(/_/g, ' ').toUpperCase();

  const isSuspended = activeSecurity?.tradingStatus === 'suspended' || activeSecurity?.trading_status === 'suspended' || market.suspendedSymbols.includes(activeSymbol);
  const hasSessionStatus = Boolean(normalizeSessionStatus(market.sessionStatus));
  const isMarketOpen = isOrderEntrySessionStatus(market.sessionStatus);
  const sessionStatusColor = isMarketOpen ? '#10B981' : (hasSessionStatus ? '#EF4444' : '#F59E0B');
  const closedButtonLabel = hasSessionStatus ? 'PASAR TUTUP' : 'MENUNGGU STATUS PASAR';

  return (
    <div className="market-detail-premium-container animate-fade-in">
      <style>{`
        .market-detail-premium-container {
          max-width: 80rem;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          padding-bottom: 3rem;
          font-family: inherit;
        }

        /* Top Header Card */
        .detail-header-card {
          background: linear-gradient(135deg, #0F172A 0%, #020617 100%);
          border: 1px solid #1E293B;
          border-radius: 12px;
          padding: 1.25rem 1.5rem;
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1.5rem;
        }

        .btn-back-link {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #1E293B;
          border: 1px solid #334155;
          color: #94A3B8;
          font-size: 11px;
          font-weight: 700;
          padding: 0.5rem 0.85rem;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          text-transform: uppercase;
        }
        .btn-back-link:hover {
          background: #334155;
          color: #FFFFFF;
          border-color: #475569;
        }

        .price-badge-green {
          color: #10B981;
          background: rgba(16, 185, 129, 0.08);
          border: 1px solid rgba(16, 185, 129, 0.2);
          padding: 3px 8px;
          border-radius: 4px;
          font-weight: 800;
          font-size: 12px;
        }
        .price-badge-red {
          color: #EF4444;
          background: rgba(239, 68, 68, 0.08);
          border: 1px solid rgba(239, 68, 68, 0.2);
          padding: 3px 8px;
          border-radius: 4px;
          font-weight: 800;
          font-size: 12px;
        }

        /* Main Workspace Grid */
        .detail-workspace-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 1.5rem;
        }

        @media (max-width: 1024px) {
          .detail-workspace-grid {
            grid-template-columns: 1fr;
            gap: 1.25rem;
          }
        }

        .chart-main-col {
          grid-column: span 8 / span 8;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        .orderbook-sidebar-col {
          grid-column: span 4 / span 4;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }

        @media (max-width: 1024px) {
          .chart-main-col, .orderbook-sidebar-col {
            grid-column: span 12 / span 12;
          }
        }

        /* Card Isometric */
        .card-premium-dark {
          background-color: #0D1117;
          border: 1px solid #21262D;
          border-radius: 12px;
          padding: 1.25rem;
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }

        .card-title-label {
          font-size: 12px;
          font-weight: 800;
          text-transform: uppercase;
          color: #FFFFFF;
          margin: 0;
          letter-spacing: 0.05em;
          display: flex;
          align-items: center;
          gap: 8px;
        }

        /* Selector Resolution */
        .resolution-bar {
          display: flex;
          background-color: #161B22;
          border: 1px solid #30363D;
          padding: 2.5px;
          border-radius: 8px;
          width: fit-content;
        }
        .resolution-btn {
          background: transparent;
          border: none;
          color: #8B949E;
          font-size: 11px;
          font-weight: 700;
          font-family: monospace;
          padding: 4px 12px;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .resolution-btn.active {
          background-color: #21262D;
          color: #FFFFFF;
        }

        /* Order Book Table */
        .orderbook-panel {
          font-family: monospace;
          font-size: 12px;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .ob-header-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          color: #8B949E;
          font-size: 10px;
          text-transform: uppercase;
          font-weight: 700;
          padding-bottom: 6px;
          border-bottom: 1px solid #21262D;
        }
        .ob-level-row {
          position: relative;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          padding: 6.5px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.01);
          z-index: 1;
        }
        .ob-bar-bg-ask {
          position: absolute;
          right: 0;
          top: 2px;
          bottom: 2px;
          background: rgba(239, 68, 68, 0.06);
          border-right: 2px solid rgba(239, 68, 68, 0.3);
          z-index: -1;
          transition: width 0.3s ease;
        }
        .ob-bar-bg-bid {
          position: absolute;
          right: 0;
          top: 2px;
          bottom: 2px;
          background: rgba(16, 185, 129, 0.06);
          border-right: 2px solid rgba(16, 185, 129, 0.3);
          z-index: -1;
          transition: width 0.3s ease;
        }
        .ob-spread-separator {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 6px 10px;
          background-color: #161B22;
          border: 1px solid #21262D;
          border-radius: 6px;
          margin: 6px 0;
          font-size: 11px;
          color: #8B949E;
          font-weight: 700;
        }

        /* Order Entry */
        .oe-side-select {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          background-color: #161B22;
          border: 1px solid #30363D;
          padding: 3px;
          border-radius: 8px;
        }
        .oe-side-btn {
          border: none;
          padding: 7px;
          font-size: 12px;
          font-weight: 800;
          border-radius: 6px;
          cursor: pointer;
          transition: all 0.2s ease;
          text-transform: uppercase;
        }

        .oe-type-tabs {
          display: flex;
          gap: 6px;
          border-bottom: 1px solid #21262D;
          padding-bottom: 8px;
        }
        .oe-type-tab-btn {
          background: transparent;
          border: none;
          color: #8B949E;
          font-size: 11px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 4px;
          cursor: pointer;
        }
        .oe-type-tab-btn.active {
          background-color: #21262D;
          color: #FFFFFF;
        }

        .oe-input-box {
          background-color: #0D1117;
          border: 1px solid #21262D;
          border-radius: 8px;
          padding: 8px 12px;
          display: flex;
          justify-content: space-between;
          align-items: center;
        }
        .oe-input-field {
          background: transparent;
          border: none;
          color: #FFFFFF;
          font-family: monospace;
          font-size: 14px;
          font-weight: 700;
          width: 60%;
          outline: none;
        }
        .oe-input-label {
          color: #8B949E;
          font-size: 10px;
          font-weight: 700;
          text-transform: uppercase;
        }

        .btn-qty-adj {
          background: #161B22;
          border: 1px solid #30363D;
          color: #FFFFFF;
          font-weight: 800;
          width: 26px;
          height: 26px;
          border-radius: 4px;
          cursor: pointer;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14px;
        }
        .btn-qty-adj:hover {
          background-color: #21262D;
        }

        /* User Orders Table */
        .user-orders-table-wrapper {
          overflow-x: auto;
        }
        .user-orders-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
          text-align: left;
        }
        .user-orders-table th {
          color: #8B949E;
          font-weight: 700;
          text-transform: uppercase;
          font-size: 9px;
          padding: 8px 10px;
          border-bottom: 1px solid #21262D;
        }
        .user-orders-table td {
          padding: 10px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.02);
          font-family: monospace;
        }

        /* Toast premium */
        .toast-premium {
          position: fixed;
          bottom: 24px;
          right: 24px;
          background-color: #0D1117;
          border: 1px solid #21262D;
          border-left: 4px solid #10B981;
          border-radius: 8px;
          padding: 12px 16px;
          display: flex;
          align-items: center;
          gap: 12px;
          z-index: 999;
          box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
          animation: slide-up 0.3s ease;
        }
        @keyframes slide-up {
          from { transform: translateY(20px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }

        /* Tab Menu Premium */
        .tabs-header {
          display: flex;
          border-bottom: 1px solid #21262D;
          gap: 0.5rem;
          margin-bottom: 1.25rem;
        }
        .tab-trigger {
          background: transparent;
          border: none;
          color: #8B949E;
          font-size: 12px;
          font-weight: 800;
          padding: 10px 16px;
          cursor: pointer;
          position: relative;
          display: inline-flex;
          align-items: center;
          gap: 8px;
          transition: all 0.2s ease;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .tab-trigger:hover {
          color: #FFFFFF;
        }
        .tab-trigger.active {
          color: #38BDF8;
        }
        .tab-trigger.active::after {
          content: '';
          position: absolute;
          bottom: -1px;
          left: 0;
          right: 0;
          height: 2px;
          background-color: #38BDF8;
          border-radius: 2px;
          box-shadow: 0 0 8px rgba(56, 189, 248, 0.6);
        }

        /* Fundamental Tab CSS */
        .fundamental-wrapper {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          color: #C9D1D9;
        }
        .issuer-profile-card {
          background-color: #161B22;
          border: 1px solid #21262D;
          border-radius: 8px;
          padding: 1rem;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 1.25rem;
        }
        @media (max-width: 768px) {
          .issuer-profile-card {
            grid-template-columns: 1fr;
            gap: 0.75rem;
          }
        }
        .profile-item {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .profile-label {
          font-size: 10px;
          color: #8B949E;
          text-transform: uppercase;
          font-weight: 700;
        }
        .profile-val {
          font-size: 13px;
          color: #FFFFFF;
          font-weight: 600;
        }

        .fundamental-grid {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 1rem;
        }
        @media (max-width: 1024px) {
          .fundamental-grid {
            grid-template-columns: repeat(2, 1fr);
          }
        }
        @media (max-width: 480px) {
          .fundamental-grid {
            grid-template-columns: 1fr;
          }
        }
        .ratio-card {
          background-color: #161B22;
          border: 1px solid #21262D;
          border-radius: 8px;
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .ratio-label {
          font-size: 10px;
          color: #8B949E;
          text-transform: uppercase;
          font-weight: 700;
        }
        .ratio-value {
          font-size: 16px;
          font-weight: 900;
          color: #FFFFFF;
          font-family: monospace;
        }

        .financial-table-wrapper {
          overflow-x: auto;
          border: 1px solid #21262D;
          border-radius: 8px;
        }
        .financial-table {
          width: 100%;
          border-collapse: collapse;
          font-size: 11px;
          text-align: left;
        }
        .financial-table th {
          color: #8B949E;
          font-weight: 700;
          padding: 8px 12px;
          border-bottom: 1px solid #21262D;
          background-color: #161B22;
          text-transform: uppercase;
          font-size: 9px;
        }
        .financial-table td {
          padding: 10px 12px;
          border-bottom: 1px solid rgba(255, 255, 255, 0.02);
          font-family: monospace;
        }
        .financial-table tbody tr:hover {
          background-color: rgba(255, 255, 255, 0.01);
        }

        /* Announcements Tab CSS */
        .announcements-list {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .announcement-item {
          border: 1px solid #21262D;
          background-color: #161B22;
          border-radius: 8px;
          padding: 1rem;
          display: flex;
          flex-direction: column;
          gap: 8px;
          transition: all 0.2s ease;
        }
        .announcement-item:hover {
          border-color: #30363D;
          background-color: #1a202c;
        }
        .announcement-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }
        .announcement-title-bar {
          display: flex;
          align-items: center;
          gap: 10px;
          flex: 1;
        }
        .announcement-title {
          font-size: 13px;
          font-weight: 700;
          color: #FFFFFF;
          margin: 0;
        }
        .announcement-badge {
          font-size: 9px;
          font-weight: bold;
          text-transform: uppercase;
          padding: 3px 8px;
          border-radius: 4px;
          white-space: nowrap;
        }
        .badge-corp-action {
          background-color: rgba(245, 158, 11, 0.15);
          color: #F59E0B;
          border: 1px solid rgba(245, 158, 11, 0.25);
        }
        .badge-fin-report {
          background-color: rgba(16, 185, 129, 0.15);
          color: #10B981;
          border: 1px solid rgba(16, 185, 129, 0.25);
        }
        .badge-ipo {
          background-color: rgba(59, 130, 246, 0.15);
          color: #3B82F6;
          border: 1px solid rgba(59, 130, 246, 0.25);
        }
        .badge-general {
          background-color: rgba(139, 148, 158, 0.15);
          color: #8B949E;
          border: 1px solid rgba(139, 148, 158, 0.25);
        }
        .announcement-date {
          font-size: 11px;
          color: #8B949E;
          font-family: monospace;
          white-space: nowrap;
        }
        .announcement-body {
          font-size: 12px;
          color: #C9D1D9;
          line-height: 1.5;
          white-space: pre-wrap;
          border-top: 1px dashed #21262D;
          padding-top: 8px;
          margin-top: 4px;
        }
        .btn-toggle-announcement {
          background: transparent;
          border: none;
          color: #38BDF8;
          font-size: 11px;
          font-weight: 700;
          cursor: pointer;
          padding: 0;
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .btn-toggle-announcement:hover {
          text-decoration: underline;
        }
      `}</style>

      {/* TOAST POPUP */}
      {toast && (
        <div 
          className="toast-premium"
          style={{ borderLeftColor: toast.type === 'success' ? '#10B981' : '#EF4444' }}
        >
          {toast.type === 'success' ? <CheckCircle size={16} className="text-[#10B981]" /> : <AlertCircle size={16} className="text-[#EF4444]" />}
          <div style={{ flex: 1 }}>
            <p style={{ margin: 0, fontSize: '11px', color: '#FFFFFF', fontWeight: 'bold' }}>{toast.message}</p>
          </div>
          <button 
            onClick={() => setToast(null)} 
            style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: '#8B949E', fontWeight: 'bold' }}
          >
            ✕
          </button>
        </div>
      )}

      {/* --- 1. HEADER EMITEN --- */}
      <div className="detail-header-card">
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
          <button onClick={() => navigate('/market')} className="btn-back-link">
            <ArrowLeft size={13} />
            Daftar Saham
          </button>

          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <h2 style={{ fontSize: '22px', fontWeight: 900, color: '#FFFFFF', margin: 0 }}>{activeSymbol}</h2>
              <span className="text-xs font-semibold py-0.5 px-2.5 rounded-full bg-[#1E293B] text-slate-300">
                {(activeSecurity as any)?.board?.toUpperCase() || 'MAIN BOARD'}
              </span>
            </div>
            <p style={{ fontSize: '11px', color: '#8B949E', margin: '4px 0 0 0' }}>
              {activeSecurity?.name || 'Mandala Emiten Simulasi'} | Sektor: {(activeSecurity as any)?.sector || 'N/A'}
            </p>
          </div>
        </div>

        {/* Info Harga Kanan */}
        <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem', textAlign: 'right' }}>
          <div>
            <span style={{ fontSize: '10px', color: '#8B949E', display: 'block', textTransform: 'uppercase', fontWeight: 700 }}>Harga Terakhir</span>
            <span style={{ fontSize: '20px', fontWeight: 900, color: '#FFFFFF', fontFamily: 'monospace' }}>
              Rp {lastPrice.toLocaleString('id-ID')}
            </span>
          </div>

          <div>
            <span style={{ fontSize: '10px', color: '#8B949E', display: 'block', textTransform: 'uppercase', fontWeight: 700 }}>Perubahan</span>
            <span className={isGainer ? "price-badge-green" : "price-badge-red"}>
              {isGainer ? '+' : ''}{priceChange.toLocaleString('id-ID')} ({isGainer ? '+' : ''}{priceChangePercent.toFixed(2)}%)
            </span>
          </div>

          {/* Sesi status */}
          <div 
            style={{ 
              backgroundColor: isMarketOpen ? 'rgba(16, 185, 129, 0.08)' : (hasSessionStatus ? 'rgba(239, 68, 68, 0.08)' : 'rgba(245, 158, 11, 0.08)'),
              border: isMarketOpen ? '1px solid rgba(16, 185, 129, 0.2)' : (hasSessionStatus ? '1px solid rgba(239, 68, 68, 0.2)' : '1px solid rgba(245, 158, 11, 0.2)'),
              padding: '6px 12px',
              borderRadius: '8px',
              fontSize: '10px',
              fontWeight: 800,
              color: sessionStatusColor,
              textTransform: 'uppercase',
              letterSpacing: '0.05em'
            }}
          >
            {formatMarketSessionLabel(market.sessionStatus)}
          </div>
        </div>
      </div>

      {/* --- 2. WORKSPACE GRID --- */}
      <div className="detail-workspace-grid">
        
        {/* KOLOM KIRI (CHART & RUNNING TRADES) */}
        <div className="chart-main-col">
          
          {/* Box Grafik */}
          <div className="card-premium-dark" style={{ minHeight: '440px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span className="card-title-label">
                <Activity size={14} className="text-primary" />
                Grafik Pergerakan Candlestick (BEI Riil)
              </span>

              {/* Resolution Bar */}
              <div className="resolution-bar">
                <button 
                  onClick={() => setResolution('1s')} 
                  className={`resolution-btn ${resolution === '1s' ? 'active' : ''}`}
                  title="Grafik Intraday Sesi Berjalan (Akan Reset Tiap Sesi Baru)"
                >
                  1 SESS
                </button>
                <button 
                  onClick={() => setResolution('1m')} 
                  className={`resolution-btn ${resolution === '1m' ? 'active' : ''}`}
                >
                  1 MENIT
                </button>
                <button 
                  onClick={() => setResolution('1h')} 
                  className={`resolution-btn ${resolution === '1h' ? 'active' : ''}`}
                >
                  1 JAM
                </button>
                <button 
                  onClick={() => setResolution('1d')} 
                  className={`resolution-btn ${resolution === '1d' ? 'active' : ''}`}
                >
                  1 HARI
                </button>
              </div>
            </div>

            {/* Container Chart */}
            <div style={{ position: 'relative', width: '100%', flex: 1 }}>
              {chartLoading && (
                <div style={{ 
                  position: 'absolute', inset: 0, background: 'rgba(13, 17, 23, 0.7)', 
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '12px', color: '#8B949E',
                  zIndex: 2, borderRadius: '8px'
                }}>
                  Memuat data transaksi bursa...
                </div>
              )}
              {candlesData.length === 0 && !chartLoading && (
                <div style={{ 
                  position: 'absolute', inset: 0, 
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', 
                  fontSize: '12px', color: '#8B949E', zIndex: 1, gap: '8px'
                }}>
                  <AlertCircle size={20} className="text-slate-500" />
                  Belum ada transaksi terjadi di database BEI untuk resolusi/sesi ini.
                </div>
              )}
              <div ref={chartContainerRef} style={{ width: '100%' }}></div>
            </div>
          </div>

          {/* Running Trades */}
          <div className="card-premium-dark">
            <span className="card-title-label">
              <Clock size={14} className="text-primary" />
              Running Trades (Matched Orders Real-time)
            </span>

            <div style={{ overflowY: 'auto', maxHeight: '180px' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '11px', textAlign: 'left' }} className="font-mono">
                <thead>
                  <tr style={{ borderBottom: '1px solid #21262D', color: '#8B949E' }}>
                    <th style={{ padding: '6px 8px', fontWeight: 600 }}>Waktu</th>
                    <th style={{ padding: '6px 8px', fontWeight: 600 }}>Kode</th>
                    <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Harga</th>
                    <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Volume (Lot)</th>
                    <th style={{ padding: '6px 8px', fontWeight: 600, textAlign: 'right' }}>Total Transaksi</th>
                  </tr>
                </thead>
                <tbody>
                  {runningTrades.length > 0 ? (
                    runningTrades.map((t, idx) => {
                      const value = t.price * t.quantity;
                      return (
                        <tr key={t.id || idx} style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.01)' }}>
                          <td style={{ padding: '6px 8px', color: '#8B949E' }}>
                            {t.occurred_at ? new Date(t.occurred_at).toLocaleTimeString('id-ID') : 'Realtime'}
                          </td>
                          <td style={{ padding: '6px 8px', fontWeight: 'bold', color: '#FFFFFF' }}>{activeSymbol}</td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', fontWeight: 'bold', color: '#FFFFFF' }}>
                            Rp {t.price.toLocaleString('id-ID')}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#F59E0B' }}>
                            {(t.quantity / LOT_SIZE).toLocaleString('id-ID')}
                          </td>
                          <td style={{ padding: '6px 8px', textAlign: 'right', color: '#8B949E' }}>
                            Rp {value.toLocaleString('id-ID')}
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={5} style={{ padding: '24px 0', textAlign: 'center', color: '#8B949E' }}>
                        Menunggu transaksi pasar berikutnya...
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

        </div>

        {/* KOLOM KANAN (ORDER BOOK & ORDER ENTRY) */}
        <div className="orderbook-sidebar-col">
          
          {/* Order Book */}
          <div className="card-premium-dark">
            <span className="card-title-label">
              <Layers size={14} className="text-primary" />
              Order Book (Kedalaman Antrean)
            </span>

            {isSuspended && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px', padding: '10px', fontSize: '11px', color: '#EF4444', display: 'flex', gap: '8px'
              }}>
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>Saham disuspensi. Antrean orderbook terkunci.</span>
              </div>
            )}

            <div className="orderbook-panel">
              <div className="ob-header-row">
                <span>Vol Beli (Lot)</span>
                <span style={{ textAlign: 'center' }}>Harga</span>
                <span style={{ textAlign: 'right' }}>Vol Jual (Lot)</span>
              </div>

              {/* ASKS (Penawaran Jual - Asks Terendah di Bawah) */}
              {[...activeDepth.asks].reverse().map((ask, idx) => {
                const volLot = (ask.quantity || ask.qty || 0) / LOT_SIZE;
                const widthPercent = activeDepth.maxQty > 0 ? ((ask.quantity || ask.qty || 0) / activeDepth.maxQty) * 100 : 0;
                return (
                  <div key={`ask-${idx}`} className="ob-level-row">
                    <div className="ob-bar-bg-ask" style={{ width: `${widthPercent}%` }}></div>
                    <span style={{ color: '#8B949E' }}>-</span>
                    <span style={{ color: '#EF4444', textAlign: 'center', fontWeight: 'bold' }}>
                      {ask.price.toLocaleString('id-ID')}
                    </span>
                    <span style={{ color: '#FFFFFF', textAlign: 'right' }}>
                      {volLot.toLocaleString('id-ID')}
                    </span>
                  </div>
                );
              })}

              {/* SPREAD BAR */}
              <div className="ob-spread-separator">
                <span>Selisih (Spread)</span>
                <span style={{ color: '#F59E0B', fontFamily: 'monospace' }}>
                  Rp {marketSpread.toLocaleString('id-ID')}
                </span>
              </div>

              {/* BIDS (Antrean Beli - Bid Tertinggi di Atas) */}
              {activeDepth.bids.map((bid, idx) => {
                const volLot = (bid.quantity || bid.qty || 0) / LOT_SIZE;
                const widthPercent = activeDepth.maxQty > 0 ? ((bid.quantity || bid.qty || 0) / activeDepth.maxQty) * 100 : 0;
                return (
                  <div key={`bid-${idx}`} className="ob-level-row">
                    <div className="ob-bar-bg-bid" style={{ width: `${widthPercent}%` }}></div>
                    <span style={{ color: '#FFFFFF' }}>{volLot.toLocaleString('id-ID')}</span>
                    <span style={{ color: '#10B981', textAlign: 'center', fontWeight: 'bold' }}>
                      {bid.price.toLocaleString('id-ID')}
                    </span>
                    <span style={{ color: '#8B949E', textAlign: 'right' }}>-</span>
                  </div>
                );
              })}

              {activeDepth.asks.length === 0 && activeDepth.bids.length === 0 && (
                <div style={{ padding: '20px 0', textAlign: 'center', color: '#8B949E', fontSize: '11px' }}>
                  Antrean kosong (Sesi perdagangan closed / belum ada order).
                </div>
              )}
            </div>
          </div>

          {/* Order Entry */}
          <div className="card-premium-dark">
            <span className="card-title-label">
              <Wallet size={14} className="text-primary" />
              Order Entry Console
            </span>

            {/* Toggle Side Beli / Jual */}
            <div className="oe-side-select">
              <button 
                type="button" 
                onClick={() => setTradeSide('BUY')}
                className="oe-side-btn"
                style={{
                  backgroundColor: tradeSide === 'BUY' ? '#10B981' : 'transparent',
                  color: tradeSide === 'BUY' ? '#FFFFFF' : '#8B949E'
                }}
              >
                BELI (BUY)
              </button>
              <button 
                type="button" 
                onClick={() => setTradeSide('SELL')}
                className="oe-side-btn"
                style={{
                  backgroundColor: tradeSide === 'SELL' ? '#EF4444' : 'transparent',
                  color: tradeSide === 'SELL' ? '#FFFFFF' : '#8B949E'
                }}
              >
                JUAL (SELL)
              </button>
            </div>

            {/* Segmented Control Order Type */}
            <div className="oe-type-tabs">
              <button 
                type="button" 
                onClick={() => setOrderType('limit')}
                className={`oe-type-tab-btn ${orderType === 'limit' ? 'active' : ''}`}
              >
                LIMIT
              </button>
              <button 
                type="button" 
                onClick={() => setOrderType('market')}
                className={`oe-type-tab-btn ${orderType === 'market' ? 'active' : ''}`}
              >
                MARKET
              </button>
            </div>

            {/* RDN info & Kepemilikan */}
            <div style={{ backgroundColor: '#161B22', border: '1px solid #21262D', borderRadius: '8px', padding: '10px', fontSize: '11px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                <span style={{ color: '#8B949E' }}>RDN Buying Power:</span>
                <span style={{ color: '#FFFFFF', fontWeight: 'bold' }}>Rp {buyingPower.toLocaleString('id-ID')}</span>
              </div>
              {tradeSide === 'SELL' && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                  <span style={{ color: '#8B949E' }}>Kepemilikan Saham:</span>
                  <span style={{ color: '#FFFFFF', fontWeight: 'bold' }}>{ownedQtyLots.toLocaleString('id-ID')} Lot</span>
                </div>
              )}
              {araArbValues && (
                <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', borderTop: '1px dashed #21262D', paddingTop: '4px', marginTop: '4px' }}>
                  <span style={{ color: '#8B949E' }}>Batas ARA / ARB:</span>
                  <span style={{ fontWeight: 'bold' }}>
                    <span style={{ color: '#10B981' }}>Rp {araArbValues.ara.toLocaleString('id-ID')}</span>
                    <span style={{ color: '#8B949E' }}> / </span>
                    <span style={{ color: '#EF4444' }}>Rp {araArbValues.arb.toLocaleString('id-ID')}</span>
                  </span>
                </div>
              )}
            </div>

            {/* Input Form */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {orderType === 'limit' && (
                <div className="oe-input-box">
                  <span className="oe-input-label">Harga</span>
                  <input 
                    type="number" 
                    value={limitPrice} 
                    onChange={(e) => setLimitPrice(e.target.value)} 
                    placeholder="Harga Limit"
                    className="oe-input-field"
                    disabled={isSuspended}
                  />
                  <span className="oe-input-label" style={{ fontSize: '9px' }}>IDR</span>
                </div>
              )}

              <div className="oe-input-box">
                <span className="oe-input-label">Jumlah</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                  <button 
                    type="button" 
                    onClick={() => setQtyLots(Math.max(1, qtyLots - 1))}
                    className="btn-qty-adj"
                    disabled={isSuspended}
                  >
                    -
                  </button>
                  <input 
                    type="number" 
                    value={qtyLots} 
                    onChange={(e) => setQtyLots(Math.max(1, parseInt(e.target.value) || 1))}
                    style={{ background: 'transparent', border: 'none', color: '#FFFFFF', fontWeight: 'bold', width: '40px', textAlign: 'center', fontSize: '13px', outline: 'none' }}
                    min="1"
                    disabled={isSuspended}
                  />
                  <button 
                    type="button" 
                    onClick={() => setQtyLots(qtyLots + 1)}
                    className="btn-qty-adj"
                    disabled={isSuspended}
                  >
                    +
                  </button>
                </div>
                <span className="oe-input-label">LOT</span>
              </div>
            </div>

            {/* Summary Transaksi */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '11px', borderTop: '1px solid #21262D', paddingTop: '10px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                <span style={{ color: '#8B949E' }}>Nilai Order:</span>
                <span style={{ color: '#FFFFFF' }}>Rp {calculatedEstValue.toLocaleString('id-ID')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace' }}>
                <span style={{ color: '#8B949E' }}>Estimasi Biaya Broker:</span>
                <span style={{ color: '#FFFFFF' }}>Rp {Math.round(calculatedEstFee).toLocaleString('id-ID')}</span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontFamily: 'monospace', fontSize: '12px', fontWeight: 'bold', borderTop: '1px solid rgba(33, 38, 45, 0.4)', paddingTop: '6px' }}>
                <span style={{ color: '#FFFFFF' }}>{tradeSide === 'BUY' ? 'Total Tagihan:' : 'Total Terima:'}</span>
                <span style={{ color: '#F59E0B' }}>Rp {Math.round(totalBill).toLocaleString('id-ID')}</span>
              </div>
            </div>

            {/* Execute Button */}
            <button 
              type="button" 
              onClick={handleExecuteTrade}
              disabled={isSuspended || orderActionLoading || !isMarketOpen}
              style={{
                width: '100%', border: 'none', padding: '12px', borderRadius: '8px', 
                fontWeight: 'bold', fontSize: '12px', color: '#FFFFFF', cursor: 'pointer',
                backgroundColor: isSuspended || !isMarketOpen ? '#21262D' : (tradeSide === 'BUY' ? '#10B981' : '#EF4444'),
                transition: 'opacity 0.2s ease'
              }}
            >
              {orderActionLoading ? 'Memproses...' : (!isMarketOpen ? closedButtonLabel : `KIRIM ORDER ${tradeSide === 'BUY' ? 'BELI' : 'JUAL'}`)}
            </button>
          </div>

        </div>

      </div>

      {/* --- 3. TABBED SECTION (BAGIAN BAWAH) --- */}
      <div className="card-premium-dark">
        <div className="tabs-header">
          <button 
            onClick={() => setActiveTab('orders')} 
            className={`tab-trigger ${activeTab === 'orders' ? 'active' : ''}`}
          >
            <Activity size={14} />
            Antrean & Riwayat Order ({activeSymbol})
          </button>
          <button 
            onClick={() => setActiveTab('fundamentals')} 
            className={`tab-trigger ${activeTab === 'fundamentals' ? 'active' : ''}`}
          >
            <Building2 size={14} />
            Profil & Kinerja Fundamental
          </button>
          <button 
            onClick={() => setActiveTab('announcements')} 
            className={`tab-trigger ${activeTab === 'announcements' ? 'active' : ''}`}
          >
            <FileText size={14} />
            Pengumuman Resmi ({company.announcements?.length || 0})
          </button>
        </div>

        {/* Tab 1: Antrean & Riwayat Order */}
        {activeTab === 'orders' && (
          <div className="user-orders-table-wrapper animate-fade-in">
            <table className="user-orders-table">
              <thead>
                <tr>
                  <th>Waktu</th>
                  <th>Side</th>
                  <th>Tipe</th>
                  <th style={{ textAlign: 'right' }}>Harga Limit</th>
                  <th style={{ textAlign: 'right' }}>Kuantitas (Lot)</th>
                  <th style={{ textAlign: 'right' }}>Filled (Lot)</th>
                  <th>Status</th>
                  <th>Detail Status / Reason</th>
                  <th>Aksi</th>
                </tr>
              </thead>
              <tbody>
                {userStockOrders.length > 0 ? (
                  userStockOrders.map(o => {
                    const status = normalizeStatus(o.status);
                    const canCancel = ["accepted", "open", "amended", "partially_filled"].includes(status);
                    const canAmend = (o.order_type || "limit") !== "market" && ["accepted", "open", "amended", "partially_filled"].includes(status);
                    const sideColor = o.side === "buy" ? "text-success" : "text-danger";
                    const orderTypeStr = o.order_type || "limit";
                    
                    return (
                      <tr key={o.id}>
                        <td style={{ color: '#8B949E' }}>{new Date(o.created_at).toLocaleTimeString('id-ID')}</td>
                        <td className={sideColor} style={{ fontWeight: 'bold' }}>{o.side.toUpperCase()}</td>
                        <td>{orderTypeStr.toUpperCase()}</td>
                        <td style={{ textAlign: 'right', fontWeight: 'bold' }}>
                          {orderTypeStr === "market" ? "Market" : `Rp ${Number(o.price).toLocaleString('id-ID')}`}
                        </td>
                        <td style={{ textAlign: 'right' }}>{(o.original_quantity / LOT_SIZE).toLocaleString('id-ID')}</td>
                        <td style={{ textAlign: 'right' }}>{(o.filled_quantity / LOT_SIZE).toLocaleString('id-ID')}</td>
                        <td>
                          <span style={{ 
                            padding: '3px 8px', borderRadius: '4px', fontSize: '9px', fontWeight: 'bold',
                            background: status === 'filled' ? 'rgba(16, 185, 129, 0.15)' : (status === 'rejected' || status === 'expired' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(255,255,255,0.08)'),
                            color: status === 'filled' ? '#10B981' : (status === 'rejected' || status === 'expired' ? '#EF4444' : '#8B949E')
                          }}>
                            {formatStatus(o.status)}
                          </span>
                        </td>
                        <td style={{ color: '#8B949E', fontSize: '10px' }}>
                          {o.reject_reason || (o as any).last_action_reason || '-'}
                        </td>
                        <td>
                          <div style={{ display: 'flex', gap: '6px' }}>
                            {canAmend && (
                              <button
                                onClick={() => handleAmendOrder(o)}
                                style={{ padding: '4px', background: 'transparent', border: 'none', color: '#38BDF8', cursor: 'pointer' }}
                                title="Ubah Order (Amend)"
                              >
                                <Pencil size={14} />
                              </button>
                            )}
                            {canCancel && (
                              <button 
                                onClick={() => handleCancelOrder(o.id)}
                                style={{ padding: '4px', background: 'transparent', border: 'none', color: '#EF4444', cursor: 'pointer' }}
                                title="Batalkan Order (Cancel)"
                              >
                                <XCircle size={14} />
                              </button>
                            )}
                            {!canAmend && !canCancel && <span style={{ color: '#8B949E' }}>-</span>}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                ) : (
                  <tr>
                    <td colSpan={9} style={{ padding: '24px 0', textAlign: 'center', color: '#8B949E' }}>
                      Belum ada order untuk saham {activeSymbol} pada akun Anda.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        )}

        {/* Tab 2: Profil & Kinerja Fundamental */}
        {activeTab === 'fundamentals' && (
          <div className="fundamental-wrapper animate-fade-in">
            <div className="issuer-profile-card">
              <div className="profile-item">
                <span className="profile-label">Nama Emiten</span>
                <span className="profile-val">{company.detail?.name || company.detail?.issuer_name || activeSecurity?.name || 'Mandala Emiten'}</span>
              </div>
              <div className="profile-item">
                <span className="profile-label">Sektor</span>
                <span className="profile-val">{company.detail?.sector || (activeSecurity as any)?.sector || 'N/A'}</span>
              </div>
              <div className="profile-item">
                <span className="profile-label">Status Trading</span>
                <span className="profile-val" style={{ color: isSuspended ? '#EF4444' : '#10B981', textTransform: 'uppercase' }}>
                  {isSuspended ? 'Suspended' : 'Active'}
                </span>
              </div>
            </div>

            {company.fundamentals?.reports && company.fundamentals.reports.length > 0 ? (
              (() => {
                const latestReport = company.fundamentals.reports[0];
                const ratios = latestReport.ratios || {};
                return (
                  <>
                    <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#FFFFFF', borderBottom: '1px solid #21262D', paddingBottom: '6px' }}>
                      RASIO FINANSIAL UTAMA ({latestReport.period})
                    </div>
                    <div className="fundamental-grid">
                      <div className="ratio-card">
                        <span className="ratio-label">PER (Price to Earnings)</span>
                        <span className="ratio-value">{ratios.per ? `${Number(ratios.per).toFixed(2)}x` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">PBV (Price to Book Value)</span>
                        <span className="ratio-value">{ratios.pbv ? `${Number(ratios.pbv).toFixed(2)}x` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">ROE (Return on Equity)</span>
                        <span className="ratio-value">{ratios.roe ? `${(Number(ratios.roe) * 100).toFixed(2)}%` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">ROA (Return on Assets)</span>
                        <span className="ratio-value">{ratios.roa ? `${(Number(ratios.roa) * 100).toFixed(2)}%` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">DER (Debt to Equity)</span>
                        <span className="ratio-value">{ratios.debtToEquity ? `${(Number(ratios.debtToEquity) * 100).toFixed(2)}%` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">NPM (Net Profit Margin)</span>
                        <span className="ratio-value">{ratios.netMargin ? `${(Number(ratios.netMargin) * 100).toFixed(2)}%` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">EPS (Earning Per Share)</span>
                        <span className="ratio-value">{latestReport.eps ? `Rp ${Number(latestReport.eps).toFixed(2)}` : '-'}</span>
                      </div>
                      <div className="ratio-card">
                        <span className="ratio-label">Div. Payout Ratio</span>
                        <span className="ratio-value">{latestReport.dividend_payout ? `${(Number(latestReport.dividend_payout) * 100).toFixed(2)}%` : '-'}</span>
                      </div>
                    </div>

                    <div style={{ fontSize: '11px', fontWeight: 'bold', color: '#FFFFFF', borderBottom: '1px solid #21262D', paddingBottom: '6px', marginTop: '0.5rem' }}>
                      RINGKASAN LAPORAN KEUANGAN HISTORIS
                    </div>
                    <div className="financial-table-wrapper">
                      <table className="financial-table">
                        <thead>
                          <tr>
                            <th>Periode</th>
                            <th style={{ textAlign: 'right' }}>Pendapatan (Revenue)</th>
                            <th style={{ textAlign: 'right' }}>Laba Bersih (Net Income)</th>
                            <th style={{ textAlign: 'right' }}>Total Aset</th>
                            <th style={{ textAlign: 'right' }}>Total Liabilitas</th>
                            <th style={{ textAlign: 'right' }}>Total Ekuitas</th>
                          </tr>
                        </thead>
                        <tbody>
                          {company.fundamentals.reports.map((rep: any, idx: number) => (
                            <tr key={rep.id || idx}>
                              <td style={{ fontWeight: 'bold', color: '#FFFFFF' }}>{rep.period}</td>
                              <td style={{ textAlign: 'right', color: '#10B981' }}>{formatIDR(rep.revenue)}</td>
                              <td style={{ textAlign: 'right', color: '#38BDF8' }}>{formatIDR(rep.net_income || rep.netIncome)}</td>
                              <td style={{ textAlign: 'right' }}>{formatIDR(rep.assets)}</td>
                              <td style={{ textAlign: 'right', color: '#EF4444' }}>{formatIDR(rep.liabilities)}</td>
                              <td style={{ textAlign: 'right' }}>{formatIDR(rep.equity)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                );
              })()
            ) : (
              <div style={{ padding: '24px', textAlign: 'center', color: '#8B949E' }}>
                Data fundamental / laporan keuangan belum tersedia untuk emiten ini.
              </div>
            )}
          </div>
        )}

        {/* Tab 3: Pengumuman Resmi Emiten */}
        {activeTab === 'announcements' && (
          <div className="announcements-list animate-fade-in">
            {company.announcements && company.announcements.length > 0 ? (
              company.announcements.map((ann: any) => {
                const isExpanded = expandedAnnouncementId === ann.id;
                const dateStr = ann.publishedAt || ann.published_at;
                const formattedDate = dateStr 
                  ? new Date(dateStr).toLocaleDateString('id-ID', {
                      day: 'numeric',
                      month: 'long',
                      year: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit'
                    })
                  : '-';
                
                let badgeClass = 'badge-general';
                let typeLabel = 'Pengumuman';
                const lowerType = (ann.type || '').toLowerCase();
                if (lowerType.includes('corp') || lowerType.includes('dividend') || lowerType.includes('action')) {
                  badgeClass = 'badge-corp-action';
                  typeLabel = 'Aksi Korporasi';
                } else if (lowerType.includes('report') || lowerType.includes('fin')) {
                  badgeClass = 'badge-fin-report';
                  typeLabel = 'Laporan Keuangan';
                } else if (lowerType.includes('ipo')) {
                  badgeClass = 'badge-ipo';
                  typeLabel = 'IPO';
                }
                
                return (
                  <div key={ann.id} className="announcement-item">
                    <div className="announcement-header">
                      <div className="announcement-title-bar">
                        <span className={`announcement-badge ${badgeClass}`}>{typeLabel}</span>
                        <h4 className="announcement-title">{ann.title}</h4>
                      </div>
                      <span className="announcement-date">{formattedDate}</span>
                    </div>

                    {isExpanded ? (
                      <div className="announcement-body">
                        {ann.body}
                        <div style={{ marginTop: '8px' }}>
                          <button 
                            className="btn-toggle-announcement" 
                            onClick={() => setExpandedAnnouncementId(null)}
                          >
                            Tutup Isi Pengumuman
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <p style={{ margin: 0, fontSize: '11px', color: '#8B949E', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap', maxWidth: '80%' }}>
                          {ann.body.slice(0, 100)}...
                        </p>
                        <button 
                          className="btn-toggle-announcement" 
                          onClick={() => setExpandedAnnouncementId(ann.id)}
                        >
                          Lihat Selengkapnya
                        </button>
                      </div>
                    )}
                  </div>
                );
              })
            ) : (
              <div style={{ padding: '24px', textAlign: 'center', color: '#8B949E' }}>
                Belum ada pengumuman resmi yang diterbitkan oleh emiten {activeSymbol}.
              </div>
            )}
          </div>
        )}
      </div>

    </div>
  );
}
