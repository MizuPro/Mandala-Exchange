import { FormEvent, useState } from 'react';
import { Building2, Search } from 'lucide-react';
import { useStore } from '../store/useStore';

const formatIDR = (value: string | number | undefined) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(value || 0));

export default function CompanyPanel() {
  const [symbol, setSymbol] = useState('BBCA');
  const company = useStore(state => state.company);
  const fetchCompany = useStore(state => state.fetchCompany);
  const isLoading = useStore(state => state.dashboardLoading);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    fetchCompany(symbol);
  };

  const detail = company.detail;
  const latestReport = company.fundamentals?.reports?.[0];
  const ratios = latestReport?.ratios || {};
  const notations = detail?.active_notations || [];

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <Building2 className="text-accent" size={20} />
        <h3>Company Analysis</h3>
      </div>
      <form onSubmit={submit} className="inline-form">
        <input value={symbol} onChange={event => setSymbol(event.target.value.toUpperCase())} maxLength={12} />
        <button type="submit" className="btn-primary" disabled={isLoading} title="Load company">
          <Search size={16} />
        </button>
      </form>

      {!detail ? (
        <p>Select a symbol to inspect company data.</p>
      ) : (
        <>
          <div className="company-header">
            <div>
              <strong>{detail.symbol}</strong>
              <p>{detail.name || detail.issuer_name}</p>
            </div>
            <span className="status-pill">{detail.status}</span>
          </div>
          <div className="metric-grid">
            <div className="metric-block">
              <span>Reference</span>
              <strong>{formatIDR(detail.reference_price)}</strong>
            </div>
            <div className="metric-block">
              <span>PER</span>
              <strong>{ratios.per ? Number(ratios.per).toFixed(2) : '-'}</strong>
            </div>
            <div className="metric-block">
              <span>PBV</span>
              <strong>{ratios.pbv ? Number(ratios.pbv).toFixed(2) : '-'}</strong>
            </div>
            <div className="metric-block">
              <span>ROE</span>
              <strong>{ratios.roe ? `${(Number(ratios.roe) * 100).toFixed(2)}%` : '-'}</strong>
            </div>
          </div>
          {notations.length > 0 && (
            <div className="tag-row">
              {notations.map((notation: any) => <span key={notation.id || notation.type}>{notation.type}</span>)}
            </div>
          )}
          <div className="stack-list compact-list">
            {company.announcements.slice(0, 3).map((item: any) => (
              <div className="list-row" key={item.id}>
                <div>
                  <strong>{item.title}</strong>
                  <p>{item.type}</p>
                </div>
                <span className="text-muted">{item.publishedAt || item.published_at || '-'}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}
