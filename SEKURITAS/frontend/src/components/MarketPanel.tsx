import { useEffect, useState, useMemo } from 'react';
import { 
  Activity, 
  Search, 
  Layers3, 
  CalendarClock, 
  TrendingUp, 
  TrendingDown,
  Info
} from 'lucide-react';
import { useStore } from '../store/useStore';
import { useOutletContext } from 'react-router-dom';

interface DashboardContext {
  onOpenTrade: (symbol: string, side: 'BUY' | 'SELL') => void;
}

export default function MarketPanel() {
  // --- Zustand Store Bindings ---
  const storeSecurities = useStore(state => state.securities);
  const market = useStore(state => state.market);
  const storeCorporateActions = useStore(state => state.corporateActions);
  const storeIpoEvents = useStore(state => state.ipoEvents);
  
  const fetchMarketData = useStore(state => state.fetchMarketData);
  const fetchCorporateActions = useStore(state => state.fetchCorporateActions);
  const fetchIpoEvents = useStore(state => state.fetchIpoEvents);

  // --- React Router Outlet Context ---
  const { onOpenTrade } = useOutletContext<DashboardContext>();

  // --- Local States ---
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | 'active' | 'suspended'>('all');
  const [sortBy, setSortBy] = useState<'change-desc' | 'change-asc' | 'symbol'>('symbol');
  const [hasError, setHasError] = useState(false);

  // --- Fetch Initial Market Data on Mount ---
  useEffect(() => {
    const loadData = async () => {
      try {
        await Promise.all([
          fetchMarketData(),
          fetchCorporateActions().catch(() => {}),
          fetchIpoEvents().catch(() => {})
        ]);
        setHasError(false);
      } catch (err) {
        console.warn("Failed to fetch market data, using offline simulator mode.", err);
        setHasError(true);
      }
    };
    loadData();
  }, []);

  const formatNumber = (value: number) => {
    return new Intl.NumberFormat('id-ID').format(value || 0);
  };

  const formatIDR = (value: string | number | undefined) => {
    return new Intl.NumberFormat('id-ID', { 
      style: 'currency', 
      currency: 'IDR', 
      minimumFractionDigits: 0 
    }).format(Number(value || 0));
  };

  // Mengambil data rill dari store backend, atau kosong jika tidak ada / gagal
  const securitiesData = useMemo(() => {
    if (storeSecurities && storeSecurities.length > 0) {
      return storeSecurities;
    }
    return [];
  }, [storeSecurities]);

  const corporateActionsData = useMemo(() => {
    if (storeCorporateActions && storeCorporateActions.length > 0) {
      return storeCorporateActions;
    }
    return [];
  }, [storeCorporateActions]);

  const ipoEventsData = useMemo(() => {
    if (storeIpoEvents && storeIpoEvents.length > 0) {
      return storeIpoEvents;
    }
    return [];
  }, [storeIpoEvents]);
  // --- Process and Filter Securities ---
  const processedSecurities = useMemo(() => {
    return securitiesData.map((sec) => {
      const symbol = sec.symbol || (sec as any).code || '';
      const name = sec.name || symbol;
      
      const rawSec = sec as any;
      const prevClose = parseFloat(rawSec.previous_close || rawSec.reference_price || '0');
      const lastPrice = market.lastPrices[symbol] || prevClose || 0;
      
      const changeVal = lastPrice - prevClose;
      const changePercent = prevClose > 0 ? (changeVal / prevClose) * 100 : 0;
      
      const isSuspended = market.suspendedSymbols.includes(symbol) || sec.tradingStatus === 'suspended' || sec.trading_status === 'suspended';

      return {
        symbol,
        name,
        lastPrice,
        prevClose,
        changeVal,
        changePercent: parseFloat(changePercent.toFixed(2)),
        isGainer: changePercent >= 0,
        isSuspended,
        volume: rawSec.shares_outstanding ? `${(rawSec.shares_outstanding / 1000000).toFixed(1)}M` : 'N/A'
      };
    });
  }, [securitiesData, market.lastPrices, market.suspendedSymbols]);

  // Apply Search, Status Filter, and Sorting
  const filteredSecurities = useMemo(() => {
    let result = [...processedSecurities];

    // Search Query
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase().trim();
      result = result.filter(
        s => s.symbol.toLowerCase().includes(query) || s.name.toLowerCase().includes(query)
      );
    }

    // Status Filter
    if (statusFilter === 'active') {
      result = result.filter(s => !s.isSuspended);
    } else if (statusFilter === 'suspended') {
      result = result.filter(s => s.isSuspended);
    }

    // Sort By
    if (sortBy === 'change-desc') {
      result.sort((a, b) => b.changePercent - a.changePercent);
    } else if (sortBy === 'change-asc') {
      result.sort((a, b) => a.changePercent - b.changePercent);
    } else if (sortBy === 'symbol') {
      result.sort((a, b) => a.symbol.localeCompare(b.symbol));
    }

    return result;
  }, [processedSecurities, searchQuery, statusFilter, sortBy]);

  return (
    <div className="market-premium-page animate-fade-in">
      <style>{`
        .market-premium-page {
          max-width: 80rem;
          margin: 0 auto;
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
          padding-bottom: 3rem;
        }

        .market-layout-grid {
          display: grid;
          grid-template-columns: repeat(12, 1fr);
          gap: 1.5rem;
        }

        @media (max-width: 1024px) {
          .market-layout-grid {
            grid-template-columns: 1fr;
            gap: 1.25rem;
          }
        }

        .left-securities-col {
          grid-column: span 12 / span 12;
          display: flex;
          flex-direction: column;
          gap: 1.25rem;
        }

        @media (max-width: 1024px) {
          .left-securities-col, .right-analysis-col {
            grid-column: span 12 / span 12;
          }
        }

        /* Filter Controls */
        .filter-controls-row {
          display: flex;
          gap: 0.75rem;
          flex-wrap: wrap;
          align-items: center;
          margin-bottom: 0.5rem;
        }

        .search-input-wrapper {
          position: relative;
          flex: 1;
          min-width: 200px;
        }

        .search-icon-inside {
          position: absolute;
          left: 10px;
          top: 50%;
          transform: translateY(-50%);
          color: #8B949E;
        }

        .market-search-input {
          padding-left: 32px !important;
          font-size: 13px !important;
        }

        .select-filter-compact {
          width: auto !important;
          padding: 0.5rem 2rem 0.5rem 0.75rem !important;
          font-size: 12px !important;
          border-radius: 6px !important;
          background-color: #0D1117 !important;
          border-color: #21262D !important;
        }

        /* Row Clickable style */
        .clickable-table-row {
          cursor: pointer;
          transition: background-color 0.2s ease;
        }
        
        .clickable-table-row.selected-row {
          background-color: rgba(230, 34, 37, 0.08) !important;
          border-left: 2px solid #E62225;
        }

        /* Funda Card */
        .fundamental-metric-card {
          background-color: #0D1117;
          border: 1px solid #21262D;
          border-radius: 8px;
          padding: 0.85rem;
          display: flex;
          flex-direction: column;
          gap: 4px;
        }

        /* Special notations style */
        .notation-badge-red {
          background-color: rgba(239, 68, 68, 0.15);
          border: 1px solid rgba(239, 68, 68, 0.3);
          color: #EF4444;
          font-weight: 700;
          font-size: 10px;
          padding: 2px 8px;
          border-radius: 4px;
          display: inline-flex;
          align-items: center;
          gap: 4px;
          cursor: help;
        }

        /* Bottom panels */
        .bottom-events-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 1.5rem;
        }

        @media (max-width: 768px) {
          .bottom-events-grid {
            grid-template-columns: 1fr;
            gap: 1rem;
          }
        }

        /* Tombol Aksi Tabel Beli/Jual */
        .btn-table-buy {
          background-color: #10B981 !important;
          color: #ffffff !important;
          border: none !important;
          font-weight: bold !important;
          font-size: 10px !important;
          padding: 0.35rem 0.65rem !important;
          border-radius: 4px !important;
          cursor: pointer !important;
          min-width: 50px !important;
          display: inline-block !important;
          text-align: center !important;
          transition: background-color 0.2s ease, opacity 0.2s ease;
        }
        .btn-table-buy:hover {
          background-color: #059669 !important;
        }
        .btn-table-buy:disabled {
          opacity: 0.4 !important;
          cursor: not-allowed !important;
        }

        .btn-table-sell {
          background-color: #EF4444 !important;
          color: #ffffff !important;
          border: none !important;
          font-weight: bold !important;
          font-size: 10px !important;
          padding: 0.35rem 0.65rem !important;
          border-radius: 4px !important;
          cursor: pointer !important;
          min-width: 50px !important;
          display: inline-block !important;
          text-align: center !important;
          transition: background-color 0.2s ease, opacity 0.2s ease;
        }
        .btn-table-sell:hover {
          background-color: #DC2626 !important;
        }
        .btn-table-sell:disabled {
          opacity: 0.4 !important;
          cursor: not-allowed !important;
        }
      `}</style>

      {/* Banner Peringatan jika API Offline */}
      {hasError && (
        <div 
          className="max-w-7xl mx-auto p-3.5 rounded-xl flex items-center gap-3 text-amber-500"
          style={{ backgroundColor: 'rgba(245, 158, 11, 0.1)', border: '1px solid rgba(245, 158, 11, 0.3)', fontSize: '12px' }}
        >
          <Info size={16} />
          <span className="font-semibold">Koneksi ke Bursa Efek (BEI) Terputus / Offline. Beberapa data pasar waktu-nyata tidak dapat ditampilkan saat ini.</span>
        </div>
      )}

      {/* --- HEADER --- */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h2 className="text-xl font-bold tracking-tight text-white mb-0" style={{ margin: 0 }}>Pasar Saham Indonesia</h2>
          <p className="text-xs text-[#8B949E]" style={{ margin: '4px 0 0 0' }}>Pantau pergerakan harga saham real-time, laporan fundamental emiten, aksi korporasi, serta penawaran IPO.</p>
        </div>
        
        {/* Status Pasar */}
        {(() => {
          const isOpen = market.sessionStatus && market.sessionStatus !== 'closed';
          return (
            <div 
              className="flex items-center gap-2 py-1.5 px-3 rounded-full text-xs"
              style={{ 
                backgroundColor: isOpen ? 'rgba(16, 185, 129, 0.1)' : 'rgba(239, 68, 68, 0.1)', 
                border: isOpen ? '1px solid rgba(16, 185, 129, 0.3)' : '1px solid rgba(239, 68, 68, 0.3)' 
              }}
            >
              <span className="relative flex h-2 w-2">
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full opacity-75 ${isOpen ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></span>
                <span className={`relative inline-flex rounded-full h-2 w-2 ${isOpen ? 'bg-[#10B981]' : 'bg-[#EF4444]'}`}></span>
              </span>
              <span className="font-bold text-slate-300 uppercase" style={{ fontSize: '11px' }}>
                PASAR {market.sessionStatus?.toUpperCase() || 'CLOSED'}
              </span>
            </div>
          );
        })()}
      </div>

      {/* --- TATA LETAK UTAMA --- */}
      <div className="market-layout-grid">
        
        {/* KOLOM KIRI: DAFTAR EMITEN & PENCARIAN (7/12) */}
        <div className="left-securities-col">
          <div className="card-isometric-premium" style={{ padding: '1.25rem' }}>
            <h3 className="text-sm font-bold uppercase tracking-wider text-white mb-4 flex items-center gap-2" style={{ margin: 0 }}>
              <Activity className="text-primary" size={16} />
              Daftar Saham Terdaftar ({filteredSecurities.length})
            </h3>

            {/* Filter controls */}
            <div className="filter-controls-row">
              <div className="search-input-wrapper">
                <Search size={14} className="search-icon-inside" />
                <input 
                  type="text" 
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Cari kode saham atau nama emiten..."
                  className="market-search-input"
                />
              </div>

              <select 
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
                className="select-filter-compact"
              >
                <option value="all">Semua Status</option>
                <option value="active">Trading Aktif</option>
                <option value="suspended">Suspended</option>
              </select>

              <select 
                value={sortBy}
                onChange={(e) => setSortBy(e.target.value as any)}
                className="select-filter-compact"
              >
                <option value="symbol">Abjad Kode</option>
                <option value="change-desc">Kenaikan Tertinggi (Gainer)</option>
                <option value="change-asc">Penurunan Terbesar (Loser)</option>
              </select>
            </div>

            {/* Tabel Securities */}
            <div className="table-wrapper">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-[#8B949E] uppercase tracking-wider text-[10px]" style={{ borderBottom: '1px solid #21262D' }}>
                    <th className="pb-2.5 font-semibold">Kode</th>
                    <th className="pb-2.5 font-semibold text-right">Harga Terakhir</th>
                    <th className="pb-2.5 font-semibold text-right">Perubahan (%)</th>
                    <th className="pb-2.5 font-semibold text-right">Harga Acuan</th>
                    <th className="pb-2.5 font-semibold text-center">Status</th>
                    <th className="pb-2.5 font-semibold text-center" style={{ width: '130px' }}>Aksi</th>
                  </tr>
                </thead>
                <tbody className="divide-y font-mono" style={{ borderColor: 'rgba(33, 38, 45, 0.4)' }}>
                  {filteredSecurities.length > 0 ? (
                    filteredSecurities.map((stock) => {
                      return (
                        <tr 
                          key={stock.symbol}
                          className="clickable-table-row"
                          style={{ borderBottom: '1px solid rgba(255, 255, 255, 0.02)' }}
                        >
                          <td className="py-2.5" style={{ padding: '0.6rem 0.5rem' }}>
                            <span className="font-bold text-white text-sm block">{stock.symbol}</span>
                            <span className="text-[10px] text-[#8B949E] font-normal truncate block max-w-[200px]">
                              {stock.name}
                            </span>
                          </td>
                          <td className="py-2.5 text-right font-bold text-slate-100" style={{ padding: '0.6rem 0.5rem' }}>
                            Rp {formatNumber(stock.lastPrice)}
                          </td>
                          <td 
                            className="py-2.5 text-right font-bold" 
                            style={{ 
                              color: stock.isSuspended ? '#8B949E' : (stock.changePercent >= 0 ? '#10B981' : '#EF4444'),
                              padding: '0.6rem 0.5rem' 
                            }}
                          >
                            {stock.isSuspended ? (
                              <span>0.00%</span>
                            ) : (
                              <span className="flex items-center justify-end gap-0.5">
                                {stock.changePercent >= 0 ? <TrendingUp size={10} /> : <TrendingDown size={10} />}
                                {stock.changePercent >= 0 ? '+' : ''}{stock.changePercent}%
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 text-right text-[#8B949E]" style={{ padding: '0.6rem 0.5rem' }}>
                            Rp {formatNumber(stock.prevClose)}
                          </td>
                          <td className="py-2.5 text-center" style={{ padding: '0.6rem 0.5rem' }}>
                            {stock.isSuspended ? (
                              <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-red-950/20 text-[#EF4444] border border-red-500/20">
                                SUSPENDED
                              </span>
                            ) : (
                              <span className="px-2 py-0.5 rounded text-[9px] font-bold bg-green-950/20 text-[#10B981] border border-green-500/20">
                                ACTIVE
                              </span>
                            )}
                          </td>
                          <td className="py-2.5 text-center" style={{ padding: '0.6rem 0.5rem' }}>
                            <div style={{ display: 'flex', gap: '0.35rem', justifyContent: 'center' }}>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenTrade(stock.symbol, 'BUY');
                                }}
                                disabled={stock.isSuspended}
                                className="btn-table-buy"
                              >
                                BELI
                              </button>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOpenTrade(stock.symbol, 'SELL');
                                }}
                                disabled={stock.isSuspended}
                                className="btn-table-sell"
                              >
                                JUAL
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })
                  ) : (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-[#8B949E]">
                        Tidak ada saham terdaftar yang sesuai dengan filter pencarian.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>

      </div>

      {/* BARIS BAWAH: AKSI KORPORASI & e-IPO (12/12) */}
      <div className="bottom-events-grid">
        
        {/* Aksi Korporasi */}
        <div className="card-isometric-premium" style={{ padding: '1.25rem' }}>
          <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3.5 flex items-center gap-2" style={{ margin: 0 }}>
            <CalendarClock className="text-[#E62225]" size={15} />
            Kalender Aksi Korporasi Bursa
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {corporateActionsData.slice(0, 4).map((item: any) => {
              const type = item.action_type || item.type || 'Dividend';
              const isDiv = type.toLowerCase().includes('dividend') || type.toLowerCase().includes('dividen');
              return (
                <div 
                  key={item.id || `${item.symbol}-${item.action_type}`}
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '0.65rem 0.75rem', 
                    backgroundColor: '#0D1117', 
                    border: '1px solid #21262D', 
                    borderRadius: '8px',
                    fontSize: '12px' 
                  }}
                  className="font-mono"
                >
                  <div>
                    <span className="font-bold text-white block">{item.symbol}</span>
                    <span className="text-[10px] text-[#8B949E] block">
                      {item.description || `Pembagian dividen kas Rp ${item.amount || 'N/A'} per lembar`}
                    </span>
                  </div>
                  <div className="text-right">
                    <span 
                      className="px-2 py-0.5 rounded text-[10px] font-bold block mb-1 text-center"
                      style={{
                        backgroundColor: isDiv ? 'rgba(16, 185, 129, 0.15)' : 'rgba(245, 158, 11, 0.15)',
                        color: isDiv ? '#10B981' : '#F59E0B'
                      }}
                    >
                      {type.toUpperCase()}
                    </span>
                    <span className="text-[9px] text-[#8B949E] block">
                      Cum Date: {item.cum_date ? new Date(item.cum_date).toLocaleDateString('id-ID') : 'Segera'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* e-IPO Penawaran Perdana */}
        <div className="card-isometric-premium" style={{ padding: '1.25rem' }}>
          <h3 className="text-xs font-bold uppercase tracking-wider text-white mb-3.5 flex items-center gap-2" style={{ margin: 0 }}>
            <Layers3 className="text-primary" size={15} />
            Hub Penawaran Perdana e-IPO
          </h3>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem' }}>
            {ipoEventsData.slice(0, 4).map((item: any) => {
              const minPrice = item.price_range_min || 100;
              const maxPrice = item.price_range_max || 150;
              return (
                <div 
                  key={item.id}
                  style={{ 
                    display: 'flex', 
                    justifyContent: 'space-between', 
                    alignItems: 'center', 
                    padding: '0.65rem 0.75rem', 
                    backgroundColor: '#0D1117', 
                    border: '1px solid #21262D', 
                    borderRadius: '8px',
                    fontSize: '12px' 
                  }}
                  className="font-mono"
                >
                  <div>
                    <span className="font-bold text-white block">{item.company_name || item.symbol}</span>
                    <span className="text-[10px] text-[#8B949E] block">
                      Range Penawaran: Rp {minPrice} - Rp {maxPrice}
                    </span>
                  </div>
                  <div className="text-right">
                    <button 
                      onClick={() => onOpenTrade(item.symbol || 'IPO-MEI', 'BUY')}
                      className="btn-primary-red text-[9px] font-bold px-2.5 py-1 rounded bg-[#E62225] text-white transition mb-1 inline-block"
                      style={{ border: 'none', cursor: 'pointer' }}
                    >
                      Pesan Saham
                    </button>
                    <span className="text-[9px] text-[#8B949E] block">
                      Listing: {item.listing_date ? new Date(item.listing_date).toLocaleDateString('id-ID') : 'Segera'}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

      </div>

    </div>
  );
}
