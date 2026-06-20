import { useEffect, useState, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
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

const formatCompactNumber = (num: number) => {
  if (num >= 1_000_000_000) return (num / 1_000_000_000).toFixed(1) + ' B';
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + ' M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + ' K';
  return num.toLocaleString('id-ID');
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

  // Modal Popup States
  const [isOrderModalOpen, setIsOrderModalOpen] = useState(false);
  const [showSuccessOverlay, setShowSuccessOverlay] = useState(false);
  const [successOrderDetails, setSuccessOrderDetails] = useState<any>(null);
  const [sliderPercent, setSliderPercent] = useState<number>(0);

  // --- BEI Tick Size Helpers ---
  const getTickSize = (price: number): number => {
    if (price < 200) return 1;
    if (price < 500) return 2;
    if (price < 2000) return 5;
    if (price < 5000) return 10;
    return 25;
  };

  const getTickSizeForIncrement = (price: number): number => {
    if (price < 200) return 1;
    if (price < 500) return 2;
    if (price < 2000) return 5;
    if (price < 5000) return 10;
    return 25;
  };

  const getTickSizeForDecrement = (price: number): number => {
    if (price <= 200) return 1;
    if (price <= 500) return 2;
    if (price <= 2000) return 5;
    if (price <= 5000) return 10;
    return 25;
  };

  const roundDownToTick = (price: number): number => {
    const tick = getTickSize(price);
    return Math.max(1, Math.floor(price / tick) * tick);
  };

  const roundUpToTick = (price: number): number => {
    const tick = getTickSize(price);
    return Math.max(1, Math.ceil(price / tick) * tick);
  };

  const isValidTickPrice = (price: number): boolean => {
    return price > 0 && price % getTickSize(price) === 0;
  };

  const openOrderModal = (side: 'BUY' | 'SELL') => {
    setTradeSide(side);
    setOrderType('limit');
    setLimitPrice(lastPrice > 0 ? String(lastPrice) : '');
    setQtyLots(1);
    setSliderPercent(0);
    setShowSuccessOverlay(false);
    setSuccessOrderDetails(null);
    setIsOrderModalOpen(true);
  };

  const adjustPrice = (direction: 'up' | 'down') => {
    if (orderType === 'market') return;
    const currentVal = Number(limitPrice) || lastPrice || 0;
    const ara = araArbValues?.ara || 999999;
    const arb = araArbValues?.arb || 1;

    let newVal = currentVal;
    if (direction === 'up') {
      const tick = getTickSizeForIncrement(currentVal);
      newVal = roundUpToTick(currentVal + tick);
      if (newVal > ara) {
        showToast(`Harga tidak boleh melampaui batas ARA (Rp ${ara.toLocaleString('id-ID')})`, 'error');
        return;
      }
    } else {
      const tick = getTickSizeForDecrement(currentVal);
      newVal = roundDownToTick(Math.max(1, currentVal - tick));
      if (newVal < arb) {
        showToast(`Harga tidak boleh kurang dari batas ARB (Rp ${arb.toLocaleString('id-ID')})`, 'error');
        return;
      }
    }

    setLimitPrice(String(newVal));
  };

  const handlePriceChange = (val: string) => {
    const clean = val.replace(/\D/g, '');
    if (clean === '') {
      setLimitPrice('');
      return;
    }
    const parsed = parseInt(clean) || 0;
    const ara = araArbValues?.ara || 999999;

    if (parsed > ara) {
      showToast(`Harga melebihi batas ARA (Rp ${ara.toLocaleString('id-ID')})`, 'error');
      setLimitPrice(String(ara));
      return;
    }
    setLimitPrice(String(parsed));
  };

  const handleLotChange = (val: string) => {
    const clean = val.replace(/\D/g, '');
    if (clean === '') {
      setQtyLots(1);
      return;
    }
    const parsed = parseInt(clean) || 1;
    setQtyLots(Math.max(1, parsed));
  };

  const handleSliderChange = (percent: number) => {
    setSliderPercent(percent);
    if (tradeSide === 'BUY') {
      const brokerRate = Number(feeSchedule?.brokerBuyRate) || 0.0015;
      const vatRate = Number(feeSchedule?.vatRate) || 0.11;
      const effectiveFeeRate = brokerRate * (1 + vatRate);
      
      const priceNum = orderType === 'market' ? lastPrice : parseFloat(limitPrice || '0');
      if (priceNum > 0) {
        const costPerLot = priceNum * 100 * (1 + effectiveFeeRate);
        const allocatedBudget = buyingPower * (percent / 100);
        let calculatedLots = Math.floor(allocatedBudget / costPerLot);
        if (calculatedLots < 1 && percent > 0) {
          calculatedLots = 1;
        }
        setQtyLots(calculatedLots);
      }
    } else {
      if (ownedQtyLots > 0) {
        let calculatedLots = Math.floor(ownedQtyLots * (percent / 100));
        if (calculatedLots < 1 && percent > 0) {
          calculatedLots = 1;
        }
        setQtyLots(calculatedLots);
      } else {
        setQtyLots(0);
      }
    }
  };

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

    const ara = roundDownToTick(Math.floor(refPrice * (1 + araPercent)));
    const arb = roundUpToTick(Math.max(1, Math.ceil(refPrice * (1 - arbPercent))));

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
      const token = localStorage.getItem("token");
      const lastTradeRes = await fetch(`${apiBase}/portfolio/fills`, {
        headers: token ? { "Authorization": `Bearer ${token}` } : {}
      });
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
 
  // Menonaktifkan scroll pada background body saat modal transaksi terbuka
  useEffect(() => {
    if (isOrderModalOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOrderModalOpen]);

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

  const currentUsedPercentage = useMemo(() => {
    if (tradeSide === 'BUY') {
      if (buyingPower <= 0) return 0;
      const percent = (totalBill / buyingPower) * 100;
      return Math.min(100, Math.round(percent));
    } else {
      if (ownedQtyLots <= 0) return 0;
      const percent = (qtyLots / ownedQtyLots) * 100;
      return Math.min(100, Math.round(percent));
    }
  }, [tradeSide, totalBill, buyingPower, qtyLots, ownedQtyLots]);

  // --- 5. Order Action Handlers ---
  const handleExecuteTrade = async () => {
    if (orderActionLoading) return;
    const priceVal = orderType === 'market' ? undefined : Number(limitPrice);
    const sharesQty = qtyLots * LOT_SIZE;

    const ara = araArbValues?.ara || 999999;
    const arb = araArbValues?.arb || 1;

    if (orderType === 'limit') {
      if (!priceVal || priceVal <= 0 || !Number.isInteger(priceVal)) {
        showToast('Masukkan harga limit rupiah bulat yang valid', 'error');
        return;
      }
      if (!isValidTickPrice(priceVal)) {
        showToast(`Harga tidak sesuai fraksi. Tick size di harga ini adalah Rp ${getTickSize(priceVal).toLocaleString('id-ID')}`, 'error');
        return;
      }
      if (priceVal > ara) {
        showToast(`Harga limit melebihi batas ARA (Rp ${ara.toLocaleString('id-ID')})`, 'error');
        return;
      }
      if (priceVal < arb) {
        showToast(`Harga limit kurang dari batas ARB (Rp ${arb.toLocaleString('id-ID')})`, 'error');
        return;
      }
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

      // Simpan detail untuk success overlay
      setSuccessOrderDetails({
        symbol: activeSymbol,
        side: tradeSide,
        type: orderType,
        price: priceVal || lastPrice,
        qtyLots: qtyLots,
        totalBill: totalBill,
        deferred: res?.deferred || false
      });
      setShowSuccessOverlay(true);

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
    
    // Sort asks (terendah ke tertinggi) -> best ask (terendah) di indeks 0
    const sortedAsks = [...depth.asks].sort((a, b) => a.price - b.price).slice(0, 10);
    // Sort bids (tertinggi ke terendah) -> best bid (tertinggi) di indeks 0
    const sortedBids = [...depth.bids].sort((a, b) => b.price - a.price).slice(0, 10);

    // Hitung max volume masing-masing untuk scaling horizontal bar visualizer secara independen
    const maxBidQty = sortedBids.reduce((max, lvl) => Math.max(max, lvl.quantity || lvl.qty || 0), 1);
    const maxAskQty = sortedAsks.reduce((max, lvl) => Math.max(max, lvl.quantity || lvl.qty || 0), 1);

    return {
      asks: sortedAsks,
      bids: sortedBids,
      maxBidQty,
      maxAskQty
    };
  }, [market.depth, activeSymbol]);

  // Spread (Selisih Harga Bid-Ask Terbaik)
  const marketSpread = useMemo(() => {
    const bestBid = activeDepth.bids[0]?.price || 0;
    const bestAsk = activeDepth.asks[0]?.price || 0;
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

  // Hitung total volume bid dan ask (dalam Lot) dari data depth asli
  const totalBidVolume = useMemo(() => {
    const depth = market.depth[activeSymbol];
    if (!depth || !depth.bids) return 0;
    return depth.bids.reduce((sum, bid) => sum + (bid.quantity || bid.qty || 0), 0) / LOT_SIZE;
  }, [market.depth, activeSymbol]);

  const totalAskVolume = useMemo(() => {
    const depth = market.depth[activeSymbol];
    if (!depth || !depth.asks) return 0;
    return depth.asks.reduce((sum, ask) => sum + (ask.quantity || ask.qty || 0), 0) / LOT_SIZE;
  }, [market.depth, activeSymbol]);

  // Ambil summary pasar
  const activeSummary = market.summaries[activeSymbol] || null;

  // Warna dinamis untuk lastPrice, open, high, low
  const lastPriceColor = priceChange > 0 ? '#10B981' : (priceChange < 0 ? '#EF4444' : '#F59E0B');
  const openPrice = activeSummary?.open || prevClose;
  const openColor = openPrice > prevClose ? '#10B981' : (openPrice < prevClose ? '#EF4444' : '#F59E0B');
  const highPrice = activeSummary?.high || prevClose;
  const highColor = highPrice > prevClose ? '#10B981' : (highPrice < prevClose ? '#EF4444' : '#F59E0B');
  const lowPrice = activeSummary?.low || prevClose;
  const lowColor = lowPrice > prevClose ? '#10B981' : (lowPrice < prevClose ? '#EF4444' : '#F59E0B');
  const lotVolume = activeSummary?.volume ? (activeSummary.volume / 100) : 0;
  const valVolume = activeSummary?.value || 0;
  const avgPrice = activeSummary?.volume > 0 ? (activeSummary.value / activeSummary.volume) : prevClose;
  const freqValue = activeSummary?.frequency || 0;



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

        /* Orderbook Widget Premium (Reworked) */
        .orderbook-widget-premium {
          background-color: #161B22;
          border: 1px solid #21262D;
          border-radius: 12px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
          font-family: 'Inter', sans-serif;
          user-select: none;
        }

        .ob-header-info {
          padding: 12px 16px;
          border-bottom: 1px solid #21262D;
          display: flex;
          align-items: center;
          gap: 12px;
          background-color: #0D1117;
        }

        .ob-symbol-badge {
          background-color: #21262D;
          color: #FFFFFF;
          font-size: 11px;
          font-weight: 800;
          padding: 3px 8px;
          border-radius: 4px;
          letter-spacing: 0.05em;
        }

        .ob-last-label {
          font-size: 10px;
          color: #8B949E;
          font-weight: 700;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        .ob-last-price {
          font-size: 16px;
          font-weight: 800;
          font-family: monospace;
          margin-left: auto;
        }

        .ob-stats-grid {
          padding: 12px 16px;
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          background-color: #161B22;
          border-bottom: 1px solid #21262D;
        }

        .ob-stat-cell {
          display: flex;
          flex-direction: column;
          padding: 6px 8px;
          font-size: 11px;
        }

        .ob-stat-cell.border-r {
          border-right: 1px solid #21262D;
        }

        .ob-stat-cell.border-b {
          border-bottom: 1px solid #21262D;
        }

        .ob-stat-label {
          color: #8B949E;
          font-size: 10px;
          font-weight: 500;
          margin-bottom: 2px;
        }

        .ob-stat-val {
          font-weight: 700;
          font-family: monospace;
        }

        .ob-stat-val.text-warning {
          color: #F59E0B;
        }

        .ob-table-header {
          background-color: #0D1117;
          border-bottom: 1px solid #21262D;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          padding: 8px 0;
          font-size: 11px;
          font-weight: 800;
          color: #8B949E;
          text-transform: uppercase;
        }

        .ob-rows-container {
          display: flex;
          flex-direction: column;
          background-color: #161B22;
          font-size: 11px;
        }

        .ob-data-row {
          position: relative;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          padding: 6.5px 0;
          border-bottom: 1px solid rgba(255, 255, 255, 0.01);
          z-index: 1;
          align-items: center;
          transition: background-color 0.2s ease;
        }

        .ob-data-row:hover {
          background-color: rgba(255, 255, 255, 0.02);
        }

        .ob-depth-bar-bid {
          position: absolute;
          top: 0;
          bottom: 0;
          right: 50%;
          background-color: rgba(16, 185, 129, 0.08);
          z-index: -1;
          pointer-events: none;
          transition: width 0.3s ease;
        }

        .ob-depth-bar-offer {
          position: absolute;
          top: 0;
          bottom: 0;
          left: 50%;
          background-color: rgba(239, 68, 68, 0.08);
          z-index: -1;
          pointer-events: none;
          transition: width 0.3s ease;
        }

        .ob-cell {
          position: relative;
          font-family: monospace;
          z-index: 2;
          color: #FFFFFF;
        }

        .ob-cell-lot-bid {
          color: #E2E8F0;
        }

        .ob-cell-lot-ask {
          color: #E2E8F0;
        }

        .ob-col-1 {
          text-align: left;
          padding-left: 16px;
          font-variant-numeric: tabular-nums;
        }

        .ob-col-2 {
          text-align: right;
          padding-right: 36px;
          font-variant-numeric: tabular-nums;
          font-weight: bold;
        }

        .ob-col-3 {
          text-align: left;
          padding-left: 36px;
          font-variant-numeric: tabular-nums;
          font-weight: bold;
        }

        .ob-col-4 {
          text-align: right;
          padding-right: 16px;
          font-variant-numeric: tabular-nums;
        }

        .ob-empty-state {
          padding: 24px 12px;
          text-align: center;
          color: #8B949E;
          font-size: 11px;
        }

        .ob-table-footer {
          background-color: #0D1117;
          border-top: 1px solid #21262D;
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          align-items: center;
          padding: 10px 0;
          font-size: 12px;
          font-weight: 800;
          color: #FFFFFF;
          font-family: monospace;
        }

        .ob-total-label {
          color: #8B949E;
          font-size: 10px;
          font-weight: 700;
          letter-spacing: 0.1em;
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

        /* Order Modal Native Styles */
        .order-modal-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(13, 17, 23, 0.75);
          backdrop-filter: blur(8px);
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 1rem;
        }

        .order-modal-container {
          background: #161B22;
          border: 1px solid #21262D;
          width: 100%;
          max-width: 420px;
          border-radius: 24px;
          overflow: hidden;
          position: relative;
          box-shadow: 0 20px 40px rgba(0, 0, 0, 0.4);
        }

        .order-modal-content {
          padding: 1.5rem;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        .order-modal-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .order-modal-badge-classic {
          background: #21262D;
          border: 1px solid #30363D;
          color: #8B949E;
          font-size: 10px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 9999px;
          text-transform: uppercase;
        }

        .order-modal-title {
          font-size: 16px;
          font-weight: 800;
          margin: 0;
          letter-spacing: -0.02em;
        }

        .order-modal-close-btn {
          background: transparent;
          border: none;
          color: #8B949E;
          cursor: pointer;
          transition: color 0.2s;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .order-modal-close-btn:hover {
          color: #FFFFFF;
        }

        .order-modal-asset-banner {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: #0D1117;
          border: 1px solid #21262D;
          padding: 12px 16px;
          border-radius: 16px;
        }

        .asset-left {
          display: flex;
          align-items: center;
          gap: 10px;
        }

        .asset-logo {
          width: 32px;
          height: 32px;
          border-radius: 9999px;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .asset-info {
          display: flex;
          flex-direction: column;
        }

        .asset-code {
          font-weight: 800;
          color: #FFFFFF;
          font-size: 14px;
        }

        .asset-name {
          font-size: 10px;
          color: #8B949E;
        }

        .asset-price {
          font-weight: 800;
          color: #FFFFFF;
          font-size: 14px;
          text-align: right;
        }

        .asset-change {
          font-size: 10px;
          font-weight: 700;
          text-align: right;
        }

        .order-modal-tabs {
          display: flex;
          border-bottom: 1px solid #21262D;
          gap: 1.5rem;
        }

        .modal-tab-btn {
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          padding-bottom: 8px;
          font-size: 11px;
          font-weight: 700;
          color: #8B949E;
          cursor: pointer;
          transition: all 0.2s;
          letter-spacing: 0.05em;
        }
        .modal-tab-btn:hover {
          color: #FFFFFF;
        }

        .order-modal-balance-box {
          background: #0D1117;
          border: 1px solid #21262D;
          border-radius: 16px;
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }

        .balance-info-row {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 11px;
          color: #8B949E;
        }

        .balance-val {
          font-weight: 800;
          color: #FFFFFF;
          margin-left: auto;
        }

        .slider-container {
          display: flex;
          align-items: center;
          gap: 12px;
          margin-top: 4px;
        }

        .slider-wrapper {
          flex: 1;
          display: flex;
          align-items: center;
        }

        .modal-range-slider {
          -webkit-appearance: none;
          appearance: none;
          width: 100%;
          height: 20px !important;
          background: transparent !important;
          border: none !important;
          padding: 0 !important;
          margin: 0;
          outline: none;
          cursor: pointer;
        }

        .modal-range-slider::-webkit-slider-runnable-track {
          width: 100%;
          height: 6px;
          border-radius: 9999px;
          background: linear-gradient(to right, var(--slider-color) 0%, var(--slider-color) var(--slider-progress), #21262D var(--slider-progress), #21262D 100%);
        }

        .modal-range-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          appearance: none;
          width: 16px;
          height: 16px;
          border-radius: 9999px;
          background: #FFFFFF;
          border: 2px solid var(--slider-color);
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          margin-top: -5px;
          transition: transform 0.1s;
        }
        .modal-range-slider::-webkit-slider-thumb:hover {
          transform: scale(1.2);
        }

        .modal-range-slider::-moz-range-track {
          width: 100%;
          height: 6px;
          border-radius: 9999px;
          background: linear-gradient(to right, var(--slider-color) 0%, var(--slider-color) var(--slider-progress), #21262D var(--slider-progress), #21262D 100%);
        }

        .modal-range-slider::-moz-range-thumb {
          width: 16px;
          height: 16px;
          border: 2px solid var(--slider-color);
          border-radius: 9999px;
          background: #FFFFFF;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
          cursor: pointer;
        }

        .slider-percentage-text {
          font-size: 11px;
          font-weight: 800;
          color: #FFFFFF;
          width: 28px;
          text-align: right;
        }

        .quick-percent-buttons {
          display: flex;
          gap: 6px;
          justify-content: space-between;
        }

        .btn-pct-quick {
          flex: 1;
          background: #161B22;
          border: 1px solid #21262D;
          border-radius: 8px;
          padding: 6px 0;
          font-size: 10px;
          font-weight: 700;
          cursor: pointer;
          transition: all 0.2s;
        }
        .btn-pct-quick:hover {
          border-color: #30363D;
          color: #FFFFFF;
        }

        .stepper-group-fields {
          display: flex;
          flex-direction: column;
          gap: 12px;
        }

        .stepper-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
        }

        .stepper-label {
          font-size: 12px;
          font-weight: 700;
          color: #8B949E;
        }

        .stepper-control-box {
          display: flex;
          align-items: center;
          background: #0D1117;
          border: 1px solid #21262D;
          border-radius: 12px;
          height: 36px;
          width: 180px;
          overflow: hidden;
        }

        .stepper-btn {
          width: 36px;
          height: 100%;
          background: transparent;
          border: none;
          color: #8B949E;
          font-size: 14px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s, color 0.2s;
        }
        .stepper-btn:hover:not(:disabled) {
          background: #21262D;
          color: #FFFFFF;
        }
        .stepper-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }

        .stepper-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: #FFFFFF;
          font-weight: 800;
          font-size: 12px;
          text-align: center;
          width: 100%;
        }
        .stepper-input:disabled {
          color: #8B949E;
        }

        .ara-arb-readout {
          display: flex;
          justify-content: space-between;
          background: rgba(255, 255, 255, 0.02);
          border: 1px solid #21262D;
          padding: 8px 12px;
          border-radius: 10px;
        }

        .ara-arb-col {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }

        .tag-label {
          font-size: 9px;
          color: #8B949E;
          text-transform: uppercase;
          font-weight: 600;
        }

        .tag-val {
          font-size: 11px;
          font-weight: 800;
        }

        .total-investment-box {
          display: flex;
          justify-content: space-between;
          align-items: center;
          border-top: 1px solid #21262D;
          padding-top: 12px;
        }

        .investment-header {
          display: flex;
          flex-direction: column;
        }

        .investment-header .title {
          font-size: 12px;
          font-weight: 800;
          color: #FFFFFF;
        }

        .investment-header .subtitle {
          font-size: 9px;
          color: #8B949E;
        }

        .investment-value {
          font-size: 18px;
          font-weight: 800;
          color: #F59E0B;
          letter-spacing: -0.02em;
        }

        .modal-submit-btn {
          width: 100%;
          border: none;
          border-radius: 14px;
          padding: 14px 0;
          font-size: 13px;
          font-weight: 800;
          cursor: pointer;
          transition: opacity 0.2s, transform 0.1s;
        }
        .modal-submit-btn:hover:not(:disabled) {
          opacity: 0.9;
        }
        .modal-submit-btn:active:not(:disabled) {
          transform: scale(0.98);
        }
        .modal-submit-btn:disabled {
          cursor: not-allowed;
          opacity: 0.6;
        }

        .order-success-overlay {
          position: absolute;
          inset: 0;
          background: #161B22;
          z-index: 10;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          padding: 1.5rem;
          text-align: center;
        }

        .order-success-icon-wrap {
          margin-bottom: 12px;
        }

        .order-success-title {
          font-size: 16px;
          font-weight: 800;
          color: #FFFFFF;
          margin: 0 0 6px 0;
        }

        .order-success-subtitle {
          font-size: 11px;
          color: #8B949E;
          margin: 0 0 16px 0;
          line-height: 1.4;
        }

        .order-success-summary-box {
          width: 100%;
          background: #0D1117;
          border: 1px solid #21262D;
          border-radius: 16px;
          padding: 12px 16px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-bottom: 20px;
          text-align: left;
        }

        .summary-row {
          display: flex;
          justify-content: space-between;
          font-size: 11px;
        }

        .summary-label {
          color: #8B949E;
        }

        .summary-val {
          color: #FFFFFF;
          font-weight: 700;
        }

        .summary-row.total-row {
          border-top: 1px solid #21262D;
          padding-top: 8px;
          margin-top: 4px;
        }

        .btn-success-close {
          width: 100%;
          background: #21262D;
          border: 1px solid #30363D;
          color: #FFFFFF;
          border-radius: 12px;
          padding: 12px 0;
          font-size: 12px;
          font-weight: 700;
          cursor: pointer;
          transition: background 0.2s;
        }
        .btn-success-close:hover {
          background: #30363D;
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
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {isSuspended && (
              <div style={{
                backgroundColor: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)',
                borderRadius: '8px', padding: '10px', fontSize: '11px', color: '#EF4444', display: 'flex', gap: '8px'
              }}>
                <AlertTriangle size={14} style={{ flexShrink: 0 }} />
                <span>Saham disuspensi. Antrean orderbook terkunci.</span>
              </div>
            )}

            <div className="orderbook-widget-premium">
              {/* 1. Header Info Saham */}
              <div className="ob-header-info">
                <span className="ob-symbol-badge">{activeSymbol}</span>
                <span className="ob-last-label">LAST</span>
                <span className="ob-last-price" style={{ color: lastPriceColor }}>
                  {lastPrice.toLocaleString('id-ID')}
                </span>
              </div>

              {/* 2. Grid Statistik Harian */}
              <div className="ob-stats-grid">
                {/* Baris 1 */}
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">Prev</span>
                  <span className="ob-stat-val text-warning">{prevClose.toLocaleString('id-ID')}</span>
                </div>
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">Open</span>
                  <span className="ob-stat-val" style={{ color: openColor }}>{openPrice.toLocaleString('id-ID')}</span>
                </div>
                <div className="ob-stat-cell border-b">
                  <span className="ob-stat-label">Lot</span>
                  <span className="ob-stat-val text-white">{formatCompactNumber(lotVolume)}</span>
                </div>

                {/* Baris 2 */}
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">Chg</span>
                  <span className="ob-stat-val" style={{ color: lastPriceColor }}>
                    {priceChange >= 0 ? `+${priceChange.toLocaleString('id-ID')}` : priceChange.toLocaleString('id-ID')}
                  </span>
                </div>
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">High</span>
                  <span className="ob-stat-val" style={{ color: highColor }}>{highPrice.toLocaleString('id-ID')}</span>
                </div>
                <div className="ob-stat-cell border-b">
                  <span className="ob-stat-label">Val</span>
                  <span className="ob-stat-val text-white">{formatCompactNumber(valVolume)}</span>
                </div>

                {/* Baris 3 */}
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">%</span>
                  <span className="ob-stat-val" style={{ color: lastPriceColor }}>
                    {priceChangePercent >= 0 ? `+${priceChangePercent.toFixed(2)}%` : `${priceChangePercent.toFixed(2)}%`}
                  </span>
                </div>
                <div className="ob-stat-cell border-r border-b">
                  <span className="ob-stat-label">Low</span>
                  <span className="ob-stat-val" style={{ color: lowColor }}>{lowPrice.toLocaleString('id-ID')}</span>
                </div>
                <div className="ob-stat-cell border-b">
                  <span className="ob-stat-label">Avg</span>
                  <span className="ob-stat-val text-white">{avgPrice.toLocaleString('id-ID', { maximumFractionDigits: 1 })}</span>
                </div>

                {/* Baris 4 */}
                <div className="ob-stat-cell border-r">
                  <span className="ob-stat-label">Freq</span>
                  <span className="ob-stat-val text-white">{freqValue.toLocaleString('id-ID')}</span>
                </div>
                <div className="ob-stat-cell border-r">
                  <span className="ob-stat-label">ARA</span>
                  <span className="ob-stat-val text-success" style={{ color: '#10B981' }}>
                    {araArbValues ? araArbValues.ara.toLocaleString('id-ID') : '-'}
                  </span>
                </div>
                <div className="ob-stat-cell">
                  <span className="ob-stat-label">ARB</span>
                  <span className="ob-stat-val text-danger" style={{ color: '#EF4444' }}>
                    {araArbValues ? araArbValues.arb.toLocaleString('id-ID') : '-'}
                  </span>
                </div>
              </div>

              {/* 3. Tabel Header */}
              <div className="ob-table-header">
                <div className="ob-col-1">Lot</div>
                <div className="ob-col-2">Bid</div>
                <div className="ob-col-3">Offer</div>
                <div className="ob-col-4">Lot</div>
              </div>

              {/* 4. Baris Data Transaksi */}
              <div className="ob-rows-container">
                {Array.from({ length: 10 }).map((_, idx) => {
                  const bid = activeDepth.bids[idx];
                  const ask = activeDepth.asks[idx];

                  const bidVolLot = bid ? (bid.quantity || bid.qty || 0) / LOT_SIZE : null;
                  const askVolLot = ask ? (ask.quantity || ask.qty || 0) / LOT_SIZE : null;

                  const bidBarWidth = bid && activeDepth.maxBidQty > 0 
                    ? ((bid.quantity || bid.qty || 0) / activeDepth.maxBidQty) * 50 
                    : 0;
                  const askBarWidth = ask && activeDepth.maxAskQty > 0 
                    ? ((ask.quantity || ask.qty || 0) / activeDepth.maxAskQty) * 50 
                    : 0;

                  const bidPriceColor = bid 
                    ? (bid.price > prevClose ? '#10B981' : (bid.price < prevClose ? '#EF4444' : '#F59E0B'))
                    : '#FFFFFF';
                  const askPriceColor = ask 
                    ? (ask.price > prevClose ? '#10B981' : (ask.price < prevClose ? '#EF4444' : '#F59E0B'))
                    : '#FFFFFF';

                  return (
                    <div key={`ob-row-${idx}`} className="ob-data-row">
                      {/* Depth Bar Bid */}
                      {bid && (
                        <div className="ob-depth-bar-bid" style={{ width: `${bidBarWidth}%` }}></div>
                      )}
                      {/* Depth Bar Offer */}
                      {ask && (
                        <div className="ob-depth-bar-offer" style={{ width: `${askBarWidth}%` }}></div>
                      )}

                      <div className="ob-cell ob-col-1 ob-cell-lot-bid">
                        {bidVolLot !== null ? bidVolLot.toLocaleString('id-ID') : '-'}
                      </div>
                      <div className="ob-cell ob-col-2" style={{ color: bidPriceColor }}>
                        {bid ? bid.price.toLocaleString('id-ID') : '-'}
                      </div>
                      <div className="ob-cell ob-col-3" style={{ color: askPriceColor }}>
                        {ask ? ask.price.toLocaleString('id-ID') : '-'}
                      </div>
                      <div className="ob-cell ob-col-4 ob-cell-lot-ask">
                        {askVolLot !== null ? askVolLot.toLocaleString('id-ID') : '-'}
                      </div>
                    </div>
                  );
                })}

                {activeDepth.asks.length === 0 && activeDepth.bids.length === 0 && (
                  <div className="ob-empty-state">
                    Antrean kosong (Sesi perdagangan closed / belum ada order).
                  </div>
                )}
              </div>

              {/* 5. Total Rekapitulasi */}
              <div className="ob-table-footer">
                <div className="ob-col-1">{totalBidVolume.toLocaleString('id-ID')}</div>
                <div style={{ gridColumn: 'span 2', textAlign: 'center' }} className="ob-total-label">TOTAL (LOT)</div>
                <div className="ob-col-4">{totalAskVolume.toLocaleString('id-ID')}</div>
              </div>
            </div>
          </div>

          {/* Tombol Beli / Jual Modal Trigger */}
          <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
            <button 
              type="button"
              onClick={() => openOrderModal('BUY')}
              disabled={isSuspended}
              style={{
                flex: 1,
                border: 'none',
                padding: '14px',
                borderRadius: '8px', 
                fontWeight: 'bold',
                fontSize: '14px',
                color: '#FFFFFF',
                cursor: isSuspended ? 'not-allowed' : 'pointer',
                backgroundColor: isSuspended ? '#21262D' : '#10B981',
                transition: 'opacity 0.2s ease, transform 0.1s ease'
              }}
              className="oe-modal-trigger-btn"
            >
              BELI (BUY)
            </button>
            <button 
              type="button"
              onClick={() => openOrderModal('SELL')}
              disabled={isSuspended}
              style={{
                flex: 1,
                border: 'none',
                padding: '14px',
                borderRadius: '8px', 
                fontWeight: 'bold',
                fontSize: '14px',
                color: '#FFFFFF',
                cursor: isSuspended ? 'not-allowed' : 'pointer',
                backgroundColor: isSuspended ? '#21262D' : '#EF4444',
                transition: 'opacity 0.2s ease, transform 0.1s ease'
              }}
              className="oe-modal-trigger-btn"
            >
              JUAL (SELL)
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

      {/* --- MODAL POPUP ORDER ENTRY --- */}
      {isOrderModalOpen && createPortal(
        <div className="order-modal-backdrop animate-fade-in" onClick={(e) => {
          if (e.target === e.currentTarget) setIsOrderModalOpen(false);
        }}>
          <div className="order-modal-container">
            
            {/* SUCCESS OVERLAY */}
            {showSuccessOverlay && successOrderDetails && (
              <div className="order-success-overlay">
                <div className="order-success-icon-wrap">
                  <CheckCircle size={48} className="text-success animate-scale-up" />
                </div>
                <h3 className="order-success-title">Order Berhasil Dikirim</h3>
                <p className="order-success-subtitle">
                  {successOrderDetails.deferred 
                    ? `Instruksi order ${successOrderDetails.side} ${successOrderDetails.symbol} telah dikirim ke antrean deferred (bursa belum buka).`
                    : `Instruksi order ${successOrderDetails.side} ${successOrderDetails.symbol} Anda telah masuk ke sistem antrean.`
                  }
                </p>
                
                <div className="order-success-summary-box">
                  <div className="summary-row">
                    <span className="summary-label">Tipe Order</span>
                    <span className="summary-val">{successOrderDetails.type.toUpperCase()}</span>
                  </div>
                  <div className="summary-row">
                    <span className="summary-label">Saham</span>
                    <span className="summary-val">{successOrderDetails.symbol} ({activeSecurity?.name || 'Sekuritas Asset'})</span>
                  </div>
                  <div className="summary-row">
                    <span className="summary-label">Harga Saham</span>
                    <span className="summary-val">
                      {successOrderDetails.type === 'market' ? 'Market Price' : `Rp ${successOrderDetails.price.toLocaleString('id-ID')}`}
                    </span>
                  </div>
                  <div className="summary-row">
                    <span className="summary-label">Jumlah Order</span>
                    <span className="summary-val">{successOrderDetails.qtyLots.toLocaleString('id-ID')} Lot ({ (successOrderDetails.qtyLots * 100).toLocaleString('id-ID') } Lembar)</span>
                  </div>
                  <div className="summary-row total-row">
                    <span className="summary-label font-bold">Total {successOrderDetails.side === 'BUY' ? 'Investasi' : 'Penerimaan'}</span>
                    <span className="summary-val text-warning font-bold">Rp {Math.round(successOrderDetails.totalBill).toLocaleString('id-ID')}</span>
                  </div>
                </div>
                
                <button 
                  type="button"
                  onClick={() => {
                    setIsOrderModalOpen(false);
                    setShowSuccessOverlay(false);
                  }} 
                  className="btn-success-close"
                >
                  Tutup
                </button>
              </div>
            )}

            {/* MODAL MAIN CONTENT */}
            <div className="order-modal-content">
              {/* HEADER ROW */}
              <div className="order-modal-header">
                {/* Classic / Advanced Indicator */}
                <div className="order-modal-badge-classic">
                  Classic
                </div>

                {/* Title Beli / Jual */}
                <h2 className="order-modal-title" style={{ color: tradeSide === 'BUY' ? '#10B981' : '#EF4444' }}>
                  {tradeSide === 'BUY' ? 'Buy' : 'Sell'} Order
                </h2>

                {/* Close Button */}
                <button 
                  type="button"
                  className="order-modal-close-btn" 
                  onClick={() => setIsOrderModalOpen(false)}
                >
                  <XCircle size={20} />
                </button>
              </div>

              {/* ASSET BANNER */}
              <div className="order-modal-asset-banner">
                <div className="asset-left">
                  {/* Logo Mockup */}
                  <div className="asset-logo" style={{ backgroundColor: tradeSide === 'BUY' ? '#10B981' : '#EF4444', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span className="font-extrabold text-sm text-white">{activeSymbol.slice(0, 2)}</span>
                  </div>
                  <div className="asset-info">
                    <div className="asset-code-row" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                      <span className="asset-code" style={{ fontWeight: 800, color: '#FFFFFF', fontSize: '14px' }}>{activeSymbol}</span>
                      <span className="asset-board-badge" style={{ fontSize: '9px', fontWeight: 700, color: '#F59E0B', background: 'rgba(245, 158, 11, 0.08)', border: '1px solid rgba(245, 158, 11, 0.2)', padding: '1px 4px', borderRadius: '4px', textTransform: 'uppercase' }}>{(activeSecurity as any)?.board || 'Main'}</span>
                    </div>
                    <span className="asset-name" style={{ fontSize: '10px', color: '#8B949E' }}>{activeSecurity?.name || 'Mandala Asset'}</span>
                  </div>
                </div>
                
                <div className="asset-right" style={{ textAlign: 'right' }}>
                  <div className="asset-price" style={{ fontWeight: 800, color: '#FFFFFF', fontSize: '14px' }}>{lastPrice.toLocaleString('id-ID')}</div>
                  <div className="asset-change" style={{ fontSize: '10px', fontWeight: 700, color: isGainer ? '#10B981' : '#EF4444' }}>
                    {priceChange >= 0 ? `+${priceChange.toLocaleString('id-ID')}` : priceChange.toLocaleString('id-ID')} ({priceChangePercent >= 0 ? `+${priceChangePercent.toFixed(2)}%` : `${priceChangePercent.toFixed(2)}%`})
                  </div>
                </div>
              </div>

              {/* SEGMENTED TABS (Order Type) */}
              <div className="order-modal-tabs" style={{ display: 'flex', borderBottom: '1px solid #21262D', gap: '1.5rem' }}>
                <button 
                  type="button"
                  onClick={() => setOrderType('limit')} 
                  className={`modal-tab-btn ${orderType === 'limit' ? 'active' : ''}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    paddingBottom: '8px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    letterSpacing: '0.05em',
                    color: orderType === 'limit' ? (tradeSide === 'BUY' ? '#10B981' : '#EF4444') : '#8B949E',
                    borderBottom: '2px solid',
                    borderBottomColor: orderType === 'limit' ? (tradeSide === 'BUY' ? '#10B981' : '#EF4444') : 'transparent'
                  }}
                >
                  LIMIT
                </button>
                <button 
                  type="button"
                  onClick={() => {
                    setOrderType('market');
                    setLimitPrice(String(lastPrice));
                  }} 
                  className={`modal-tab-btn ${orderType === 'market' ? 'active' : ''}`}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    paddingBottom: '8px',
                    fontSize: '11px',
                    fontWeight: 700,
                    cursor: 'pointer',
                    transition: 'all 0.2s',
                    letterSpacing: '0.05em',
                    color: orderType === 'market' ? (tradeSide === 'BUY' ? '#10B981' : '#EF4444') : '#8B949E',
                    borderBottom: '2px solid',
                    borderBottomColor: orderType === 'market' ? (tradeSide === 'BUY' ? '#10B981' : '#EF4444') : 'transparent'
                  }}
                >
                  MARKET
                </button>
              </div>

              {/* BALANCE AND SLIDER CONTROLLER */}
              <div className="order-modal-balance-box">
                <div className="balance-info-row" style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '11px', color: '#8B949E' }}>
                  <Wallet size={12} className="text-secondary" />
                  {tradeSide === 'BUY' ? (
                    <>
                      <span>Trading Power:</span>
                      <span className="balance-val" style={{ fontWeight: 800, color: '#FFFFFF', marginLeft: 'auto' }}>Rp {buyingPower.toLocaleString('id-ID')}</span>
                    </>
                  ) : (
                    <>
                      <span>Kepemilikan Saham:</span>
                      <span className="balance-val" style={{ fontWeight: 800, color: '#FFFFFF', marginLeft: 'auto' }}>{ownedQtyLots.toLocaleString('id-ID')} Lot</span>
                    </>
                  )}
                </div>

                {/* Range Slider */}
                <div className="slider-container" style={{ display: 'flex', alignItems: 'center', gap: '12px', marginTop: '4px' }}>
                  <div className="slider-wrapper" style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
                    <input 
                      type="range" 
                      min="0" 
                      max="100" 
                      value={currentUsedPercentage} 
                      onChange={(e) => handleSliderChange(Number(e.target.value))}
                      className="modal-range-slider"
                      style={{
                        ['--slider-progress' as any]: `${currentUsedPercentage}%`,
                        ['--slider-color' as any]: tradeSide === 'BUY' ? '#10B981' : '#EF4444'
                      }}
                    />
                  </div>
                  <span className="slider-percentage-text" style={{ fontSize: '11px', fontWeight: 800, color: '#FFFFFF', width: '28px', textAlign: 'right' }}>{currentUsedPercentage}%</span>
                </div>
                
                {/* Quick Percent Buttons */}
                <div className="quick-percent-buttons" style={{ display: 'flex', gap: '6px', justifyContent: 'space-between' }}>
                  {[0, 25, 50, 75, 100].map(pct => (
                    <button 
                      key={`pct-${pct}`}
                      type="button"
                      onClick={() => handleSliderChange(pct)}
                      className={`btn-pct-quick ${currentUsedPercentage === pct ? 'active' : ''}`}
                      style={{
                        flex: 1,
                        background: '#161B22',
                        border: '1px solid',
                        borderColor: currentUsedPercentage === pct ? (tradeSide === 'BUY' ? '#10B981' : '#EF4444') : '#21262D',
                        borderRadius: '8px',
                        padding: '6px 0',
                        fontSize: '10px',
                        fontWeight: 700,
                        cursor: 'pointer',
                        transition: 'all 0.2s',
                        color: currentUsedPercentage === pct ? '#FFFFFF' : '#8B949E'
                      }}
                    >
                      {pct}%
                    </button>
                  ))}
                </div>
              </div>

              {/* PRICE & LOT STEPPERS */}
              <div className="stepper-group-fields" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                {/* PRICE STEPPER */}
                <div className="stepper-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="stepper-label" style={{ fontSize: '12px', fontWeight: 700, color: '#8B949E' }}>Price</span>
                  <div className="stepper-control-box">
                    <button 
                      type="button"
                      onClick={() => adjustPrice('down')} 
                      disabled={orderType === 'market'}
                      className="stepper-btn"
                    >
                      -
                    </button>
                    <input 
                      type="text" 
                      value={orderType === 'market' ? 'Market Price' : limitPrice.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} 
                      onChange={(e) => handlePriceChange(e.target.value)}
                      disabled={orderType === 'market'}
                      className="stepper-input"
                      placeholder="0"
                    />
                    <button 
                      type="button"
                      onClick={() => adjustPrice('up')} 
                      disabled={orderType === 'market'}
                      className="stepper-btn"
                    >
                      +
                    </button>
                  </div>
                </div>

                {/* LOT STEPPER */}
                <div className="stepper-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span className="stepper-label" style={{ fontSize: '12px', fontWeight: 700, color: '#8B949E' }}>{tradeSide === 'BUY' ? 'Buy Lot' : 'Sell Lot'}</span>
                  <div className="stepper-control-box">
                    <button 
                      type="button"
                      onClick={() => setQtyLots(Math.max(1, qtyLots - 1))} 
                      className="stepper-btn"
                    >
                      -
                    </button>
                    <input 
                      type="text" 
                      value={qtyLots.toLocaleString('id-ID')} 
                      onChange={(e) => handleLotChange(e.target.value)}
                      className="stepper-input"
                      placeholder="1"
                    />
                    <button 
                      type="button"
                      onClick={() => setQtyLots(qtyLots + 1)} 
                      className="stepper-btn"
                    >
                      +
                    </button>
                  </div>
                </div>
              </div>

              {/* ARA ARB LIMIT READOUT */}
              {araArbValues && orderType === 'limit' && (
                <div className="ara-arb-readout" style={{ display: 'flex', justifyContent: 'space-between', background: 'rgba(255, 255, 255, 0.02)', border: '1px solid #21262D', padding: '8px 12px', borderRadius: '10px' }}>
                  <div className="ara-arb-col" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span className="tag-label" style={{ fontSize: '9px', color: '#8B949E', textTransform: 'uppercase', fontWeight: 600 }}>Batas ARA</span>
                    <span className="tag-val text-success" style={{ fontSize: '11px', fontWeight: 800, color: '#10B981' }}>Rp {araArbValues.ara.toLocaleString('id-ID')}</span>
                  </div>
                  <div className="ara-arb-col" style={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
                    <span className="tag-label" style={{ fontSize: '9px', color: '#8B949E', textTransform: 'uppercase', fontWeight: 600 }}>Batas ARB</span>
                    <span className="tag-val text-danger" style={{ fontSize: '11px', fontWeight: 800, color: '#EF4444' }}>Rp {araArbValues.arb.toLocaleString('id-ID')}</span>
                  </div>
                </div>
              )}

              {/* TOTAL INVESTMENT */}
              <div className="total-investment-box" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderTop: '1px solid #21262D', paddingTop: '12px' }}>
                <div className="investment-header" style={{ display: 'flex', flexDirection: 'column' }}>
                  <span className="title" style={{ fontSize: '12px', fontWeight: 800, color: '#FFFFFF' }}>Total {tradeSide === 'BUY' ? 'Investasi' : 'Penerimaan'}</span>
                  <span className="subtitle" style={{ fontSize: '9px', color: '#8B949E' }}>(Termasuk Fee Estimasi)</span>
                </div>
                <div className="investment-value" style={{ fontSize: '18px', fontWeight: 800, color: '#F59E0B', letterSpacing: '-0.02em' }}>
                  Rp {Math.round(totalBill).toLocaleString('id-ID')}
                </div>
              </div>

              {/* SUBMIT BUTTON */}
              <button 
                type="button"
                onClick={handleExecuteTrade}
                disabled={orderActionLoading || isSuspended || !isMarketOpen}
                className="modal-submit-btn"
                style={{
                  width: '100%',
                  border: 'none',
                  borderRadius: '14px',
                  padding: '14px 0',
                  fontSize: '13px',
                  fontWeight: 800,
                  cursor: (orderActionLoading || isSuspended || !isMarketOpen) ? 'not-allowed' : 'pointer',
                  backgroundColor: isSuspended || !isMarketOpen ? '#21262D' : (tradeSide === 'BUY' ? '#10B981' : '#EF4444'),
                  color: '#FFFFFF',
                  transition: 'opacity 0.2s, transform 0.1s'
                }}
              >
                {orderActionLoading ? 'Memproses...' : (!isMarketOpen ? closedButtonLabel : (tradeSide === 'BUY' ? 'Kirim Order Beli' : 'Kirim Order Jual'))}
              </button>
            </div>

          </div>
        </div>,
        document.body
      )}

    </div>
  );
}
