import { useState } from 'react';
import { useStore } from '../store/useStore';
import { Send, TrendingUp, TrendingDown } from 'lucide-react';

export default function OrderEntry() {
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<"BUY"|"SELL">("BUY");
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  
  const placeOrder = useStore(state => state.placeOrder);
  const isLoading = useStore(state => state.isLoading);
  const error = useStore(state => state.error);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!symbol || !price || !quantity) return;
    try {
      await placeOrder(symbol.toUpperCase(), side, Number(price), Number(quantity));
      setSymbol('');
      setPrice('');
      setQuantity('');
      alert(`Order ${side} ${symbol} placed successfully!`);
    } catch (err: any) {
      alert(`Failed to place order: ${err.message}`);
    }
  };

  const estValue = Number(price) * Number(quantity);
  const estFee = side === 'BUY' ? estValue * 0.0015 : estValue * 0.0025; // 0.15% buy, 0.25% sell (inc tax)
  const totalReq = side === 'BUY' ? estValue + estFee : estValue - estFee;

  const formatIDR = (val: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '1.5rem', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {side === 'BUY' ? <TrendingUp className="text-success" /> : <TrendingDown className="text-danger" />}
        <h3>Order Entry</h3>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <button 
            type="button" 
            className={`btn-success`} 
            style={{ flex: 1, opacity: side === 'BUY' ? 1 : 0.3 }}
            onClick={() => setSide('BUY')}
          >
            BUY
          </button>
          <button 
            type="button" 
            className={`btn-danger`} 
            style={{ flex: 1, opacity: side === 'SELL' ? 1 : 0.3 }}
            onClick={() => setSide('SELL')}
          >
            SELL
          </button>
        </div>

        <div className="form-group">
          <label>Symbol</label>
          <input 
            type="text" 
            value={symbol} 
            onChange={e => setSymbol(e.target.value.toUpperCase())} 
            placeholder="e.g. BBCA" 
            maxLength={4}
            required 
          />
        </div>

        <div className="grid-2" style={{ gap: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <label>Price (IDR)</label>
            <input 
              type="number" 
              value={price} 
              onChange={e => setPrice(e.target.value)} 
              placeholder="0" 
              min={1}
              required 
            />
          </div>
          <div>
            <label>Quantity (Lots)</label>
            <input 
              type="number" 
              value={quantity} 
              onChange={e => setQuantity(e.target.value)} 
              placeholder="1" 
              min={1}
              required 
            />
          </div>
        </div>

        {(Number(price) > 0 && Number(quantity) > 0) && (
          <div className="glass-panel" style={{ padding: '1rem', marginBottom: '1.5rem', background: 'rgba(255,255,255,0.02)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="text-muted">Est. Value</span>
              <span>{formatIDR(estValue)}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.5rem' }}>
              <span className="text-muted">Est. Fee</span>
              <span>{formatIDR(estFee)}</span>
            </div>
            <hr style={{ borderColor: 'var(--border)', margin: '0.5rem 0' }}/>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
              <span>{side === 'BUY' ? 'Total Required' : 'Est. Proceeds'}</span>
              <span className={side === 'BUY' ? 'text-warning' : 'text-success'}>{formatIDR(totalReq)}</span>
            </div>
          </div>
        )}

        <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={isLoading}>
          <Send size={16} /> Submit {side} Order
        </button>
      </form>
    </div>
  );
}
