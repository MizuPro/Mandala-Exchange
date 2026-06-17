import { useEffect } from 'react';
import { Activity, CalendarClock, Layers3 } from 'lucide-react';
import { useStore } from '../store/useStore';

const formatNumber = (value: number) => new Intl.NumberFormat('id-ID').format(value || 0);

export default function MarketPanel() {
  const securities = useStore(state => state.securities);
  const market = useStore(state => state.market);
  const corporateActions = useStore(state => state.corporateActions);
  const ipoEvents = useStore(state => state.ipoEvents);
  const fetchMarketData = useStore(state => state.fetchMarketData);
  const fetchCorporateActions = useStore(state => state.fetchCorporateActions);
  const fetchIpoEvents = useStore(state => state.fetchIpoEvents);

  useEffect(() => {
    fetchMarketData();
    fetchCorporateActions();
    fetchIpoEvents();
  }, [fetchMarketData, fetchCorporateActions, fetchIpoEvents]);

  const watched = securities.slice(0, 8);

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <Activity className="text-primary" size={20} />
        <h3>Market</h3>
        <span className="status-pill">{market.sessionStatus || (market.connected ? 'connected' : 'offline')}</span>
      </div>

      <div className="watch-grid">
        {watched.map(security => {
          const symbol = security.symbol || security.code || '';
          return (
            <div key={symbol} className="watch-tile">
              <strong>{symbol}</strong>
              <span>{security.name || 'Listed security'}</span>
              <em>{market.lastPrices[symbol] ? formatNumber(market.lastPrices[symbol]) : '-'}</em>
            </div>
          );
        })}
      </div>

      <div className="split-list">
        <div>
          <div className="mini-title">
            <CalendarClock size={16} />
            <strong>Corporate Actions</strong>
          </div>
          <div className="stack-list compact-list">
            {corporateActions.slice(0, 4).map((item: any) => (
              <div className="list-row" key={item.id || `${item.symbol}-${item.title}`}>
                <div>
                  <strong>{item.symbol || item.type}</strong>
                  <p>{item.title || item.description || item.status}</p>
                </div>
                <span className="text-muted">{item.status || '-'}</span>
              </div>
            ))}
            {corporateActions.length === 0 && <p>No corporate action data.</p>}
          </div>
        </div>
        <div>
          <div className="mini-title">
            <Layers3 size={16} />
            <strong>IPO</strong>
          </div>
          <div className="stack-list compact-list">
            {ipoEvents.slice(0, 4).map((item: any) => (
              <div className="list-row" key={item.id}>
                <div>
                  <strong>{item.status || 'IPO'}</strong>
                  <p>{item.offeredShares || item.offered_shares || '-'} shares</p>
                </div>
                <span className="text-muted">{item.listingDate || item.listing_date || '-'}</span>
              </div>
            ))}
            {ipoEvents.length === 0 && <p>No IPO data.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
