import { useStore } from '../store/useStore';
import { ListFilter, Pencil, XCircle } from 'lucide-react';

const LOT_SIZE = 100;

export default function OrderList() {
  const orders = useStore(state => state.orders);
  const cancelOrder = useStore(state => state.cancelOrder);
  const amendOrder = useStore(state => state.amendOrder);

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

  const handleAmend = async (order: any) => {
    const priceInput = prompt('New price', String(order.price));
    if (priceInput === null) return;
    const quantityInput = prompt('New total quantity', String(order.original_quantity));
    if (quantityInput === null) return;
    const price = Number(priceInput);
    const quantity = Number(quantityInput);
    if (!Number.isInteger(price) || !Number.isInteger(quantity) || price <= 0 || quantity <= 0 || quantity % LOT_SIZE !== 0) {
      alert(`Price must be a positive integer and quantity must be a multiple of ${LOT_SIZE} shares.`);
      return;
    }
    if (quantity < (order.filled_quantity || 0)) {
      alert(`Amended quantity cannot be below the already filled quantity (${order.filled_quantity} shares).`);
      return;
    }
    try {
      await amendOrder(order.id, { price, quantity });
      alert('Amend request sent!');
    } catch (e: any) {
      alert(e.message);
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
                <th>Type</th>
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
                const canCancel = ["accepted", "open", "amended", "partially_filled"].includes(status);
                const canAmend = (o.order_type || "limit") !== "market" && ["accepted", "open", "amended", "partially_filled"].includes(status);
                const sideColor = o.side === "buy" ? "text-success" : "text-danger";
                const orderType = o.order_type || "limit";
                
                return (
                  <tr key={o.id}>
                    <td className="text-muted">{new Date(o.created_at).toLocaleTimeString()}</td>
                    <td style={{ fontWeight: 600 }}>{o.symbol}</td>
                    <td className={sideColor}>{o.side.toUpperCase()}</td>
                    <td>{orderType.toUpperCase()}</td>
                    <td>{orderType === "market" ? "Market" : formatIDR(o.price)}</td>
                    <td>{o.original_quantity}</td>
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
                      {canAmend && (
                        <button
                          onClick={() => handleAmend(o)}
                          style={{ padding: '0.25rem', background: 'transparent', color: 'var(--primary)', marginRight: '0.25rem' }}
                          title="Amend Order"
                        >
                          <Pencil size={18} />
                        </button>
                      )}
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
