import { FormEvent, useEffect, useState } from 'react';
import { RefreshCcw, Scale } from 'lucide-react';
import { useStore } from '../store/useStore';

const formatIDR = (value: string | number) =>
  new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(value || 0));

export default function SettlementPanel() {
  const [sessionId, setSessionId] = useState('SESSION-1');
  const settlementStatus = useStore(state => state.settlementStatus);
  const custodySummary = useStore(state => state.custodySummary);
  const reconciliation = useStore(state => state.reconciliation);
  const tradeHistory = useStore(state => state.tradeHistory);
  const fetchSettlementStatus = useStore(state => state.fetchSettlementStatus);
  const fetchCustodySummary = useStore(state => state.fetchCustodySummary);
  const fetchReconciliation = useStore(state => state.fetchReconciliation);
  const fetchTradeHistory = useStore(state => state.fetchTradeHistory);

  useEffect(() => {
    fetchCustodySummary().catch(() => {});
    fetchReconciliation().catch(() => {});
    fetchTradeHistory().catch(() => {});
  }, []);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    fetchSettlementStatus(sessionId);
  };

  return (
    <section className="glass-panel dashboard-panel">
      <div className="panel-title">
        <Scale className="text-success" size={20} />
        <h3>Settlement & Reconciliation</h3>
      </div>
      <form onSubmit={submit} className="inline-form">
        <input value={sessionId} onChange={event => setSessionId(event.target.value)} />
        <button type="submit" className="btn-primary" title="Load settlement">
          <RefreshCcw size={16} />
        </button>
      </form>

      <div className="metric-grid">
        <div className="metric-block">
          <span>Custody Account</span>
          <strong>{custodySummary?.account?.status || '-'}</strong>
        </div>
        <div className="metric-block">
          <span>Reconciliation</span>
          <strong>{reconciliation?.account?.status || reconciliation?.status || '-'}</strong>
        </div>
        <div className="metric-block">
          <span>Fills</span>
          <strong>{tradeHistory.length}</strong>
        </div>
      </div>

      <div className="split-list">
        <div>
          <div className="mini-title"><strong>Settlement Batches</strong></div>
          <div className="stack-list compact-list">
            {settlementStatus.slice(0, 4).map((batch: any) => (
              <div className="list-row" key={batch.id}>
                <div>
                  <strong>{batch.status}</strong>
                  <p>{batch.session_id || batch.sessionId}</p>
                </div>
                <span className="text-muted">{batch.processed_at || batch.processedAt || '-'}</span>
              </div>
            ))}
            {settlementStatus.length === 0 && <p>No settlement batch loaded.</p>}
          </div>
        </div>
        <div>
          <div className="mini-title"><strong>Recent Fills</strong></div>
          <div className="stack-list compact-list">
            {tradeHistory.slice(0, 4).map((fill: any) => (
              <div className="list-row" key={fill.id}>
                <div>
                  <strong>{fill.symbol} {fill.side}</strong>
                  <p>{fill.quantity} shares at {formatIDR(fill.price)}</p>
                </div>
                <span className="text-muted">{new Date(fill.timestamp).toLocaleTimeString()}</span>
              </div>
            ))}
            {tradeHistory.length === 0 && <p>No fills yet.</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
