import { useStore } from '../store/useStore';
import { Briefcase, Wallet } from 'lucide-react';

export default function Portfolio() {
  const portfolio = useStore(state => state.portfolio);
  const isLoading = useStore(state => state.isLoading);

  if (isLoading && !portfolio) return <div className="glass-panel" style={{ padding: '2rem', textAlign: 'center' }}>Loading portfolio...</div>;
  if (!portfolio) return <div className="glass-panel" style={{ padding: '2rem' }}>No portfolio data available.</div>;

  const formatIDR = (val: string | number) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(val));
  };

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '1.5rem', marginBottom: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <Wallet className="text-primary" />
        <h2>Buying Power & Balances</h2>
      </div>
      
      <div className="grid-2" style={{ marginBottom: '2rem' }}>
        <div className="glass-panel" style={{ padding: '1.5rem', background: 'rgba(59, 130, 246, 0.1)', borderColor: 'var(--border-focus)' }}>
          <p style={{ margin: 0 }}>Available Cash</p>
          <h2 className="text-primary" style={{ margin: 0, fontSize: '2rem' }}>{formatIDR(portfolio.cash.available)}</h2>
        </div>
        <div className="glass-panel" style={{ padding: '1.5rem' }}>
          <p style={{ margin: 0 }}>Reserved Cash (Open Orders)</p>
          <h2 className="text-warning" style={{ margin: 0, fontSize: '1.5rem' }}>{formatIDR(portfolio.cash.reserved)}</h2>
          <p style={{ margin: '0.5rem 0 0 0', fontSize: '0.875rem' }}>Pending Settlement: {formatIDR(portfolio.cash.pending)}</p>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <Briefcase className="text-accent" />
        <h3>Securities Position</h3>
      </div>
      
      {portfolio.positions.length === 0 ? (
        <p>No securities positions held.</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Symbol</th>
                <th>Available</th>
                <th>Reserved</th>
                <th>Avg Price</th>
                <th>Realized P/L</th>
              </tr>
            </thead>
            <tbody>
              {portfolio.positions.map(pos => (
                <tr key={pos.symbol}>
                  <td style={{ fontWeight: 600 }}>{pos.symbol}</td>
                  <td>{pos.available}</td>
                  <td>{pos.reserved}</td>
                  <td>{formatIDR(pos.average_price)}</td>
                  <td className={Number(pos.realized_pl) > 0 ? 'text-success' : Number(pos.realized_pl) < 0 ? 'text-danger' : ''}>
                    {formatIDR(pos.realized_pl)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
