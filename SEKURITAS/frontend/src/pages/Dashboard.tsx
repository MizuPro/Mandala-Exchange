import { useEffect, useState, useMemo, useRef } from 'react';
import { createChart, AreaSeries } from 'lightweight-charts';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import Portfolio from '../components/Portfolio';
import { resolveMarketWsUrl } from '../config/endpoints';
import { 
  LogOut, 
  Wallet, 
  Clock, 
  Plus,
  Trash2,
  AlertTriangle,
  X
} from 'lucide-react';

const LOT_SIZE = 100;

export default function Dashboard() {
  const navigate = useNavigate();

  // --- Store States ---
  const user = useStore(state => state.user);
  const logout = useStore(state => state.logout);
  const portfolio = useStore(state => state.portfolio);
  const orders = useStore(state => state.orders);
  const securities = useStore(state => state.securities);
  const feeSchedule = useStore(state => state.feeSchedule);
  const accountProfile = useStore(state => state.accountProfile);
  const ipoEvents = useStore(state => state.ipoEvents);
  const corporateActions = useStore(state => state.corporateActions);
  const market = useStore(state => state.market);
  const error = useStore(state => state.error);
  const orderActionLoading = useStore(state => state.orderActionLoading);

  // --- Store Actions ---
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchOrders = useStore(state => state.fetchOrders);
  const fetchMarketData = useStore(state => state.fetchMarketData);
  const fetchAccountProfile = useStore(state => state.fetchAccountProfile);
  const fetchIpoEvents = useStore(state => state.fetchIpoEvents);
  const fetchCorporateActions = useStore(state => state.fetchCorporateActions);
  const placeOrder = useStore(state => state.placeOrder);
  const cancelOrder = useStore(state => state.cancelOrder);
  const applyMarketEvent = useStore(state => state.applyMarketEvent);

  // --- Local States ---
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Watchlist (persisten di localStorage)
  const [watchlist, setWatchlist] = useState<string[]>(() => {
    const saved = localStorage.getItem('mandala_watchlist');
    return saved ? JSON.parse(saved) : ['MNDL', 'NUSA', 'BARA'];
  });

  // Simulasi Offset RDN (Deposit & Withdraw lokal)
  const [localBalanceOffset, setLocalBalanceOffset] = useState<number>(() => {
    const saved = localStorage.getItem('local_rdn_offset');
    return saved ? parseFloat(saved) : 0;
  });

  // Chart Timeframe (MDX Index Simulation)
  const [chartTimeframe, setChartTimeframe] = useState<'1S' | '1m' | '1H' | '1D'>('1H');

  // Modals
  const [modalType, setModalType] = useState<'deposit' | 'withdraw' | 'trade' | null>(null);
  const [selectedStockForTrade, setSelectedStockForTrade] = useState<any>(null);
  const [tradeType, setTradeType] = useState<'BUY' | 'SELL'>('BUY');
  const [tradeOrderType, setTradeOrderType] = useState<'limit' | 'market'>('limit');
  const [tradeQty, setTradeQty] = useState<number>(1); // dalam LOT
  const [tradePrice, setTradePrice] = useState<string>(''); // string input
  const [depositAmount, setDepositAmount] = useState<string>('');
  const [withdrawAmount, setWithdrawAmount] = useState<string>('');

  // WebSocket state & references
  const socketRef = useRef<WebSocket | null>(null);
  const mountedRef = useRef(true);

  // --- Toast helper ---
  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // --- Fetch Initial Data ---
  useEffect(() => {
    fetchPortfolio();
    fetchOrders();
    fetchMarketData();
    fetchAccountProfile();
    fetchIpoEvents().catch(() => {});
    fetchCorporateActions().catch(() => {});

    const interval = setInterval(() => {
      fetchPortfolio();
      fetchOrders();
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  // --- WebSocket Connection for Market Feed ---
  useEffect(() => {
    mountedRef.current = true;
    let delay = 1000;
    const MAX_DELAY = 30000;

    function connect() {
      if (!mountedRef.current) return;
      const wsBase = resolveMarketWsUrl();
      const socket = new WebSocket(wsBase);
      socketRef.current = socket;

      socket.onmessage = (event) => {
        try {
          applyMarketEvent(JSON.parse(event.data));
        } catch {
          // Abaikan market data frame yang tidak valid
        }
      };

      socket.onopen = () => {
        delay = 1000;
      };

      socket.onerror = (err) => {
        console.error('[WS] WebSocket error', err);
        socket.close();
      };

      socket.onclose = () => {
        if (!mountedRef.current) return;
        setTimeout(() => {
          delay = Math.min(delay * 2, MAX_DELAY);
          connect();
        }, delay);
      };
    }

    connect();

    return () => {
      mountedRef.current = false;
      socketRef.current?.close();
    };
  }, [applyMarketEvent]);

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

  // --- Deposit & Withdraw Local State Handlers ---
  const handleDepositSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Masukkan jumlah deposit yang valid', 'error');
      return;
    }
    const newOffset = localBalanceOffset + amount;
    setLocalBalanceOffset(newOffset);
    localStorage.setItem('local_rdn_offset', String(newOffset));
    setDepositAmount('');
    setModalType(null);
    showToast(`Berhasil deposit Rp ${amount.toLocaleString('id-ID')} (Simulasi)`, 'success');
  };

  const handleWithdrawSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(withdrawAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Masukkan jumlah penarikan yang valid', 'error');
      return;
    }
    if (amount > buyingPower) {
      showToast('Saldo tunai (Buying Power) tidak mencukupi', 'error');
      return;
    }
    const newOffset = localBalanceOffset - amount;
    setLocalBalanceOffset(newOffset);
    localStorage.setItem('local_rdn_offset', String(newOffset));
    setWithdrawAmount('');
    setModalType(null);
    showToast(`Berhasil penarikan Rp ${amount.toLocaleString('id-ID')} (Simulasi)`, 'success');
  };

  // --- Order Placement ---
  const handleOpenTrade = (symbol: string, side: 'BUY' | 'SELL') => {
    const defaultPrice = market.lastPrices[symbol] || 0;
    setSelectedStockForTrade(symbol);
    setTradeType(side);
    setTradeQty(1);
    setTradeOrderType('limit');
    setTradePrice(defaultPrice > 0 ? String(defaultPrice) : '');
    setModalType('trade');
  };

  const executeTrade = async () => {
    if (!selectedStockForTrade) return;

    const priceValue = tradeOrderType === 'market' ? undefined : Number(tradePrice);
    const sharesQty = tradeQty * LOT_SIZE;

    if (tradeOrderType === 'limit' && (!priceValue || priceValue <= 0 || !Number.isInteger(priceValue))) {
      showToast('Masukkan harga limit yang valid', 'error');
      return;
    }

    try {
      const res = await placeOrder(
        selectedStockForTrade,
        tradeType.toLowerCase() as 'buy' | 'sell',
        priceValue,
        sharesQty,
        tradeOrderType
      );

      setModalType(null);
      
      if (res?.deferred) {
        showToast(`Order ${tradeType} ${selectedStockForTrade} terkirim ke antrean (Deferred)`, 'success');
      } else {
        showToast(`Order ${tradeType} ${selectedStockForTrade} sebanyak ${tradeQty} Lot Berhasil!`, 'success');
      }
      
      fetchPortfolio();
      fetchOrders();
    } catch (err: any) {
      showToast(`Gagal mengirim order: ${err.message}`, 'error');
    }
  };

  // --- Order Cancellation ---
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

  // --- Logout ---
  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // --- Financial Calculations (Dihubungkan ke real data) ---
  const rawCashAvailable = parseFloat(portfolio?.cash?.available || '0');
  const rawCashReserved = parseFloat(portfolio?.cash?.reserved || '0');
  const rawCashPending = parseFloat(portfolio?.cash?.pending || '0');

  // RDN final (lokal offset + backend value)
  const buyingPower = Math.max(0, rawCashAvailable + localBalanceOffset);
  const reservedCash = rawCashReserved;
  const pendingCash = rawCashPending;
  const totalCash = buyingPower + reservedCash + pendingCash;

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

  // --- Stock Calculations from securities API ---
  const processedSecurities = useMemo(() => {
    return securities.map((sec) => {
      const symbol = sec.symbol || sec.code || '';
      const name = sec.name || symbol;
      
      // Ambil previous close / reference price
      const rawSec = sec as any;
      const prevClose = parseFloat(rawSec.previous_close || rawSec.reference_price || '0');
      const lastPrice = market.lastPrices[symbol] || prevClose || 0;
      
      // Hitung perubahan persentase
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

  // Top Gainers (3 Tertinggi)
  const topGainers = useMemo(() => {
    return [...processedSecurities]
      .filter(s => s.lastPrice > 0)
      .sort((a, b) => b.change - a.change)
      .slice(0, 3);
  }, [processedSecurities]);

  // Top Losers (3 Terendah)
  const topLosers = useMemo(() => {
    return [...processedSecurities]
      .filter(s => s.lastPrice > 0)
      .sort((a, b) => a.change - b.change)
      .slice(0, 3);
  }, [processedSecurities]);

  // --- MDX Index (Mandala Composite Index) ---
  // State untuk data nyata dari backend
  const [mdxHistory, setMdxHistory] = useState<{ time: string; value: number }[]>([]);
  const [mdxCurrent, setMdxCurrent] = useState<{ value: number; baseValue: number } | null>(null);
  const [mdxLoading, setMdxLoading] = useState(false);
  const [isChartMaximized, setIsChartMaximized] = useState(false);
  const maximizedChartContainerRef = useRef<HTMLDivElement>(null);

  // Fetch data MDX dari backend
  const fetchMdxData = async (period: string = chartTimeframe) => {
    setMdxLoading(true);
    try {
      const apiBase = (await import('../config/endpoints')).resolveApiBase();
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
    } catch {
      // Biarkan mdxHistory kosong jika terjadi error
    } finally {
      setMdxLoading(false);
    }
  };

  useEffect(() => {
    fetchMdxData(chartTimeframe);
  }, [chartTimeframe]);

  // Nilai & perubahan MDX yang tampil di navbar dan chart
  const mdxDisplayValue = mdxCurrent?.value ?? 1000;
  const mdxBaseValue = mdxCurrent?.baseValue ?? 1000;
  const mdxChangePercent = mdxBaseValue > 0 ? parseFloat((((mdxDisplayValue - mdxBaseValue) / mdxBaseValue) * 100).toFixed(2)) : 0;

  // Titik chart: gunakan data nyata, atau kembalikan garis datar jika kosong
  const chartPoints = useMemo(() => {
    if (mdxHistory.length > 0) {
      return mdxHistory.map(p => p.value);
    }
    // Fallback ke garis datar (flat line) senilai nilai saat ini
    const days = chartTimeframe === '1S' ? 30 :
                 chartTimeframe === '1m' ? 60 :
                 chartTimeframe === '1H' ? 24 : 90;
    return Array(days).fill(mdxDisplayValue);
  }, [mdxHistory, mdxDisplayValue, chartTimeframe]);

  const chartContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Bersihkan kontainer dari chart sebelumnya
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
        horzLine: {
          visible: true,
          labelVisible: true,
        },
        vertLine: {
          visible: true,
          labelVisible: true,
        },
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

    // Konversi data ke format lightweight-charts
    const formattedData = chartPoints.map((val, idx) => {
      if (mdxHistory.length > 0 && mdxHistory[idx]) {
        return {
          time: Math.floor(new Date(mdxHistory[idx].time).getTime() / 1000) as any,
          value: val
        };
      }
      // Fallback waktu mundur per jam jika kosong
      const date = new Date();
      date.setHours(date.getHours() - (chartPoints.length - idx));
      return {
        time: Math.floor(date.getTime() / 1000) as any,
        value: val
      };
    });

    // Urutkan secara menaik dan hilangkan duplikasi waktu
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

  // Inisialisasi TradingView Lightweight Charts Versi Maximize (Besar)
  useEffect(() => {
    if (!isChartMaximized || !maximizedChartContainerRef.current) return;

    // Bersihkan kontainer dari chart sebelumnya
    maximizedChartContainerRef.current.innerHTML = '';

    const containerWidth = maximizedChartContainerRef.current.clientWidth;
    const isPositive = mdxChangePercent >= 0;
    const themeColor = isPositive ? '#10B981' : '#EF4444';
    const topGlowColor = isPositive ? 'rgba(16, 185, 129, 0.25)' : 'rgba(239, 68, 68, 0.25)';

    const chartInstance = createChart(maximizedChartContainerRef.current, {
      width: containerWidth,
      height: 400, // Tinggi lebih besar untuk detail
      layout: {
        background: { color: 'transparent' },
        textColor: '#8B949E',
        fontSize: 11,
        fontFamily: 'monospace',
        attributionLogo: false, // Sembunyikan logo TradingView
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
        horzLine: {
          visible: true,
          labelVisible: true,
        },
        vertLine: {
          visible: true,
          labelVisible: true,
        },
      },
      handleScale: true, // Izinkan zoom & scroll di versi maximize
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

    // Konversi data ke format lightweight-charts
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

    // Resize handler setelah efek transisi Morph CSS selesai (400ms)
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

  // Sidebar Menu Config
  const SIDEBAR_ITEMS = [
    { 
      id: 'Dashboard', 
      label: 'Dashboard', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
        </svg>
      )
    },
    { 
      id: 'Portofolio', 
      label: 'Portofolio Detail', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      )
    },
    { 
      id: 'Market', 
      label: 'Pasar Saham', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      )
    },
    { 
      id: 'Watchlist', 
      label: 'Watchlist Saya', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
      )
    },
    { 
      id: 'Aktivitas', 
      label: 'Aktivitas Order', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    { 
      id: 'Pengaturan', 
      label: 'Pengaturan', 
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
    },
  ];

  return (
    <div className="dashboard-container-premium">
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
      {/* ==========================================
          SIDEBAR KIRI PREMIUM (DESIGN.MD ADAPTIVE)
          ========================================== */}
      
      {/* Sidebar Desktop: Always visible on large screens */}
      <aside className="sidebar-desktop-premium">
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {/* Logo & Identitas */}
          <div className="sidebar-logo-section">
            <div 
              className="relative w-9 h-9 overflow-hidden rounded-full flex items-center justify-center"
              style={{ backgroundColor: 'rgba(15, 44, 89, 0.4)', border: '1px solid #21262D', flexShrink: 0 }}
            >
              <img 
                src="logo_teksbawah.png" 
                alt="Mandala Sekuritas Logo" 
                style={{ objectFit: 'contain', width: '2rem', height: '2rem' }}
                onError={(e: any) => {
                  e.target.style.display = 'none';
                  e.target.nextSibling.style.display = 'flex';
                }}
              />
              <div 
                className="absolute inset-0 flex items-center justify-center bg-gradient-to-br"
                style={{ backgroundImage: 'linear-gradient(135deg, #0F2C59, #161B22)', display: 'none' }}
              >
                <span className="font-extrabold text-sm" style={{ color: '#E62225' }}>M</span>
                <span className="text-white font-extrabold text-sm">S</span>
              </div>
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider leading-none text-white" style={{ margin: 0 }}>MANDALA</h1>
              <p className="text-[10px] text-[#8B949E] tracking-widest uppercase font-semibold" style={{ margin: 0 }}>Sekuritas</p>
            </div>
          </div>

          {/* List Menu */}
          <nav className="sidebar-menu-list">
            {SIDEBAR_ITEMS.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`sidebar-menu-item ${isActive ? 'active' : ''}`}
                >
                  <span style={{ color: isActive ? '#E62225' : '#8B949E', display: 'flex', alignItems: 'center' }}>
                    {item.icon}
                  </span>
                  {item.label}
                  {isActive && (
                    <span className="sidebar-menu-indicator-dot"></span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Footer Sidebar (Status Akun & RDN) */}
        <div className="sidebar-footer-section">
          <div className="user-profile-bar">
            <div className="user-avatar-circle">
              {user?.email?.slice(0, 2).toUpperCase() || 'MS'}
            </div>
            <div>
              <p className="text-xs font-bold text-white" style={{ margin: 0 }}>
                {user?.email?.split('@')[0] || 'Mandala Investor'}
              </p>
              <p className="text-[10px] text-[#8B949E] font-mono uppercase tracking-wider" style={{ margin: 0 }}>
                {user?.status || 'Active Trader'}
              </p>
            </div>
          </div>
          <div className="rdn-box-premium">
            <p className="text-[9px] text-[#8B949E] uppercase tracking-wider block" style={{ margin: '0 0 4px 0' }}>ID RDN BCA</p>
            <p className="text-xs font-bold text-slate-100 font-mono" style={{ margin: 0 }}>
              {accountProfile?.references?.rdn || '0092-2345-21-1'}
            </p>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Sidebar */}
      <div className={`mobile-sidebar-drawer ${isSidebarOpen ? 'open' : ''}`}>
        <div 
          className="mobile-sidebar-overlay" 
          onClick={() => setIsSidebarOpen(false)}
        ></div>
        <aside className="mobile-sidebar-aside">
          <div style={{ display: 'flex', flexDirection: 'column' }}>
            <div className="flex justify-between items-center pb-4" style={{ borderBottom: '1px solid #21262D' }}>
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-bold tracking-wider text-white">MANDALA SEKURITAS</span>
              </div>
              <button 
                onClick={() => setIsSidebarOpen(false)} 
                className="text-[#8B949E] hover:text-white p-1"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
              >
                ✕
              </button>
            </div>
            <nav className="sidebar-menu-list">
              {SIDEBAR_ITEMS.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id);
                      setIsSidebarOpen(false);
                    }}
                    className={`sidebar-menu-item ${isActive ? 'active' : ''}`}
                  >
                    <span style={{ color: isActive ? '#E62225' : '#8B949E', display: 'flex', alignItems: 'center' }}>{item.icon}</span>
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>
          <div className="rdn-box-premium">
            <span className="text-[#8B949E] text-[10px] block mb-1">RDN BCA</span>
            <span className="text-white font-bold">{accountProfile?.references?.rdn || '0092-2345-21-1'}</span>
          </div>
        </aside>
      </div>

      {/* ==========================================
          AREA KONTEN UTAMA (KANAN)
          ========================================== */}
      <div className="main-content-premium">
        
        {/* ==========================================
            NAVBAR FLOATING & ROUNDED
            ========================================== */}
        <header className="navbar-premium-container">
          <nav className="navbar-premium-inner">
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              {/* Hamburger Button for Mobile */}
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="hamburger-mobile-btn"
              >
                <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span 
                  className="text-xs font-bold text-white tracking-wide py-1 px-3 rounded-full"
                  style={{ backgroundColor: '#21262D' }}
                >
                  {activeTab}
                </span>
              </div>
            </div>

            {/* Indikator Status Pasar & IHSG */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              {(() => {
                const isOpen = market.sessionStatus && market.sessionStatus !== 'closed';
                const indicatorBg = isOpen ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)';
                const indicatorBorder = isOpen ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)';
                return (
                  <div 
                    id="market-status-indicator"
                    className="flex items-center gap-2 py-1.5 px-3 rounded-full text-xs"
                    style={{ backgroundColor: indicatorBg, border: indicatorBorder }}
                  >
                    <span className="relative flex h-2 w-2" style={{ display: 'inline-flex' }}>
                      <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isOpen ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></span>
                      <span 
                        className="relative inline-flex rounded-full h-2 w-2"
                        style={{
                          backgroundColor: isOpen ? '#10B981' : '#EF4444'
                        }}
                      ></span>
                    </span>
                    <span className="font-semibold text-slate-300 uppercase hidden-mobile" style={{ fontSize: '11px' }}>
                      PASAR {market.sessionStatus || 'CLOSED'}
                    </span>
                  </div>
                );
              })()}

              <div className="font-mono hidden-mobile" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', fontSize: '12px' }}>
                <span className="text-[#8B949E] hidden sm:inline">MDX:</span>
                <span className="font-bold text-white">{mdxDisplayValue.toLocaleString('id-ID', { maximumFractionDigits: 2 })}</span>
                <span 
                  className="font-bold text-xs"
                  style={{ color: mdxChangePercent >= 0 ? '#10B981' : '#EF4444', display: 'flex', alignItems: 'center' }}
                >
                  {mdxChangePercent >= 0 ? '▲' : '▼'} {Math.abs(mdxChangePercent)}%
                </span>
              </div>
            </div>

            {/* Logout Action */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div className="text-right hidden-mobile flex flex-col">
                <p className="text-[10px] text-[#8B949E] leading-tight" style={{ margin: 0 }}>Buying Power</p>
                <p className="text-xs font-bold font-mono leading-tight" style={{ color: '#10B981', margin: 0 }}>
                  Rp {buyingPower.toLocaleString('id-ID')}
                </p>
              </div>
              <button 
                onClick={handleLogout}
                className="p-2 rounded-full hover:bg-red-950/40 text-red-500 hover:text-red-400"
                style={{ background: 'transparent', border: 'none', display: 'flex', padding: '0.5rem', cursor: 'pointer', color: '#EF4444' }}
                title="Keluar"
              >
                <LogOut size={16} />
              </button>
            </div>
          </nav>
        </header>

        {/* ==========================================
            ROUTING INTERAKTIF KONTEN (Dashboard vs Detail Tab)
            ========================================== */}
        <div className="scrollable-dashboard-content">
          {error && (
            <div 
              className="max-w-7xl mx-auto p-4 mb-4 rounded-xl flex items-center gap-3"
              style={{ backgroundColor: 'rgba(239, 68, 68, 0.1)', border: '1px solid #EF4444', color: '#EF4444' }}
            >
              <AlertTriangle size={18} />
              <span className="text-xs font-semibold">{error}</span>
            </div>
          )}

          {activeTab === 'Dashboard' ? (
            <div className="dashboard-grid-layout">
              
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
                    onClick={() => setModalType('deposit')}
                    className="flex-grow btn-primary-red uppercase tracking-wider text-xs flex items-center justify-center gap-2"
                    style={{ padding: '0.85rem 1rem' }}
                  >
                    <Plus size={14} /> Deposit Dana
                  </button>
                  <button 
                    onClick={() => setModalType('withdraw')}
                    className="flex-grow btn-secondary-dark uppercase tracking-wider text-xs flex items-center justify-center gap-2"
                    style={{ padding: '0.85rem 1rem' }}
                  >
                    <Wallet size={14} /> Tarik Tunai
                  </button>
                </div>
              </section>

              {/* SECTION B: GRAFIK MDX (Mandala Composite Index) (5/12 Kolom) */}
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
                    <div 
                      style={{ 
                        display: 'flex',
                        gap: '0.25rem',
                        padding: '0.25rem',
                        backgroundColor: '#0D1117',
                        border: '1px solid #21262D',
                        borderRadius: '6px'
                      }}
                    >
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
                                      onClick={() => handleOpenTrade(pos.symbol, 'BUY')}
                                      className="pill-action-buy"
                                    >
                                      Beli
                                    </button>
                                    <button
                                      onClick={() => handleOpenTrade(pos.symbol, 'SELL')}
                                      className="pill-action-sell"
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
                              Belum memiliki posisi saham terdaftar. Mulai bertransaksi melalui watchlist atau tombol Trade.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 border-t border-[#21262D] pt-3 flex justify-between items-center text-xs">
                    <span className="text-[#8B949E]">Menampilkan ringkasan holding utama</span>
                    <button 
                      onClick={() => setActiveTab('Portofolio')}
                      className="text-white hover:text-[#E62225] font-bold transition flex items-center gap-1"
                      style={{ background: 'transparent', border: 'none', cursor: 'pointer' }}
                    >
                      Lihat Semua Portofolio 
                      <svg className="w-3.5 h-3.5" width={14} height={14} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7"></path></svg>
                    </button>
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
                      ) : (
                        <div>
                          <span 
                            className="text-[9px] font-bold px-2 py-0.5 rounded-md border"
                            style={{ backgroundColor: 'rgba(230, 34, 37, 0.1)', borderColor: 'rgba(230, 34, 37, 0.3)', color: '#E62225' }}
                          >
                            ACTIVE
                          </span>
                          <p className="text-xs font-bold text-slate-100 mt-2 mb-1">MANDALA ENERGY INDONESIA (MEI)</p>
                          <p className="text-[10px] text-[#8B949E] font-mono">Bookbuilding: Rp 210 - Rp 250</p>
                        </div>
                      )}
                      
                      <div className="flex justify-between items-center text-[10px] mt-2 pt-2" style={{ borderTop: '1px solid #21262D' }}>
                        <span className="text-[#8B949E]">Listing: {ipoEvents?.[0]?.listing_date ? new Date(ipoEvents[0].listing_date).toLocaleDateString('id-ID', { day: 'numeric', month: 'long', year: 'numeric' }) : '14 Juli 2026'}</span>
                        <button 
                          onClick={() => {
                            const code = ipoEvents?.[0]?.symbol || 'MEI';
                            const price = ipoEvents?.[0]?.price_range_max || 230;
                            setSelectedStockForTrade(code);
                            setTradeType('BUY');
                            setTradeQty(10);
                            setTradeOrderType('limit');
                            setTradePrice(String(price));
                            setModalType('trade');
                          }}
                          className="text-[#E62225] hover:underline font-bold"
                          style={{ background: 'transparent', border: 'none', padding: 0, cursor: 'pointer' }}
                        >
                          Pesan IPO ↗
                        </button>
                      </div>
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
                      ) : (
                        <div>
                          <span 
                            className="text-[9px] font-bold px-2 py-0.5 rounded-md border"
                            style={{ backgroundColor: 'rgba(16, 185, 129, 0.1)', borderColor: 'rgba(16, 185, 129, 0.3)', color: '#10B981' }}
                          >
                            DIVIDEND
                          </span>
                          <p className="text-xs font-bold text-slate-100 mt-2 mb-1">BBCA akan membagikan dividen</p>
                          <p className="text-[10px] text-[#8B949E]">Sebesar Rp 220,- / lembar saham</p>
                        </div>
                      )}
                      
                      <div className="flex justify-between items-center text-[10px] mt-2 pt-2" style={{ borderTop: '1px solid #21262D' }}>
                        <span className="text-[#8B949E] font-mono">Cum Date: Besok</span>
                        <span className="text-slate-300 font-semibold font-mono">IDR 3.3M Estimasi Masuk</span>
                      </div>
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
                            onClick={() => handleOpenTrade(g.symbol, 'BUY')}
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
                            onClick={() => handleOpenTrade(l.symbol, 'BUY')}
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
                              onClick={() => handleOpenTrade(stock.symbol, 'BUY')}
                              className="btn-primary-red font-bold text-[10px] px-2.5 py-1.5 rounded transition"
                              style={{ padding: '0.35rem 0.75rem' }}
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
                            style={{ padding: '0.25rem 0.5rem' }}
                          >
                            + {s.symbol}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

              </div>

            </div>
          ) : activeTab === 'Portofolio' ? (
            <Portfolio 
              onOpenTrade={handleOpenTrade}
              onOpenDeposit={() => setModalType('deposit')}
              onOpenWithdraw={() => setModalType('withdraw')}
            />
          ) : (
            /* ==========================================
               SIDEBAR ROUTE PLACEHOLDER
               ========================================== */
            <div className="max-w-4xl mx-auto py-16 text-center">
              <div 
                className="p-8 md:p-12 rounded-2xl shadow-2xl relative overflow-hidden"
                style={{ backgroundColor: '#161B22', border: '1px solid #21262D' }}
              >
                <div 
                  className="absolute top-0 left-0 right-0 h-1"
                  style={{ backgroundImage: 'linear-gradient(to right, #E62225, #0F2C59, #E62225)' }}
                ></div>
                <div 
                  className="w-16 h-16 mx-auto rounded-full flex items-center justify-center mb-6"
                  style={{ backgroundColor: 'rgba(230, 34, 37, 0.1)', color: '#E62225' }}
                >
                  {SIDEBAR_ITEMS.find(item => item.id === activeTab)?.icon}
                </div>
                <h3 className="text-2xl font-black text-white mb-3">
                  Halaman {SIDEBAR_ITEMS.find(item => item.id === activeTab)?.label}
                </h3>
                <p className="text-[#8B949E] max-w-md mx-auto text-sm mb-8 leading-relaxed">
                  Halaman ini dikonfigurasi melalui integrasi sidebar. Hubungkan API data Mandala Sekuritas untuk menyinkronkan visualisasi data riil di halaman ini.
                </p>
                <button 
                  onClick={() => setActiveTab('Dashboard')}
                  className="btn-primary-red font-bold text-xs py-3 px-6 rounded-lg uppercase tracking-wider transition-all duration-300 inline-flex items-center gap-2"
                  style={{ padding: '0.75rem 1.5rem' }}
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path>
                  </svg>
                  Kembali ke Dashboard Utama
                </button>
              </div>
            </div>
          )}

        </div>
      </div>

      {/* ==========================================
          MODALS & OVERLAYS INTERAKTIF
          ========================================== */}

      {/* Modal 1: DEPOSIT DANA */}
      {modalType === 'deposit' && (
        <div className="modal-overlay">
          <div className="modal-content-premium">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h3 className="text-lg font-bold text-white" style={{ margin: 0 }}>Deposit Dana ke RDN</h3>
              <button 
                onClick={() => setModalType(null)}
                className="text-[#8B949E] hover:text-white p-1"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-[#8B949E] mb-4">Suntik dana secara instan untuk memperluas Buying Power akun Mandala Sekuritas Anda.</p>
            
            <form onSubmit={handleDepositSubmit} className="space-y-4">
              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Pilih Bank Asal</label>
                <select className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-white focus:outline-none focus:border-[#E62225]">
                  <option>Mandiri Virtual Account - 8903 0192 1002</option>
                  <option>BCA Virtual Account - 1002 9182 221</option>
                  <option>Permata Virtual Account - 7192 112 001</option>
                </select>
              </div>

              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Nominal Deposit (IDR)</label>
                <input 
                  type="number" 
                  value={depositAmount}
                  onChange={(e) => setDepositAmount(e.target.value)}
                  placeholder="Contoh: 10000000"
                  className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#E62225] font-mono"
                  required
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  onClick={() => setModalType(null)}
                  className="flex-grow btn-secondary-dark py-2.5 rounded-lg text-xs"
                >
                  Batal
                </button>
                <button 
                  type="submit" 
                  className="flex-grow btn-primary-red text-xs py-2.5 rounded-lg"
                >
                  Konfirmasi Transfer
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 2: TARIK DANA */}
      {modalType === 'withdraw' && (
        <div className="modal-overlay">
          <div className="modal-content-premium">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
              <h3 className="text-lg font-bold text-white" style={{ margin: 0 }}>Tarik Dana Ke Rekening Bank</h3>
              <button 
                onClick={() => setModalType(null)}
                className="text-[#8B949E] hover:text-white p-1"
                style={{ background: 'transparent', border: 'none', cursor: 'pointer', display: 'flex' }}
              >
                <X size={18} />
              </button>
            </div>
            <p className="text-xs text-[#8B949E] mb-4">Mencairkan dana dari Buying Power ke rekening bank pribadi Anda terdaftar.</p>
            
            <div className="p-3 rounded-lg mb-4 text-xs font-mono" style={{ backgroundColor: '#0D1117', border: '1px solid #21262D' }}>
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Dana Maksimal Ditarik:</span>
                <span className="text-white font-bold">Rp {buyingPower.toLocaleString('id-ID')}</span>
              </div>
            </div>

            <form onSubmit={handleWithdrawSubmit} className="space-y-4">
              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Bank Penerima</label>
                <div className="p-2.5 text-xs text-slate-300 rounded-lg" style={{ backgroundColor: '#0D1117', border: '1px solid #21262D' }}>
                  <span className="font-bold block text-white">BCA (AKUN TERDAFTAR)</span>
                  <span className="text-[10px] text-[#8B949E]">No Rekening: **** *** 9811 a/n Mandala User</span>
                </div>
              </div>

              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Nominal Penarikan (IDR)</label>
                <input 
                  type="number" 
                  value={withdrawAmount}
                  onChange={(e) => setWithdrawAmount(e.target.value)}
                  placeholder="Contoh: 5000000"
                  className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#E62225] font-mono"
                  required
                />
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  onClick={() => setModalType(null)}
                  className="flex-grow btn-secondary-dark py-2.5 rounded-lg text-xs"
                >
                  Batal
                </button>
                <button 
                  type="submit" 
                  className="flex-grow btn-primary-red text-xs py-2.5 rounded-lg"
                >
                  Konfirmasi Tarik Dana
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 3: TRADE CONSOLE (BELI/JUAL REAL NYATA KE BACKEND) */}
      {modalType === 'trade' && selectedStockForTrade && (
        <div className="modal-overlay">
          <div className="modal-content-premium">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '1rem' }}>
              <div>
                <span 
                  className="text-[9px] text-white px-2.5 py-0.5 rounded-full font-bold uppercase tracking-widest"
                  style={{ backgroundColor: '#0F2C59' }}
                >
                  Mandala Orderbook
                </span>
                <h3 className="text-2.5xl font-black text-white mt-1 leading-none" style={{ margin: 0 }}>
                  {selectedStockForTrade}
                </h3>
                <span className="text-[10px] text-[#8B949E]">
                  {securities.find(s => (s.symbol || s.code) === selectedStockForTrade)?.name || 'Mandala Securities'}
                </span>
              </div>
              
              <div className="text-right">
                <span className="text-[10px] text-[#8B949E] block">Harga Terakhir</span>
                <span className="text-lg font-mono font-bold text-white">
                  Rp {(market.lastPrices[selectedStockForTrade] || 0).toLocaleString('id-ID')}
                </span>
              </div>
            </div>

            {/* Toggle Buy / Sell */}
            <div 
              style={{ 
                display: 'grid', 
                gridTemplateColumns: 'repeat(2, 1fr)',
                gap: '0.375rem',
                padding: '0.25rem',
                borderRadius: '8px',
                marginBottom: '1rem',
                backgroundColor: '#0D1117', 
                border: '1px solid #21262D' 
              }}
            >
              <button 
                type="button"
                onClick={() => setTradeType('BUY')}
                style={{
                  padding: '0.5rem',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  borderRadius: '6px',
                  textTransform: 'uppercase',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: tradeType === 'BUY' ? '#10B981' : 'transparent',
                  color: tradeType === 'BUY' ? '#FFFFFF' : '#8B949E'
                }}
              >
                Beli (Buy)
              </button>
              <button 
                type="button"
                onClick={() => setTradeType('SELL')}
                style={{
                  padding: '0.5rem',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  borderRadius: '6px',
                  textTransform: 'uppercase',
                  border: 'none',
                  cursor: 'pointer',
                  backgroundColor: tradeType === 'SELL' ? '#EF4444' : 'transparent',
                  color: tradeType === 'SELL' ? '#FFFFFF' : '#8B949E'
                }}
              >
                Jual (Sell)
              </button>
            </div>

            {/* Segmented Control Order Type */}
            <div className="segmented-control" style={{ marginBottom: '1.25rem' }}>
              <button 
                type="button" 
                className={tradeOrderType === 'limit' ? 'active' : ''} 
                onClick={() => setTradeOrderType('limit')}
                style={{ border: 'none' }}
              >
                LIMIT
              </button>
              <button 
                type="button" 
                className={tradeOrderType === 'market' ? 'active' : ''} 
                onClick={() => setTradeOrderType('market')}
                style={{ border: 'none' }}
              >
                MARKET
              </button>
            </div>

            {/* Info RDN & Batas Kepemilikan */}
            <div className="p-3 rounded-lg text-xs font-mono mb-4 space-y-1" style={{ backgroundColor: '#0D1117', border: '1px solid #21262D' }}>
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Dana RDN Tersedia:</span>
                <span className="text-white font-bold">Rp {buyingPower.toLocaleString('id-ID')}</span>
              </div>
              {tradeType === 'SELL' && (
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">Kepemilikan Anda:</span>
                  <span className="text-white font-bold">
                    {((portfolio?.positions?.find((p) => p.symbol === selectedStockForTrade)?.available || 0) / 100)} Lot
                  </span>
                </div>
              )}
            </div>

            {/* Input Form */}
            <div className="space-y-4">
              {tradeOrderType === 'limit' && (
                <div>
                  <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Harga Pembelian (IDR)</label>
                  <input 
                    type="number" 
                    value={tradePrice}
                    onChange={(e) => setTradePrice(e.target.value)}
                    placeholder="Contoh: 320"
                    className="w-full bg-[#0D1117] border border-[#21262D] rounded-lg p-3 text-sm text-white focus:outline-none focus:border-[#E62225] font-mono"
                    required
                  />
                </div>
              )}

              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Jumlah Pembelian (LOT)</label>
                <div style={{ display: 'flex', alignItems: 'center' }}>
                  <button 
                    type="button"
                    onClick={() => setTradeQty(Math.max(1, tradeQty - 1))}
                    className="bg-[#0D1117] border text-white font-bold w-12 h-12 rounded-l-lg transition text-center"
                    style={{ borderColor: '#21262D', cursor: 'pointer' }}
                  >
                    -
                  </button>
                  <input 
                    type="number" 
                    value={tradeQty}
                    onChange={(e) => setTradeQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-grow bg-[#0D1117] h-12 text-center text-sm font-bold text-white focus:outline-none font-mono"
                    style={{ borderTop: '1px solid #21262D', borderBottom: '1px solid #21262D', borderLeft: 'none', borderRight: 'none' }}
                    min="1"
                  />
                  <button 
                    type="button"
                    onClick={() => setTradeQty(tradeQty + 1)}
                    className="bg-[#0D1117] border text-white font-bold w-12 h-12 rounded-r-lg transition text-center"
                    style={{ borderColor: '#21262D', cursor: 'pointer' }}
                  >
                    +
                  </button>
                </div>
                <span className="text-[10px] text-[#8B949E] mt-1 block text-right font-mono">
                  = {(tradeQty * LOT_SIZE).toLocaleString('id-ID')} Lembar Saham
                </span>
              </div>

              {/* Total Estimasi Transaksi */}
              {(() => {
                const finalPrice = tradeOrderType === 'market' ? (market.lastPrices[selectedStockForTrade] || 0) : Number(tradePrice);
                const estValue = finalPrice * tradeQty * LOT_SIZE;
                const brokerRate = Number(tradeType === 'BUY' ? feeSchedule?.brokerBuyRate : feeSchedule?.brokerSellRate) || 0.0015;
                
                const vatRate = Number(feeSchedule?.vatRate) || 0.11;
                const sellTaxRate = tradeType === 'SELL' ? Number(feeSchedule?.sellTaxRate) || 0.001 : 0;
                
                const estFee = estValue * (brokerRate + sellTaxRate) + (estValue * brokerRate * vatRate);
                const totalReq = tradeType === 'BUY' ? estValue + estFee : estValue - estFee;

                return (
                  <div className="pt-4 space-y-2" style={{ borderTop: '1px solid #21262D' }}>
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-[#8B949E]">Estimasi Transaksi:</span>
                      <span className="text-slate-300">Rp {estValue.toLocaleString('id-ID')}</span>
                    </div>
                    <div className="flex justify-between text-xs font-mono">
                      <span className="text-[#8B949E]">Biaya Broker (0.15%):</span>
                      <span className="text-slate-300">Rp {Math.round(estFee).toLocaleString('id-ID')}</span>
                    </div>
                    <div 
                      className="flex justify-between text-sm font-mono font-bold pt-2 text-white" 
                      style={{ borderTop: '1px solid rgba(33, 38, 45, 0.6)' }}
                    >
                      <span>Total Tagihan:</span>
                      <span style={{ color: '#F59E0B' }}>
                        Rp {Math.round(totalReq).toLocaleString('id-ID')}
                      </span>
                    </div>
                  </div>
                );
              })()}

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  onClick={() => setModalType(null)}
                  className="flex-grow btn-secondary-dark py-3 rounded-lg text-xs"
                >
                  Batal
                </button>
                <button 
                  type="button" 
                  onClick={executeTrade}
                  disabled={orderActionLoading}
                  className="flex-grow text-white font-bold text-xs py-3 rounded-lg border-none"
                  style={{ backgroundColor: tradeType === 'BUY' ? '#10B981' : '#EF4444', cursor: 'pointer' }}
                >
                  {orderActionLoading ? 'Memproses...' : `Kirim Order ${tradeType === 'BUY' ? 'Beli' : 'Jual'}`}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==========================================
          TOAST POPUP / NOTIFIKASI MIKRO
          ========================================== */}
      {toast && (
        <div 
          className="toast-premium"
          style={{ 
            borderLeftColor: toast.type === 'success' ? '#10B981' : '#EF4444'
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

      {/* Maximize Chart Overlay (Morph Effect) */}
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
              <div 
                style={{ 
                  display: 'flex',
                  gap: '0.25rem',
                  padding: '0.25rem',
                  backgroundColor: '#0D1117',
                  border: '1px solid #21262D',
                  borderRadius: '6px'
                }}
              >
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

    </div>
  );
}
