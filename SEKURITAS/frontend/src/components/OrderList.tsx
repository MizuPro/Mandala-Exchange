import { useStore } from '../store/useStore';
import { ListFilter, XCircle } from 'lucide-react';

export default function OrderList() {
  const orders = useStore(state => state.orders);
  const cancelOrder = useStore(state => state.cancelOrder);

  const handleCancel = async (id: string) => {
    if (confirm("Are you sure you want to cancel this order?")) {
      try {
        await cancelOrder(id);
        alert("Cancel request sent!");
      } catch(e: any) {
        alert(e.message);
      }
    }
  };

  const formatIDR = (val: string | number) => {
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(Number(val));
  };

  const normalizeStatus = (status: string) => status.toLowerCase();
  const formatStatus = (status: string) => normalizeStatus(status).replace(/_/g, ' ').toUpperCase();

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '1.5rem' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
        <ListFilter className="text-primary" />
        <h2>Recent Orders</h2>
      </div>

      {orders.length === 0 ? (
        <p>No orders found.</p>
      ) : (
        <div className="table-wrapper">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Symbol</th>
                <th>Side</th>
                <th>Price</th>
                <th>Qty</th>
                <th>Filled</th>
                <th>Status</th>
                <th>Action</th>
              </tr>
            </thead>
            <tbody>
              {orders.map(o => {
                const status = normalizeStatus(o.status);
                const canCancel = ["pending", "accepted", "open", "amended", "partially_filled"].includes(status);
                const sideColor = o.side === "BUY" ? "text-success" : "text-danger";
                
                return (
                  <tr key={o.id}>
                    <td className="text-muted">{new Date(o.created_at).toLocaleTimeString()}</td>
                    <td style={{ fontWeight: 600 }}>{o.symbol}</td>
                    <td className={sideColor}>{o.side}</td>
                    <td>{formatIDR(o.price)}</td>
                    <td>{o.quantity}</td>
                    <td>{o.filled_quantity}</td>
                    <td>
                      <span style={{ 
                        padding: '0.25rem 0.5rem', 
                        borderRadius: '4px', 
                        fontSize: '0.75rem',
                        background: 'rgba(255,255,255,0.1)' 
                      }}>
                        {formatStatus(o.status)}
                      </span>
                      {o.reject_reason && <div className="text-danger" style={{ fontSize: '0.75rem', marginTop: '0.25rem' }}>{o.reject_reason}</div>}
                    </td>
                    <td>
                      {canCancel && (
                        <button 
                          onClick={() => handleCancel(o.id)}
                          style={{ padding: '0.25rem', background: 'transparent', color: 'var(--danger)' }}
                          title="Cancel Order"
                        >
                          <XCircle size={18} />
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
