import React, { useState, useEffect, useMemo } from 'react';

// ==========================================
// DATA INTI & INITIAL STATES
// ==========================================

// Daftar saham default untuk simulasi pasar
const INITIAL_STOCKS = [
  { code: 'BBCA', name: 'Bank Central Asia Tbk', price: 10250, change: 1.2, prevPrice: 10125, volume: '45.2M', isGainer: true, category: 'Banking' },
  { code: 'GOTO', name: 'GoTo Gojek Tokopedia Tbk', price: 64, change: -3.03, prevPrice: 66, volume: '1.2B', isGainer: false, category: 'Tech' },
  { code: 'TLKM', name: 'Telkom Indonesia Tbk', price: 3820, change: 0.53, prevPrice: 3800, volume: '28.7M', isGainer: true, category: 'Telecom' },
  { code: 'ASII', name: 'Astra International Tbk', price: 5150, change: -1.43, prevPrice: 5225, volume: '12.1M', isGainer: false, category: 'Automotive' },
  { code: 'ANTM', name: 'Aneka Tambang Tbk', price: 1620, change: 4.85, prevPrice: 1545, volume: '34.5M', isGainer: true, category: 'Mining' },
  { code: 'BBRI', name: 'Bank Rakyat Indonesia Tbk', price: 4780, change: -0.83, prevPrice: 4820, volume: '58.9M', isGainer: false, category: 'Banking' },
  { code: 'BBNI', name: 'Bank Negara Indonesia Tbk', price: 5400, change: 1.89, prevPrice: 5300, volume: '18.4M', isGainer: true, category: 'Banking' },
  { code: 'ADRO', name: 'Adaro Energy Indonesia Tbk', price: 2850, change: -2.40, prevPrice: 2920, volume: '22.1M', isGainer: false, category: 'Mining' },
  { code: 'AMMN', name: 'Amman Mineral Internasional Tbk', price: 11450, change: 3.15, prevPrice: 11100, volume: '15.3M', isGainer: true, category: 'Mining' },
];

// Data awal portofolio pengguna
const INITIAL_PORTFOLIO = [
  { code: 'BBCA', avgPrice: 9800, qty: 15, currentPrice: 10250 }, // 15 lot = 1500 lembar
  { code: 'TLKM', avgPrice: 3650, qty: 30, currentPrice: 3820 }, // 30 lot = 3000 lembar
  { code: 'GOTO', avgPrice: 82, qty: 500, currentPrice: 64 },   // 500 lot = 50000 lembar
];

// Data awal transaksi terbaru
const INITIAL_ORDERS = [
  { id: 'ORD-001', code: 'GOTO', type: 'BUY', qty: 100, price: 64, status: 'Matched', time: '11:15' },
  { id: 'ORD-002', code: 'BBCA', type: 'SELL', qty: 5, price: 10250, status: 'Pending', time: '11:02' },
  { id: 'ORD-003', code: 'ANTM', type: 'BUY', qty: 20, price: 1610, status: 'Matched', time: '09:45' },
];

export default function App() {
  // --- State Utama ---
  const [stocks, setStocks] = useState(INITIAL_STOCKS);
  const [portfolio, setPortfolio] = useState(INITIAL_PORTFOLIO);
  const [orders, setOrders] = useState(INITIAL_ORDERS);
  const [watchlist, setWatchlist] = useState(['BBCA', 'ANTM', 'AMMN']);
  const [buyingPower, setBuyingPower] = useState(45250000); // Dana cash tunai Rp45.250.000
  const [marketStatus, setMarketStatus] = useState('OPEN'); // OPEN, CLOSED, HALTED
  const [ihsgValue, setIhsgValue] = useState(7285.45);
  const [ihsgChange, setIhsgChange] = useState(0.34); // Persentase kenaikan IHSG hari ini
  
  // Waktu historis grafik IHSG (7 Hari atau 1 Bulan)
  const [chartTimeframe, setChartTimeframe] = useState('7D');
  
  // State Navigasi Halaman
  const [activeTab, setActiveTab] = useState('Dashboard');
  const [isSidebarOpen, setIsSidebarOpen] = useState(false); // Mobile sidebar drawer
  
  // State Dialog & Modal
  const [modalType, setModalType] = useState(null); // 'deposit', 'withdraw', 'trade'
  const [selectedStockForTrade, setSelectedStockForTrade] = useState(null);
  const [tradeType, setTradeType] = useState('BUY'); // BUY atau SELL
  const [tradeQty, setTradeQty] = useState(1); // dalam satuan LOT
  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  
  // Toast Notification
  const [toast, setToast] = useState(null);

  // --- Fungsi Toast Notification ---
  const showToast = (message, type = 'success') => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 4000);
  };

  // --- Real-time Stock Price Simulator (Efek Detak Jantung Pasar) ---
  useEffect(() => {
    if (marketStatus !== 'OPEN') return;

    const interval = setInterval(() => {
      // Fluktuasi harga saham acak
      setStocks((prevStocks) =>
        prevStocks.map((stock) => {
          const changePercent = (Math.random() * 0.8 - 0.4) / 100; // -0.4% sampai +0.4%
          const newPrice = Math.max(10, Math.round(stock.price * (1 + changePercent)));
          const totalChangeFromPrev = ((newPrice - stock.prevPrice) / stock.prevPrice) * 100;
          return {
            ...stock,
            price: newPrice,
            change: parseFloat(totalChangeFromPrev.toFixed(2)),
            isGainer: totalChangeFromPrev >= 0,
          };
        })
      );

      // Fluktuasi IHSG secara paralel
      setIhsgValue((prev) => {
        const ihsgChangePercent = (Math.random() * 0.12 - 0.05) / 100;
        const newVal = prev * (1 + ihsgChangePercent);
        // Persentase perubahan harian (simulasi)
        const dailyPercent = ((newVal - 7260.10) / 7260.10) * 100;
        setIhsgChange(parseFloat(dailyPercent.toFixed(2)));
        return parseFloat(newVal.toFixed(2));
      });
    }, 4000);

    return () => clearInterval(interval);
  }, [marketStatus]);

  // Sinkronisasi harga saham ke portofolio saat pasar bergerak
  useEffect(() => {
    setPortfolio((prevPortfolio) =>
      prevPortfolio.map((item) => {
        const liveStock = stocks.find((s) => s.code === item.code);
        if (liveStock) {
          return { ...item, currentPrice: liveStock.price };
        }
        return item;
      })
    );
  }, [stocks]);

  // --- Perhitungan Finansial ---
  const portfolioValue = useMemo(() => {
    return portfolio.reduce((sum, item) => sum + (item.currentPrice * item.qty * 100), 0);
  }, [portfolio]);

  const portfolioCostBasis = useMemo(() => {
    return portfolio.reduce((sum, item) => sum + (item.avgPrice * item.qty * 100), 0);
  }, [portfolio]);

  const totalNAV = useMemo(() => {
    return buyingPower + portfolioValue;
  }, [buyingPower, portfolioValue]);

  const totalPLAmount = useMemo(() => {
    return portfolioValue - portfolioCostBasis;
  }, [portfolioValue, portfolioCostBasis]);

  const totalPLPercent = useMemo(() => {
    if (portfolioCostBasis === 0) return 0;
    return (totalPLAmount / portfolioCostBasis) * 100;
  }, [totalPLAmount, portfolioCostBasis]);

  // --- Manipulasi Watchlist ---
  const toggleWatchlist = (code) => {
    if (watchlist.includes(code)) {
      setWatchlist(watchlist.filter((c) => c !== code));
      showToast(`${code} dihapus dari watchlist`, 'error');
    } else {
      setWatchlist([...watchlist, code]);
      showToast(`${code} ditambahkan ke watchlist`, 'success');
    }
  };

  // --- Logika Simulasi Deposit & Withdraw ---
  const handleDeposit = (e) => {
    e.preventDefault();
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Masukkan jumlah deposit yang valid', 'error');
      return;
    }
    setBuyingPower((prev) => prev + amount);
    setDepositAmount('');
    setModalType(null);
    showToast(`Berhasil deposit Rp ${amount.toLocaleString('id-ID')}`, 'success');
  };

  const handleWithdraw = (e) => {
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
    setBuyingPower((prev) => prev - amount);
    setWithdrawAmount('');
    setModalType(null);
    showToast(`Berhasil melakukan penarikan Rp ${amount.toLocaleString('id-ID')}`, 'success');
  };

  // --- Logika Eksekusi Transaksi (Beli / Jual) ---
  const handleOpenTrade = (stockCode, type = 'BUY') => {
    const stock = stocks.find((s) => s.code === stockCode);
    if (!stock) return;
    setSelectedStockForTrade(stock);
    setTradeType(type);
    setTradeQty(1);
    setModalType('trade');
  };

  const executeTrade = () => {
    if (!selectedStockForTrade) return;
    
    const stockCode = selectedStockForTrade.code;
    const currentPrice = selectedStockForTrade.price;
    const totalCost = currentPrice * tradeQty * 100; // 1 Lot = 100 lembar
    
    if (tradeType === 'BUY') {
      if (totalCost > buyingPower) {
        showToast('Dana tidak mencukupi untuk melakukan pembelian', 'error');
        return;
      }
      
      setBuyingPower((prev) => prev - totalCost);
      setPortfolio((prevPortfolio) => {
        const existing = prevPortfolio.find((item) => item.code === stockCode);
        if (existing) {
          const totalNewQty = existing.qty + tradeQty;
          const totalNewCost = (existing.avgPrice * existing.qty * 100) + totalCost;
          const newAvgPrice = Math.round(totalNewCost / (totalNewQty * 100));
          return prevPortfolio.map((item) =>
            item.code === stockCode
              ? { ...item, qty: totalNewQty, avgPrice: newAvgPrice, currentPrice }
              : item
          );
        } else {
          return [...prevPortfolio, { code: stockCode, avgPrice: currentPrice, qty: tradeQty, currentPrice }];
        }
      });
      
      const newOrder = {
        id: `ORD-${Date.now().toString().slice(-3)}`,
        code: stockCode,
        type: 'BUY',
        qty: tradeQty,
        price: currentPrice,
        status: 'Matched',
        time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      };
      setOrders([newOrder, ...orders.slice(0, 4)]);
      showToast(`Pembelian ${tradeQty} Lot ${stockCode} MATCHED pada harga Rp${currentPrice.toLocaleString('id-ID')}`, 'success');
      
    } else {
      const existing = portfolio.find((item) => item.code === stockCode);
      if (!existing || existing.qty < tradeQty) {
        showToast('Jumlah lot saham yang Anda miliki tidak mencukupi untuk dijual', 'error');
        return;
      }
      
      setBuyingPower((prev) => prev + totalCost);
      setPortfolio((prevPortfolio) => {
        return prevPortfolio
          .map((item) => {
            if (item.code === stockCode) {
              return { ...item, qty: item.qty - tradeQty };
            }
            return item;
          })
          .filter((item) => item.qty > 0);
      });
      
      const newOrder = {
        id: `ORD-${Date.now().toString().slice(-3)}`,
        code: stockCode,
        type: 'SELL',
        qty: tradeQty,
        price: currentPrice,
        status: 'Matched',
        time: new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }),
      };
      setOrders([newOrder, ...orders.slice(0, 4)]);
      showToast(`Penjualan ${tradeQty} Lot ${stockCode} MATCHED pada harga Rp${currentPrice.toLocaleString('id-ID')}`, 'success');
    }
    
    setModalType(null);
  };

  const topGainers = useMemo(() => {
    return [...stocks].sort((a, b) => b.change - a.change).slice(0, 3);
  }, [stocks]);

  const topLosers = useMemo(() => {
    return [...stocks].sort((a, b) => a.change - b.change).slice(0, 3);
  }, [stocks]);

  // --- DATA GENERATOR UNTUK GRAFIK IHSG ---
  const chartPoints = useMemo(() => {
    const baseValue = 7200; // Baseline IHSG
    const days = chartTimeframe === '7D' ? 7 : 30;
    const points = [];
    
    // Seed generator konsisten berdasarkan nilai ihsgValue saat ini
    for (let i = 0; i < days; i++) {
      const progress = i / (days - 1);
      const trend = (ihsgValue - baseValue) * progress;
      const noise = Math.sin(progress * Math.PI * 2.5) * 45 * (1 - progress * 0.4);
      const val = baseValue + trend + noise + 10;
      points.push(val);
    }
    return points;
  }, [ihsgValue, chartTimeframe]);

  const svgChartPath = useMemo(() => {
    if (chartPoints.length === 0) return '';
    const width = 500;
    const height = 150;
    const padding = 10;
    const maxVal = Math.max(...chartPoints) * 1.002;
    const minVal = Math.min(...chartPoints) * 0.998;
    const valRange = maxVal - minVal;
    
    const coordinates = chartPoints.map((val, index) => {
      const x = padding + (index / (chartPoints.length - 1)) * (width - padding * 2);
      const y = height - padding - ((val - minVal) / valRange) * (height - padding * 2);
      return { x, y };
    });
    
    let d = `M ${coordinates[0].x} ${coordinates[0].y}`;
    for (let i = 1; i < coordinates.length; i++) {
      d += ` L ${coordinates[i].x} ${coordinates[i].y}`;
    }
    
    const closedPath = `${d} L ${coordinates[coordinates.length - 1].x} ${height} L ${coordinates[0].x} ${height} Z`;
    
    return { linePath: d, areaPath: closedPath };
  }, [chartPoints]);

  // --- Menu Sidebar List ---
  const SIDEBAR_ITEMS = [
    { 
      id: 'Dashboard', 
      label: 'Dashboard', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
        </svg>
      )
    },
    { 
      id: 'Portofolio', 
      label: 'Portofolio Detail', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      )
    },
    { 
      id: 'Market', 
      label: 'Pasar Saham', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      )
    },
    { 
      id: 'Watchlist', 
      label: 'Watchlist Saya', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
        </svg>
      )
    },
    { 
      id: 'Aktivitas', 
      label: 'Aktivitas Order', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    { 
      id: 'Pengaturan', 
      label: 'Pengaturan', 
      icon: (
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
    },
  ];

  return (
    <div className="h-screen text-slate-100 font-sans flex overflow-hidden" style={{ backgroundColor: '#0D1117' }}>
      
      {/* ==========================================
          SIDEBAR KIRI PREMIUM (DESIGN.MD ADAPTIVE)
          ========================================== */}
      
      {/* Sidebar Desktop: Always visible */}
      <aside className="hidden lg:flex flex-col w-64 bg-[#161B22] border-r border-[#21262D] py-6 px-4 shrink-0 justify-between h-full overflow-y-auto">
        <div className="space-y-8">
          {/* Logo & Identitas */}
          <div className="flex items-center gap-3 px-2">
            <div className="relative w-9 h-9 overflow-hidden rounded-full flex items-center justify-center bg-[#0F2C59]/40 border border-[#21262D]">
              <img 
                src="logo_teksbawah.png" 
                alt="Mandala Sekuritas Logo" 
                className="object-contain w-8 h-8"
                onError={(e) => {
                  e.target.style.display = 'none';
                  e.target.nextSibling.style.display = 'flex';
                }}
              />
              <div className="hidden absolute inset-0 items-center justify-center bg-gradient-to-br from-[#0F2C59] to-[#161B22]">
                <span className="text-[#E62225] font-extrabold text-sm">M</span>
                <span className="text-white font-extrabold text-sm">S</span>
              </div>
            </div>
            <div>
              <h1 className="text-sm font-bold tracking-wider leading-none text-white">MANDALA</h1>
              <p className="text-[10px] text-[#8B949E] tracking-widest uppercase font-semibold">Sekuritas</p>
            </div>
          </div>

          {/* List Menu */}
          <nav className="space-y-1.5">
            {SIDEBAR_ITEMS.map((item) => {
              const isActive = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveTab(item.id)}
                  className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-lg text-sm font-semibold transition-all duration-200 relative group overflow-hidden ${
                    isActive 
                      ? 'bg-[#E62225]/10 text-white shadow-[inset_4px_0_0_0_#E62225]' 
                      : 'text-[#8B949E] hover:text-white hover:bg-[#21262D]/40 hover:translate-x-1'
                  }`}
                >
                  <span className={`transition-colors ${isActive ? 'text-[#E62225]' : 'text-[#8B949E] group-hover:text-white'}`}>
                    {item.icon}
                  </span>
                  {item.label}
                  {isActive && (
                    <span className="absolute right-3 w-1.5 h-1.5 rounded-full bg-[#E62225] shadow-[0_0_8px_#E62225]"></span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Footer Sidebar (Status Akun & RDN) */}
        <div className="border-t border-[#21262D] pt-4 px-2 space-y-3 mt-6">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-gradient-to-tr from-[#E62225] to-[#0F2C59] border border-[#21262D] flex items-center justify-center font-black text-xs text-white">
              MS
            </div>
            <div>
              <p className="text-xs font-bold text-white">Mandala Investor</p>
              <p className="text-[10px] text-[#8B949E] font-mono">Premium Account</p>
            </div>
          </div>
          <div className="bg-[#0D1117] p-2.5 rounded-lg border border-[#21262D]">
            <p className="text-[9px] text-[#8B949E] uppercase tracking-wider block">ID RDN BCA</p>
            <p className="text-xs font-bold text-slate-100 font-mono">0092-2345-21-1</p>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer Sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden transition-opacity duration-300 ${isSidebarOpen ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}>
        <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={() => setIsSidebarOpen(false)}></div>
        <aside className={`absolute left-0 top-0 bottom-0 w-64 bg-[#161B22] border-r border-[#21262D] p-5 flex flex-col justify-between transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full'}`}>
          <div className="space-y-6">
            <div className="flex justify-between items-center pb-4 border-b border-[#21262D]">
              <div className="flex items-center gap-2.5">
                <span className="text-sm font-bold tracking-wider text-white">MANDALA SEKURITAS</span>
              </div>
              <button onClick={() => setIsSidebarOpen(false)} className="text-[#8B949E] hover:text-white p-1">
                ✕
              </button>
            </div>
            <nav className="space-y-1">
              {SIDEBAR_ITEMS.map((item) => {
                const isActive = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    onClick={() => {
                      setActiveTab(item.id);
                      setIsSidebarOpen(false);
                    }}
                    className={`w-full flex items-center gap-3.5 px-4 py-3 rounded-lg text-sm font-semibold transition-all duration-200 ${
                      isActive 
                        ? 'bg-[#E62225]/10 text-white shadow-[inset_4px_0_0_0_#E62225]' 
                        : 'text-[#8B949E] hover:text-white hover:bg-[#21262D]/40'
                    }`}
                  >
                    <span className={isActive ? 'text-[#E62225]' : 'text-[#8B949E]'}>{item.icon}</span>
                    {item.label}
                  </button>
                );
              })}
            </nav>
          </div>
          <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D] text-xs font-mono">
            <span className="text-[#8B949E] text-[10px] block mb-1">RDN BCA</span>
            <span className="text-white font-bold">0092-2345-21-1</span>
          </div>
        </aside>
      </div>

      {/* ==========================================
          AREA KONTEN UTAMA (KANAN)
          ========================================== */}
      <div className="flex-1 flex flex-col min-w-0 h-screen overflow-hidden relative">
        
        {/* ==========================================
            NAVBAR FLOATING & ROUNDED (GENUINE FLOATING OVERLAY)
            ========================================== */}
        {/* Mengubah header pembungkus luar menjadi absolute, bg-transparent, dan pointer-events-none 
            sehingga element rounded box murni melayang dan content di belakangnya tetap terlihat utuh sewaktu ter-scroll */}
        <header className="absolute top-4 left-0 right-0 z-40 px-4 md:px-6 pointer-events-none">
          <nav className="max-w-7xl mx-auto bg-[#161B22]/95 backdrop-blur-md border border-[#21262D] px-4 md:px-6 py-3 rounded-full flex justify-between items-center shadow-2xl pointer-events-auto">
            <div className="flex items-center gap-3">
              {/* Hamburger Button for Mobile */}
              <button 
                onClick={() => setIsSidebarOpen(true)}
                className="lg:hidden p-2 -ml-2 rounded-full hover:bg-[#21262D] text-[#8B949E] hover:text-white"
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h16" />
                </svg>
              </button>

              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-white tracking-wide bg-[#21262D] py-1 px-3 rounded-full">
                  {activeTab}
                </span>
              </div>
            </div>

            {/* Indikator Status Pasar & IHSG */}
            <div className="flex items-center gap-4 md:gap-6 text-xs">
              <div className="flex items-center gap-2 bg-[#0D1117] py-1.5 px-3 rounded-full border border-[#21262D]">
                <span className="relative flex h-2 w-2">
                  <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${marketStatus === 'OPEN' ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></span>
                  <span className={`relative inline-flex rounded-full h-2 w-2 ${marketStatus === 'OPEN' ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></span>
                </span>
                <span className="font-semibold text-slate-300 text-[10px] md:text-xs">PASAR {marketStatus}</span>
                <button 
                  onClick={() => setMarketStatus(marketStatus === 'OPEN' ? 'CLOSED' : 'OPEN')}
                  className="text-[9px] bg-[#161B22] hover:bg-[#21262D] text-[#8B949E] px-1.5 py-0.5 rounded border border-[#21262D] transition ml-1"
                >
                  Ubah
                </button>
              </div>

              <div className="flex items-center gap-2 font-mono">
                <span className="text-[#8B949E] hidden sm:inline">IHSG:</span>
                <span className="font-bold text-white text-xs md:text-sm">{ihsgValue.toLocaleString('id-ID')}</span>
                <span className={`flex items-center font-bold text-[10px] md:text-xs ${ihsgChange >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                  {ihsgChange >= 0 ? '▲' : '▼'} {Math.abs(ihsgChange)}%
                </span>
              </div>
            </div>

            {/* User Account / Profile */}
            <div className="flex items-center gap-3">
              <div className="text-right hidden md:block">
                <p className="text-[10px] text-[#8B949E] leading-tight">Buying Power</p>
                <p className="text-xs font-bold text-[#10B981] font-mono leading-tight">Rp {buyingPower.toLocaleString('id-ID')}</p>
              </div>
            </div>
          </nav>
        </header>

        {/* ==========================================
            ROUTING INTERAKTIF KONTEN (Dashboard vs Page Mock)
            ========================================== */}
        {/* Memberikan padding-top "pt-24" agar konten awal sejajar rapi di bawah floating navbar, 
            namun ketika di-scroll ke atas, konten mengalir naik melewati celah transparan di sekitar navbar */}
        <div className="p-4 md:p-6 pt-24 md:pt-24 flex-grow overflow-y-auto h-full pb-24">
          
          {activeTab === 'Dashboard' ? (
            <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-12 gap-6 pb-8">
              
              {/* ==================== BARIS ATAS ==================== */}

              {/* SECTION A: RINGKASAN FINANSIAL PENGGUNA (7/12 Kolom) */}
              <section className="lg:col-span-7 bg-[#161B22] border border-[#21262D] rounded-xl p-5 md:p-6 shadow-xl flex flex-col justify-between relative overflow-hidden transition-all duration-300 hover:border-[#E62225]/40 hover:shadow-[0_0_20px_rgba(230,34,37,0.05)]">
                <div className="absolute top-0 left-0 w-2.5 h-full bg-[#E62225]"></div>
                
                <div>
                  <div className="flex justify-between items-start mb-4">
                    <div>
                      <span className="text-[11px] font-semibold text-[#8B949E] uppercase tracking-wider block mb-1">Total Nilai Aset (Net Asset Value)</span>
                      <h2 className="text-3xl md:text-4xl font-extrabold text-white tracking-tight font-mono">
                        Rp {totalNAV.toLocaleString('id-ID')}
                      </h2>
                    </div>
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-md text-xs font-bold ${totalPLAmount >= 0 ? 'bg-[#10B981]/10 text-[#10B981]' : 'bg-[#EF4444]/10 text-[#EF4444]'}`}>
                      {totalPLAmount >= 0 ? '+' : ''}{totalPLPercent.toFixed(2)}% ({totalPLAmount >= 0 ? 'Untung' : 'Rugi'})
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-4 border-t border-[#21262D] pt-4 mb-6">
                    <div>
                      <span className="text-[10px] text-[#8B949E] uppercase tracking-wider block">Total Profit & Loss (P/L)</span>
                      <span className={`text-sm md:text-base font-bold font-mono ${totalPLAmount >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                        {totalPLAmount >= 0 ? '▲' : '▼'} Rp {Math.abs(totalPLAmount).toLocaleString('id-ID')}
                      </span>
                    </div>
                    <div>
                      <span className="text-[10px] text-[#8B949E] uppercase tracking-wider block">Dana Siap Belanja (Buying Power)</span>
                      <span className="text-sm md:text-base font-bold text-white font-mono">
                        Rp {buyingPower.toLocaleString('id-ID')}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Tombol Aksi Cepat */}
                <div className="flex gap-3">
                  <button 
                    onClick={() => setModalType('deposit')}
                    className="flex-1 py-3 px-4 rounded-lg font-bold text-xs uppercase tracking-wider text-white transition-all duration-300 hover:brightness-110 flex items-center justify-center gap-2 border border-[#E62225]/40"
                    style={{ backgroundColor: '#E62225' }}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 4v16m8-8H4"></path></svg>
                    Deposit Dana
                  </button>
                  <button 
                    onClick={() => setModalType('withdraw')}
                    className="flex-1 bg-transparent hover:bg-[#21262D] text-white border border-[#21262D] py-3 px-4 rounded-lg font-bold text-xs uppercase tracking-wider transition-all duration-300 flex items-center justify-center gap-2"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M12 19V5m-7 7h14"></path></svg>
                    Tarik Tunai
                  </button>
                </div>
              </section>

              {/* SECTION B: GRAFIK IHSG (5/12 Kolom) */}
              <section className="lg:col-span-5 bg-[#161B22] border border-[#21262D] rounded-xl p-5 md:p-6 shadow-xl flex flex-col justify-between transition-all duration-300 hover:border-[#21262D]/90">
                <div className="flex justify-between items-center mb-4">
                  <div>
                    <span className="text-[11px] font-semibold text-[#8B949E] uppercase tracking-wider block">Grafik IHSG</span>
                    <span className="text-xs text-slate-400 font-mono">Indeks Harga Saham Gabungan</span>
                  </div>
                  
                  {/* Timeframe Selector */}
                  <div className="flex gap-1 bg-[#0D1117] p-1 rounded-md border border-[#21262D]">
                    {['7D', '1M'].map((tf) => (
                      <button
                        key={tf}
                        onClick={() => setChartTimeframe(tf)}
                        className={`px-2.5 py-1 rounded text-[10px] font-bold transition ${chartTimeframe === tf ? 'bg-[#21262D] text-white' : 'text-[#8B949E] hover:text-white'}`}
                      >
                        {tf}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Area Render Line Chart SVG untuk IHSG */}
                <div className="relative w-full h-36 flex items-end justify-center bg-[#0D1117]/50 rounded-lg p-2 border border-[#21262D] overflow-hidden">
                  <svg viewBox="0 0 500 150" width="100%" height="100%" preserveAspectRatio="none" className="overflow-visible">
                    <defs>
                      <linearGradient id="ihsg-glow" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10B981" stopOpacity="0.25" />
                        <stop offset="100%" stopColor="#10B981" stopOpacity="0.0" />
                      </linearGradient>
                    </defs>
                    
                    {/* Background fill */}
                    {svgChartPath.areaPath && (
                      <path d={svgChartPath.areaPath} fill="url(#ihsg-glow)" />
                    )}
                    
                    {/* Stroke line */}
                    {svgChartPath.linePath && (
                      <path 
                        d={svgChartPath.linePath} 
                        fill="none" 
                        stroke="#10B981" 
                        strokeWidth="2.5"
                        strokeLinecap="round" 
                      />
                    )}
                  </svg>
                  <div className="absolute bottom-2 left-3 right-3 flex justify-between text-[9px] text-[#8B949E] font-mono pointer-events-none">
                    <span>Baseline IHSG: 7.200</span>
                    <span>Live Index: {ihsgValue.toLocaleString('id-ID')}</span>
                  </div>
                </div>
              </section>

              {/* ==================== BARIS KEDUA (GRID 12-KOLOM) ==================== */}

              {/* KOLOM UTAMA / KIRI (7/12 Kolom) */}
              <div className="lg:col-span-7 flex flex-col gap-6">

                {/* SECTION C: RINGKASAN PORTOFOLIO AKTIF (Holding Summary) */}
                <section className="bg-[#161B22] border border-[#21262D] rounded-xl p-5 shadow-xl">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                      <span className="w-2 h-2 rounded-full bg-[#E62225]"></span>
                      Portofolio Aktif Anda
                    </h3>
                    <span className="text-[11px] font-mono text-[#8B949E]">{portfolio.length} Emiten</span>
                  </div>

                  {/* List Table */}
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-[#21262D] text-[#8B949E] uppercase tracking-wider text-[10px]">
                          <th className="pb-2.5 font-semibold">Kode</th>
                          <th className="pb-2.5 font-semibold text-right">Kepemilikan (Lot)</th>
                          <th className="pb-2.5 font-semibold text-right">Harga Rata<sup>2</sup></th>
                          <th className="pb-2.5 font-semibold text-right">Harga Pasar</th>
                          <th className="pb-2.5 font-semibold text-right">P/L Per Saham</th>
                          <th className="pb-2.5 font-semibold text-center">Aksi</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#21262D]/40 font-mono">
                        {portfolio.map((item) => {
                          const marketValue = item.currentPrice * item.qty * 100;
                          const costBasis = item.avgPrice * item.qty * 100;
                          const stockPL = marketValue - costBasis;
                          const stockPLPercent = (stockPL / costBasis) * 100;

                          return (
                            <tr key={item.code} className="hover:bg-[#1f2631]/20 transition-all duration-150">
                              <td className="py-3 font-bold text-white text-sm">
                                {item.code}
                              </td>
                              <td className="py-3 text-right text-slate-200">
                                {item.qty} Lot <span className="text-[10px] text-[#8B949E] block">({(item.qty * 100).toLocaleString('id-ID')} lbr)</span>
                              </td>
                              <td className="py-3 text-right text-[#8B949E]">
                                Rp {item.avgPrice.toLocaleString('id-ID')}
                              </td>
                              <td className="py-3 text-right font-semibold text-slate-100">
                                Rp {item.currentPrice.toLocaleString('id-ID')}
                              </td>
                              <td className={`py-3 text-right font-bold ${stockPL >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                                {stockPL >= 0 ? '+' : ''}{stockPLPercent.toFixed(1)}%
                                <span className="text-[10px] block font-normal text-slate-400">
                                  Rp {(stockPL / 100).toLocaleString('id-ID')} / lot
                                </span>
                              </td>
                              <td className="py-3 text-center">
                                <div className="flex gap-1.5 justify-center">
                                  <button
                                    onClick={() => handleOpenTrade(item.code, 'BUY')}
                                    className="px-2 py-1 rounded bg-[#10B981]/10 text-[#10B981] font-bold text-[10px] uppercase hover:bg-[#10B981]/25 transition"
                                  >
                                    Beli
                                  </button>
                                  <button
                                    onClick={() => handleOpenTrade(item.code, 'SELL')}
                                    className="px-2 py-1 rounded bg-[#EF4444]/10 text-[#EF4444] font-bold text-[10px] uppercase hover:bg-[#EF4444]/25 transition"
                                  >
                                    Jual
                                  </button>
                                </div>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="mt-4 border-t border-[#21262D] pt-3 flex justify-between items-center text-xs">
                    <span className="text-[#8B949E]">Menampilkan ringkasan holding utama</span>
                    <button 
                      onClick={() => setActiveTab('Portofolio')}
                      className="text-white hover:text-[#E62225] font-bold transition flex items-center gap-1"
                    >
                      Lihat Semua Portofolio 
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M9 5l7 7-7 7"></path></svg>
                    </button>
                  </div>
                </section>

                {/* SECTION F: AKTIVITAS TERAKHIR (Recent Orders) */}
                <section className="bg-[#161B22] border border-[#21262D] rounded-xl p-5 shadow-xl">
                  <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-4 flex items-center gap-2">
                    <svg className="w-4 h-4 text-[#8B949E]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"></path></svg>
                    Antrean Order Terakhir (Recent Orders)
                  </h3>

                  <div className="divide-y divide-[#21262D]/60">
                    {orders.map((order) => (
                      <div key={order.id} className="py-3 flex justify-between items-center text-xs font-mono">
                        <div className="flex items-center gap-3">
                          <span className={`w-8 h-8 rounded-lg flex items-center justify-center font-bold text-[10px] ${order.type === 'BUY' ? 'bg-[#10B981]/15 text-[#10B981]' : 'bg-[#EF4444]/15 text-[#EF4444]'}`}>
                            {order.type}
                          </span>
                          <div>
                            <span className="text-sm font-bold text-white block">{order.code}</span>
                            <span className="text-[10px] text-[#8B949E]">{order.time} WIB</span>
                          </div>
                        </div>

                        <div className="text-right">
                          <span className="text-slate-100 block">{order.qty} Lot @ Rp {order.price.toLocaleString('id-ID')}</span>
                          <span className="text-[10px] text-[#8B949E] block">Total: Rp {(order.qty * order.price * 100).toLocaleString('id-ID')}</span>
                        </div>

                        <div>
                          <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                            order.status === 'Matched' ? 'bg-[#10B981]/10 text-[#10B981]' : 
                            order.status === 'Pending' ? 'bg-yellow-500/10 text-yellow-500 animate-pulse' : 'bg-slate-500/10 text-slate-500'
                          }`}>
                            {order.status}
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
                </section>

                {/* SECTION G: AGENDA & IPO HIGHLIGHT */}
                <section className="bg-[#161B22] border border-[#21262D] rounded-xl p-5 shadow-xl grid grid-cols-1 md:grid-cols-2 gap-5">
                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#E62225]"></span>
                      Highlight e-IPO
                    </h4>
                    <div className="bg-[#0D1117] p-3.5 rounded-lg border border-[#21262D] flex flex-col justify-between h-32 relative overflow-hidden">
                      <div>
                        <span className="text-[10px] bg-red-950 text-[#E62225] font-bold px-2 py-0.5 rounded-md border border-[#E62225]/30">ACTIVE</span>
                        <p className="text-sm font-bold text-slate-100 mt-2 mb-1">MANDALA ENERGY INDONESIA (MEI)</p>
                        <p className="text-[10px] text-[#8B949E] font-mono">Bookbuilding: Rp 210 - Rp 250</p>
                      </div>
                      <div className="flex justify-between items-center text-[10px] mt-2 pt-2 border-t border-[#21262D]">
                        <span className="text-[#8B949E]">Listing: 14 Juli 2026</span>
                        <button 
                          onClick={() => {
                            setSelectedStockForTrade({ code: 'MEI', price: 230 });
                            setTradeType('BUY');
                            setTradeQty(10);
                            setModalType('trade');
                          }}
                          className="text-[#E62225] hover:underline font-bold"
                        >
                          Pesan IPO ↗
                        </button>
                      </div>
                    </div>
                  </div>

                  <div>
                    <h4 className="text-xs font-bold uppercase tracking-wider text-white mb-3 flex items-center gap-2">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#E62225]"></span>
                      Aksi Korporasi Portofolio
                    </h4>
                    <div className="bg-[#0D1117] p-3.5 rounded-lg border border-[#21262D] flex flex-col justify-between h-32">
                      <div>
                        <span className="text-[10px] bg-emerald-950 text-[#10B981] font-bold px-2 py-0.5 rounded-md border border-[#10B981]/30">DIVIDEND</span>
                        <p className="text-sm font-bold text-slate-100 mt-2 mb-1">BBCA akan membagikan dividen</p>
                        <p className="text-[10px] text-[#8B949E]">Sebesar Rp 220,- / lembar saham</p>
                      </div>
                      <div className="flex justify-between items-center text-[10px] mt-2 pt-2 border-t border-[#21262D]">
                        <span className="text-[#8B949E] font-mono">Cum Date: Besok</span>
                        <span className="text-slate-300 font-semibold font-mono">IDR 3.3M Estimasi Masuk</span>
                      </div>
                    </div>
                  </div>
                </section>

              </div>

              {/* KOLOM KANAN / SIDEBAR UTAMA (5/12 Kolom) */}
              <div className="lg:col-span-5 flex flex-col gap-6">
                
                {/* SECTION D: KONDISI PASAR & INDEKS SAHAM */}
                <section className="bg-[#161B22] border border-[#21262D] rounded-xl p-5 shadow-xl">
                  <div className="flex justify-between items-center mb-4 pb-2 border-b border-[#21262D]">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                      <svg className="w-4 h-4 text-[#8B949E]" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6"></path></svg>
                      Pergerakan Emiten Hari Ini
                    </h3>
                    <span className="text-[10px] text-[#10B981] font-bold animate-pulse">LIVE FEED</span>
                  </div>

                  {/* Tabbed Component (Gainers / Losers) */}
                  <div className="grid grid-cols-2 gap-2 mb-4">
                    <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D]">
                      <p className="text-[10px] uppercase font-bold text-[#10B981] tracking-wider mb-2">🚀 TOP GAINERS</p>
                      <div className="flex flex-col gap-2">
                        {topGainers.map((g) => (
                          <div 
                            key={g.code} 
                            onClick={() => handleOpenTrade(g.code, 'BUY')}
                            className="flex justify-between items-center cursor-pointer hover:bg-[#161B22] p-1 rounded transition"
                          >
                            <span className="font-bold text-xs text-white">{g.code}</span>
                            <span className="text-xs font-mono font-bold text-[#10B981]">+{g.change}%</span>
                          </div>
                        ))}
                      </div>
                    </div>

                    <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D]">
                      <p className="text-[10px] uppercase font-bold text-[#EF4444] tracking-wider mb-2">📉 TOP LOSERS</p>
                      <div className="flex flex-col gap-2">
                        {topLosers.map((l) => (
                          <div 
                            key={l.code} 
                            onClick={() => handleOpenTrade(l.code, 'BUY')}
                            className="flex justify-between items-center cursor-pointer hover:bg-[#161B22] p-1 rounded transition"
                          >
                            <span className="font-bold text-xs text-white">{l.code}</span>
                            <span className="text-xs font-mono font-bold text-[#EF4444]">{l.change}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </section>

                {/* SECTION E: WATCHLIST RINGKAS (Daftar Pantauan) */}
                <section className="bg-[#161B22] border border-[#21262D] rounded-xl p-5 shadow-xl">
                  <div className="flex justify-between items-center mb-4">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-white flex items-center gap-2">
                      <svg className="w-4 h-4 text-yellow-500 fill-current" viewBox="0 0 20 20"><path d="M9.049 2.927c.3-.921 1.603-.921 1.902 0l1.07 3.292a1 1 0 00.95.69h3.462c.969 0 1.371 1.24.588 1.81l-2.8 2.034a1 1 0 00-.364 1.118l1.07 3.292c.3.921-.755 1.688-1.54 1.118l-2.8-2.034a1 1 0 00-1.175 0l-2.8 2.034c-.784.57-1.838-.197-1.539-1.118l1.07-3.292a1 1 0 00-.364-1.118L2.98 8.72c-.783-.57-.38-1.81.588-1.81h3.461a1 1 0 00.951-.69l1.07-3.292z"></path></svg>
                      Daftar Pantauan (Watchlist)
                    </h3>
                    <span className="text-[10px] text-[#8B949E] font-semibold">Bintang untuk Hapus</span>
                  </div>

                  <div className="flex flex-col gap-2.5">
                    {stocks.map((stock) => {
                      const isStarred = watchlist.includes(stock.code);
                      if (!isStarred) return null;

                      return (
                        <div 
                          key={stock.code} 
                          className="bg-[#0D1117] hover:border-[#21262D]/90 border border-transparent p-3 rounded-lg flex justify-between items-center transition"
                        >
                          <div className="flex items-center gap-2.5">
                            <button 
                              onClick={() => toggleWatchlist(stock.code)} 
                              className="text-yellow-500 hover:scale-110 transition"
                            >
                              ★
                            </button>
                            <div>
                              <span className="font-bold text-sm text-white block">{stock.code}</span>
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
                              Rp {stock.price.toLocaleString('id-ID')}
                            </span>
                            <span className={`text-[10px] font-bold font-mono ${stock.change >= 0 ? 'text-[#10B981]' : 'text-[#EF4444]'}`}>
                              {stock.change >= 0 ? '+' : ''}{stock.change}%
                            </span>
                          </div>

                          <div className="ml-2">
                            <button 
                              onClick={() => handleOpenTrade(stock.code, 'BUY')}
                              className="bg-[#E62225] text-white font-bold text-[10px] px-2.5 py-1.5 rounded hover:brightness-110 transition"
                            >
                              Beli
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  <div className="mt-4 pt-3 border-t border-[#21262D]">
                    <span className="text-[11px] text-[#8B949E] block mb-2">Tambahkan Saham Lain ke Pantauan:</span>
                    <div className="flex flex-wrap gap-1.5">
                      {stocks.map((s) => {
                        if (watchlist.includes(s.code)) return null;
                        return (
                          <button
                            key={s.code}
                            onClick={() => toggleWatchlist(s.code)}
                            className="bg-[#0D1117] hover:bg-[#21262D] text-xs font-mono text-slate-300 px-2 py-1 rounded border border-[#21262D] transition"
                          >
                            + {s.code}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </section>

              </div>

            </div>
          ) : (
            /* ==========================================
               SIDEBAR ROUTE PLACEHOLDER
               ========================================== */
            <div className="max-w-4xl mx-auto py-16 text-center">
              <div className="bg-[#161B22] border border-[#21262D] p-8 md:p-12 rounded-2xl shadow-2xl relative overflow-hidden">
                <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-[#E62225] via-[#0F2C59] to-[#E62225]"></div>
                <div className="w-16 h-16 mx-auto bg-[#E62225]/10 rounded-full flex items-center justify-center text-[#E62225] mb-6">
                  {SIDEBAR_ITEMS.find(item => item.id === activeTab)?.icon}
                </div>
                <h3 className="text-2xl font-black text-white mb-3">Halaman {SIDEBAR_ITEMS.find(item => item.id === activeTab)?.label}</h3>
                <p className="text-[#8B949E] max-w-md mx-auto text-sm mb-8 leading-relaxed">
                  Halaman ini dikonfigurasi melalui integrasi sidebar. Hubungkan API data Mandala Sekuritas untuk menyinkronkan visualisasi data riil di halaman ini.
                </p>
                <button 
                  onClick={() => setActiveTab('Dashboard')}
                  className="bg-[#E62225] hover:brightness-110 text-white font-bold text-xs py-3 px-6 rounded-lg uppercase tracking-wider transition-all duration-300 inline-flex items-center gap-2"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2.5" d="M10 19l-7-7m0 0l7-7m-7 7h18"></path></svg>
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#161B22] border border-[#21262D] rounded-xl w-full max-w-md p-6 relative">
            <h3 className="text-lg font-bold text-white mb-2">Deposit Dana ke RDN</h3>
            <p className="text-xs text-[#8B949E] mb-4">Suntik dana secara instan untuk memperluas Buying Power akun Mandala Sekuritas Anda.</p>
            
            <form onSubmit={handleDeposit} className="space-y-4">
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
                  className="flex-1 bg-[#0D1117] border border-[#21262D] hover:bg-[#21262D] text-xs font-bold text-white py-2.5 rounded-lg transition"
                >
                  Batal
                </button>
                <button 
                  type="submit" 
                  className="flex-1 text-white font-bold text-xs py-2.5 rounded-lg transition"
                  style={{ backgroundColor: '#E62225' }}
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
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#161B22] border border-[#21262D] rounded-xl w-full max-w-md p-6 relative">
            <h3 className="text-lg font-bold text-white mb-2">Tarik Dana Ke Rekening Bank</h3>
            <p className="text-xs text-[#8B949E] mb-4">Mencairkan dana dari Buying Power ke rekening bank pribadi Anda terdaftar.</p>
            
            <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D] mb-4 text-xs font-mono">
              <div className="flex justify-between mb-1">
                <span className="text-[#8B949E]">Dana Maksimal Ditarik:</span>
                <span className="text-white font-bold">Rp {buyingPower.toLocaleString('id-ID')}</span>
              </div>
            </div>

            <form onSubmit={handleWithdraw} className="space-y-4">
              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Bank Penerima</label>
                <div className="bg-[#0D1117] border border-[#21262D] rounded-lg p-2.5 text-xs text-slate-300">
                  <span className="font-bold block">BCA (AKUN TERDAFTAR)</span>
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
                  className="flex-1 bg-[#0D1117] border border-[#21262D] hover:bg-[#21262D] text-xs font-bold text-white py-2.5 rounded-lg transition"
                >
                  Batal
                </button>
                <button 
                  type="submit" 
                  className="flex-1 text-white font-bold text-xs py-2.5 rounded-lg transition"
                  style={{ backgroundColor: '#E62225' }}
                >
                  Konfirmasi Tarik Dana
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Modal 3: TRADE CONSOLE (Beli / Jual Saham) */}
      {modalType === 'trade' && selectedStockForTrade && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm">
          <div className="bg-[#161B22] border border-[#21262D] rounded-xl w-full max-w-md p-6 relative">
            
            <div className="flex justify-between items-start mb-4">
              <div>
                <span className="text-[10px] bg-[#0F2C59] text-white px-2.5 py-0.5 rounded-full font-bold uppercase tracking-widest">Mandala Orderbook</span>
                <h3 className="text-2xl font-black text-white mt-1 leading-none">{selectedStockForTrade.code}</h3>
                <span className="text-[11px] text-[#8B949E]">{selectedStockForTrade.name || 'Simulasi IPO'}</span>
              </div>
              
              <div className="text-right">
                <span className="text-xs text-[#8B949E] block">Harga Terakhir</span>
                <span className="text-lg font-mono font-bold text-white">Rp {selectedStockForTrade.price.toLocaleString('id-ID')}</span>
              </div>
            </div>

            {/* Toggle Buy / Sell */}
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-[#0D1117] rounded-lg border border-[#21262D] mb-4">
              <button 
                type="button"
                onClick={() => setTradeType('BUY')}
                className={`py-2 text-xs font-bold rounded-md uppercase transition ${tradeType === 'BUY' ? 'bg-[#10B981] text-white shadow-md' : 'text-[#8B949E] hover:text-white'}`}
              >
                Beli (Buy)
              </button>
              <button 
                type="button"
                onClick={() => setTradeType('SELL')}
                className={`py-2 text-xs font-bold rounded-md uppercase transition ${tradeType === 'SELL' ? 'bg-[#EF4444] text-white shadow-md' : 'text-[#8B949E] hover:text-white'}`}
              >
                Jual (Sell)
              </button>
            </div>

            {/* Info RDN & Batas Kepemilikan */}
            <div className="bg-[#0D1117] p-3 rounded-lg border border-[#21262D] text-xs font-mono mb-4 space-y-1">
              <div className="flex justify-between">
                <span className="text-[#8B949E]">Dana RDN Tersedia:</span>
                <span className="text-white font-bold">Rp {buyingPower.toLocaleString('id-ID')}</span>
              </div>
              {tradeType === 'SELL' && (
                <div className="flex justify-between">
                  <span className="text-[#8B949E]">Kepemilikan Anda:</span>
                  <span className="text-white font-bold">
                    {(portfolio.find((p) => p.code === selectedStockForTrade.code)?.qty || 0)} Lot
                  </span>
                </div>
              )}
            </div>

            {/* Input Form */}
            <div className="space-y-4">
              <div>
                <label className="text-xs text-[#8B949E] uppercase font-bold tracking-wider block mb-1">Jumlah Pembelian (LOT)</label>
                <div className="flex items-center">
                  <button 
                    type="button"
                    onClick={() => setTradeQty(Math.max(1, tradeQty - 1))}
                    className="bg-[#0D1117] border border-[#21262D] text-white font-bold w-12 h-12 rounded-l-lg hover:bg-[#21262D] transition text-center"
                  >
                    -
                  </button>
                  <input 
                    type="number" 
                    value={tradeQty}
                    onChange={(e) => setTradeQty(Math.max(1, parseInt(e.target.value) || 1))}
                    className="flex-1 bg-[#0D1117] border-y border-[#21262D] h-12 text-center text-sm font-bold text-white focus:outline-none font-mono"
                    min="1"
                  />
                  <button 
                    type="button"
                    onClick={() => setTradeQty(tradeQty + 1)}
                    className="bg-[#0D1117] border border-[#21262D] text-white font-bold w-12 h-12 rounded-r-lg hover:bg-[#21262D] transition text-center"
                  >
                    +
                  </button>
                </div>
                <span className="text-[10px] text-[#8B949E] mt-1 block text-right font-mono">
                  = {(tradeQty * 100).toLocaleString('id-ID')} Lembar Saham
                </span>
              </div>

              {/* Total Estimasi Transaksi */}
              <div className="border-t border-[#21262D] pt-4 space-y-2">
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-[#8B949E]">Estimasi Transaksi:</span>
                  <span className="text-slate-300">Rp {(tradeQty * selectedStockForTrade.price * 100).toLocaleString('id-ID')}</span>
                </div>
                <div className="flex justify-between text-xs font-mono">
                  <span className="text-[#8B949E]">Biaya Broker (0.15%):</span>
                  <span className="text-slate-300">Rp {Math.round(tradeQty * selectedStockForTrade.price * 100 * 0.0015).toLocaleString('id-ID')}</span>
                </div>
                <div className="flex justify-between text-sm font-mono font-bold border-t border-[#21262D]/60 pt-2 text-white">
                  <span>Total Tagihan:</span>
                  <span>Rp {Math.round((tradeQty * selectedStockForTrade.price * 100) * 1.0015).toLocaleString('id-ID')}</span>
                </div>
              </div>

              <div className="flex gap-3 pt-2">
                <button 
                  type="button" 
                  onClick={() => setModalType(null)}
                  className="flex-1 bg-[#0D1117] border border-[#21262D] hover:bg-[#21262D] text-xs font-bold text-white py-3 rounded-lg transition"
                >
                  Batal
                </button>
                <button 
                  type="button" 
                  onClick={executeTrade}
                  className={`flex-1 text-white font-bold text-xs py-3 rounded-lg transition ${tradeType === 'BUY' ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}
                >
                  Kirim Order {tradeType === 'BUY' ? 'Beli' : 'Jual'}
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
        <div className="fixed bottom-6 right-6 z-50 flex items-center gap-3 bg-[#161B22] border-l-4 border-l-[#10B981] p-4 rounded-r-lg shadow-2xl animate-bounce"
             style={{ 
               borderLeftColor: toast.type === 'success' ? '#10B981' : '#EF4444',
               borderWidth: '1px',
               borderLeftWidth: '4px',
               borderColor: '#21262D'
             }}>
          <div className="flex-1">
            <p className="text-xs text-white font-bold">{toast.message}</p>
          </div>
          <button onClick={() => setToast(null)} className="text-slate-400 hover:text-white font-bold text-xs">
            ✕
          </button>
        </div>
      )}

    </div>
  );
}