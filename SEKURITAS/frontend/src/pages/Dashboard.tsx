import { useEffect, useState, useMemo, useRef } from 'react';
import { useNavigate, useLocation, Link, Outlet } from 'react-router-dom';
import { formatMarketSessionLabel, isOrderEntrySessionStatus, normalizeSessionStatus, useStore } from '../store/useStore';
import { resolveMarketWsUrl, resolveUserWsUrl } from '../config/endpoints';
import { 
  LogOut, 
  Wallet, 
  X,
  Plus
} from 'lucide-react';

const LOT_SIZE = 100;

export default function Dashboard() {
  const navigate = useNavigate();
  const location = useLocation();

  // --- Store States ---
  const user = useStore(state => state.user);
  const logout = useStore(state => state.logout);
  const portfolio = useStore(state => state.portfolio);
  const feeSchedule = useStore(state => state.feeSchedule);
  const accountProfile = useStore(state => state.accountProfile);
  const market = useStore(state => state.market);
  const error = useStore(state => state.error);
  const orderActionLoading = useStore(state => state.orderActionLoading);
  const securities = useStore(state => state.securities);

  // --- Store Actions ---
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchOrders = useStore(state => state.fetchOrders);
  const fetchMarketData = useStore(state => state.fetchMarketData);
  const fetchMarketSession = useStore(state => state.fetchMarketSession);
  const fetchAccountProfile = useStore(state => state.fetchAccountProfile);
  const placeOrder = useStore(state => state.placeOrder);
  const applyMarketEvent = useStore(state => state.applyMarketEvent);
  const applyUserEvent = useStore(state => state.applyUserEvent);
  const depositFunds = useStore(state => state.depositFunds);
  const withdrawFunds = useStore(state => state.withdrawFunds);
  const setMarketConnected = useStore(state => state.setMarketConnected);

  // --- Local States ---
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

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
  const userSocketRef = useRef<WebSocket | null>(null);
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
    fetchMarketSession();
    fetchAccountProfile();

    const interval = setInterval(() => {
      fetchPortfolio();
      fetchOrders();
    }, 5000);

    return () => {
      clearInterval(interval);
    };
  }, [fetchAccountProfile, fetchMarketData, fetchMarketSession, fetchOrders, fetchPortfolio]);

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
        setMarketConnected(false);
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
      const socket = socketRef.current;
      if (socket) {
        socket.onmessage = null;
        if (socket.readyState === WebSocket.CONNECTING) {
          // Avoid triggering "closed before connection established" warning by waiting until open to close.
          // Set empty handlers so error/close events don't trigger state updates or reconnects.
          socket.onopen = () => {
            socket.close();
          };
          socket.onerror = () => {
            // Ignore error after unmount
          };
          socket.onclose = () => {
            // Ignore close after unmount
          };
        } else {
          socket.onopen = null;
          socket.onerror = null;
          socket.onclose = null;
          socket.close();
        }
      }
    };
  }, [applyMarketEvent, setMarketConnected]);

  // --- WebSocket Connection for User Updates ---
  useEffect(() => {
    const token = useStore.getState().token;
    if (!token) return;

    let delay = 1000;
    const MAX_DELAY = 30000;

    function connectUser() {
      if (!mountedRef.current) return;
      const wsUrl = `${resolveUserWsUrl()}?token=${token}`;
      const socket = new WebSocket(wsUrl);
      userSocketRef.current = socket;

      socket.onmessage = (event) => {
        try {
          applyUserEvent(JSON.parse(event.data));
        } catch {
          // Ignore parse errors
        }
      };

      socket.onopen = () => { delay = 1000; };
      socket.onerror = (err) => { socket.close(); };
      socket.onclose = () => {
        if (!mountedRef.current) return;
        setTimeout(() => {
          delay = Math.min(delay * 2, MAX_DELAY);
          connectUser();
        }, delay);
      };
    }

    connectUser();

    return () => {
      const socket = userSocketRef.current;
      if (socket) {
        socket.onmessage = null;
        if (socket.readyState === WebSocket.CONNECTING) {
          socket.onopen = () => socket.close();
        } else {
          socket.close();
        }
      }
    };
  }, [applyUserEvent]);

  // --- Deposit & Withdraw Local State Handlers ---
  const handleDepositSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const amount = parseFloat(depositAmount);
    if (isNaN(amount) || amount <= 0) {
      showToast('Masukkan jumlah deposit yang valid', 'error');
      return;
    }
    try {
      await depositFunds(amount);
      setDepositAmount('');
      setModalType(null);
      const simulasiText = import.meta.env.PROD ? '' : ' (Simulasi)';
      showToast(`Berhasil deposit Rp ${amount.toLocaleString('id-ID')}${simulasiText}`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Deposit belum tersedia', 'error');
    }
  };

  const handleWithdrawSubmit = async (e: React.FormEvent) => {
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
    try {
      await withdrawFunds(amount);
      setWithdrawAmount('');
      setModalType(null);
      const simulasiText = import.meta.env.PROD ? '' : ' (Simulasi)';
      showToast(`Berhasil penarikan Rp ${amount.toLocaleString('id-ID')}${simulasiText}`, 'success');
    } catch (err: any) {
      showToast(err.message || 'Penarikan belum tersedia', 'error');
    }
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

  // --- Logout ---
  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  // --- Financial Calculations ---
  const rawCashAvailable = parseFloat(portfolio?.cash?.available || '0');
  const rawCashReserved = parseFloat(portfolio?.cash?.reserved || '0');
  const rawCashPending = parseFloat(portfolio?.cash?.pending || '0');

  // RDN final
  const buyingPower = Math.max(0, rawCashAvailable);

  // --- Sidebar & Active Path Config ---
  const activePath = location.pathname;

  const SIDEBAR_ITEMS = [
    { 
      id: 'Dashboard', 
      label: 'Dashboard', 
      path: '/dashboard',
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2V6zM14 6a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2V6zM4 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2H6a2 2 0 01-2-2v-4zM14 16a2 2 0 012-2h2a2 2 0 012 2v4a2 2 0 01-2 2h-2a2 2 0 01-2-2v-4z" />
        </svg>
      )
    },
    { 
      id: 'Portofolio', 
      label: 'Portofolio Detail', 
      path: '/portfolio',
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" />
        </svg>
      )
    },
    { 
      id: 'Market', 
      label: 'Pasar Saham', 
      path: '/market',
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
        </svg>
      )
    },
    { 
      id: 'Aktivitas', 
      label: 'Aktivitas Order', 
      path: '/activity',
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
        </svg>
      )
    },
    { 
      id: 'Pengaturan', 
      label: 'Pengaturan', 
      path: '/settings',
      icon: (
        <svg className="w-5 h-5" width={20} height={20} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      )
    }
  ];

  return (
    <div className="dashboard-container-premium">
      
      {/* ==========================================
          SIDEBAR KIRI LAYOUT WRAPPER
          ========================================== */}
      
      {/* Sidebar Desktop */}
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

          {/* List Menu Navigasi Link */}
          <nav className="sidebar-menu-list">
            {SIDEBAR_ITEMS.map((item) => {
              const isActive = activePath === item.path;
              return (
                <Link
                  key={item.id}
                  to={item.path}
                  className={`sidebar-menu-item ${isActive ? 'active' : ''}`}
                  style={{ textDecoration: 'none' }}
                >
                  <span style={{ color: isActive ? '#E62225' : '#8B949E', display: 'flex', alignItems: 'center' }}>
                    {item.icon}
                  </span>
                  {item.label}
                  {isActive && (
                    <span className="sidebar-menu-indicator-dot"></span>
                  )}
                </Link>
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
                const isActive = activePath === item.path;
                return (
                  <Link
                    key={item.id}
                    to={item.path}
                    onClick={() => setIsSidebarOpen(false)}
                    className={`sidebar-menu-item ${isActive ? 'active' : ''}`}
                    style={{ textDecoration: 'none' }}
                  >
                    <span style={{ color: isActive ? '#E62225' : '#8B949E', display: 'flex', alignItems: 'center' }}>{item.icon}</span>
                    {item.label}
                  </Link>
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
        
        {/* NAVBAR FLOATING */}
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
                  {SIDEBAR_ITEMS.find(item => activePath === item.path)?.label || 'Mandala'}
                </span>
              </div>
            </div>

            {/* Indikator Status Pasar & IHSG */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
              {(() => {
                const isKnown = Boolean(normalizeSessionStatus(market.sessionStatus));
                const isOpen = isOrderEntrySessionStatus(market.sessionStatus);
                const indicatorBg = isOpen ? 'rgba(16, 185, 129, 0.1)' : (isKnown ? 'rgba(239, 68, 68, 0.1)' : 'rgba(245, 158, 11, 0.1)');
                const indicatorBorder = isOpen ? '1px solid rgba(16, 185, 129, 0.3)' : (isKnown ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid rgba(245, 158, 11, 0.3)');
                const indicatorColor = isOpen ? '#10B981' : (isKnown ? '#EF4444' : '#F59E0B');
                return (
                  <div 
                    id="market-status-indicator"
                    className="flex items-center gap-2 py-1.5 px-3 rounded-full text-xs"
                    style={{ backgroundColor: indicatorBg, border: indicatorBorder }}
                  >
                    <span className="relative flex h-2 w-2" style={{ display: 'inline-flex' }}>
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-75" style={{ backgroundColor: indicatorColor }}></span>
                      <span 
                        className="relative inline-flex rounded-full h-2 w-2"
                        style={{
                          backgroundColor: indicatorColor
                        }}
                      ></span>
                    </span>
                    <span className="font-semibold text-slate-300 uppercase hidden-mobile" style={{ fontSize: '11px' }}>
                      {formatMarketSessionLabel(market.sessionStatus)}
                    </span>
                  </div>
                );
              })()}
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
                <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
              </button>
            </div>
          </nav>
        </header>

        {/* ==========================================
            ROUTING OUTLET (Merender sub-halaman berdasarkan route)
            ========================================== */}
        <div className="scrollable-dashboard-content">
          <Outlet context={{ 
            onOpenTrade: handleOpenTrade, 
            onOpenDeposit: () => setModalType('deposit'), 
            onOpenWithdraw: () => setModalType('withdraw'),
            buyingPower 
          }} />
        </div>
      </div>

      {/* ==========================================
          MODALS & OVERLAYS INTERAKTIF (Terpusat di Layout)
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
            
            {import.meta.env.PROD ? (
              <div className="space-y-4 mt-4">
                <div className="p-4 rounded-lg text-center" style={{ backgroundColor: '#0D1117', border: '1px solid #21262D' }}>
                  <p className="text-xs text-[#8B949E] mb-2 uppercase font-bold tracking-wider">Rekening Dana Nasabah (RDN)</p>
                  <p className="text-xl text-white font-mono font-bold mb-1 tracking-wider">
                    {accountProfile?.references?.rdn || 'Memproses...'}
                  </p>
                  <p className="text-xs text-white">Bank Mandala CB</p>
                </div>
                <p className="text-xs text-[#8B949E] text-center mb-4">
                  Silakan lakukan transfer dari rekening bank pribadi Anda ke nomor RDN di atas. Saldo akan otomatis bertambah setelah transfer berhasil.
                </p>
                <div className="flex pt-2">
                  <button 
                    onClick={() => {
                      if (accountProfile?.references?.rdn) {
                        navigator.clipboard.writeText(accountProfile.references.rdn);
                        showToast('Nomor RDN disalin ke clipboard', 'success');
                      }
                    }}
                    className="flex-grow btn-secondary-dark py-2.5 rounded-lg text-xs"
                  >
                    Salin Nomor RDN
                  </button>
                </div>
              </div>
            ) : (
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
            )}
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
              <div className="p-2.5 text-xs text-slate-300 rounded-lg mb-4" style={{ backgroundColor: '#0D1117', border: '1px solid #21262D' }}>
                <span className="font-bold block text-white">KE REKENING TERDAFTAR</span>
                <span className="text-[10px] text-[#8B949E]">Dana akan ditransfer otomatis ke rekening induk utama Anda di Bank Mandala CB.</span>
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

      {/* Modal 3: TRADE CONSOLE */}
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

            {/* Info RDN */}
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

      {/* TOAST POPUP */}
      {toast && (
        <div 
          className="toast-premium"
          style={{ borderLeftColor: toast.type === 'success' ? '#10B981' : '#EF4444' }}
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
