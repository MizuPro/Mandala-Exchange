import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import Portfolio from '../components/Portfolio';
import OrderEntry from '../components/OrderEntry';
import OrderList from '../components/OrderList';
import MarketPanel from '../components/MarketPanel';
import CompanyPanel from '../components/CompanyPanel';
import AccountProfile from '../components/AccountProfile';
import SettlementPanel from '../components/SettlementPanel';
import Leaderboard from '../components/Leaderboard';
import Notifications from '../components/Notifications';
import { LogOut, Activity } from 'lucide-react';

export default function Dashboard() {
  const user = useStore(state => state.user);
  const logout = useStore(state => state.logout);
  const fetchPortfolio = useStore(state => state.fetchPortfolio);
  const fetchOrders = useStore(state => state.fetchOrders);
  const fetchMarketData = useStore(state => state.fetchMarketData);
  const applyMarketEvent = useStore(state => state.applyMarketEvent);
  const market = useStore(state => state.market);
  const error = useStore(state => state.error);
  const navigate = useNavigate();

  useEffect(() => {
    fetchPortfolio();
    fetchOrders();
    fetchMarketData();
    const interval = setInterval(() => {
      fetchPortfolio();
      fetchOrders();
    }, 5000);
    return () => clearInterval(interval);
  }, []);

  useEffect(() => {
    const wsBase = import.meta.env.VITE_MATS_WS_URL;
    if (!wsBase) return;
    const token = import.meta.env.VITE_MATS_MARKET_TOKEN;
    const url = token ? `${wsBase}${wsBase.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : wsBase;
    const socket = new WebSocket(url);
    socket.onmessage = (event) => {
      try {
        applyMarketEvent(JSON.parse(event.data));
      } catch {
        // Ignore malformed market data frames.
      }
    };
    return () => socket.close();
  }, [applyMarketEvent]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <>
      <nav className="navbar">
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
          <Activity color="var(--primary)" size={24} />
          <span className="navbar-brand">Mandala Sekuritas</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <span className="text-muted">{user?.email}</span>
          <button onClick={handleLogout} style={{ background: 'transparent', color: 'var(--danger)', padding: '0.5rem' }}>
            <LogOut size={20} />
          </button>
        </div>
      </nav>

      <main className="container animate-fade-in">
        {error && (
          <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem', color: 'var(--warning)' }}>
            {error}
          </div>
        )}
        {(market.sessionStatus || Object.keys(market.lastPrices).length > 0) && (
          <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1rem', display: 'flex', gap: '1.5rem', flexWrap: 'wrap', alignItems: 'center' }}>
            <span className="text-muted">
              Session: <strong style={{ color: 'var(--text-main)' }}>{market.sessionStatus || 'connected'}</strong>
              {market.timeRemainingSeconds !== undefined && (
                <span style={{ marginLeft: '8px', fontSize: '0.85rem' }}>
                  ({Math.floor(market.timeRemainingSeconds / 60)}:{(market.timeRemainingSeconds % 60).toString().padStart(2, '0')})
                </span>
              )}
            </span>
            {market.marketHalt && (
              <span style={{ backgroundColor: 'var(--danger)', color: 'white', padding: '0.25rem 0.75rem', borderRadius: '4px', fontWeight: 'bold', fontSize: '0.9rem' }}>
                MARKET HALTED
              </span>
            )}
            {Object.entries(market.lastPrices).slice(0, 4).map(([symbol, price]) => (
              <span key={symbol}>
                {symbol}: <strong>{new Intl.NumberFormat('id-ID').format(price)}</strong>
                {market.suspendedSymbols.includes(symbol) && (
                  <span style={{ color: 'var(--danger)', marginLeft: '4px', fontSize: '0.8rem', fontWeight: 'bold' }}>(SUSPENDED)</span>
                )}
              </span>
            ))}
          </div>
        )}
        <div className="dashboard-shell">
          <div className="dashboard-main">
            <MarketPanel />
            <Portfolio />
            <OrderList />
            <CompanyPanel />
            <SettlementPanel />
          </div>
          <aside className="dashboard-side">
            <OrderEntry />
            <AccountProfile />
            <Notifications />
            <Leaderboard />
          </aside>
        </div>
      </main>
    </>
  );
}
