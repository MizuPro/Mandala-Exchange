import { useEffect, useState } from 'react';
import { useStore } from '../store/useStore';
import { Send, TrendingUp, TrendingDown } from 'lucide-react';

export default function OrderEntry() {
  const [symbol, setSymbol] = useState('');
  const [side, setSide] = useState<"buy"|"sell">("buy");
  const [orderType, setOrderType] = useState<"limit"|"market">("limit");
  const [price, setPrice] = useState('');
  const [quantity, setQuantity] = useState('');
  
  const placeOrder = useStore(state => state.placeOrder);
  const isLoading = useStore(state => state.orderActionLoading);
  const error = useStore(state => state.error);
  const securities = useStore(state => state.securities);
  const feeSchedule = useStore(state => state.feeSchedule);
  const market = useStore(state => state.market);
  const fetchMarketData = useStore(state => state.fetchMarketData);

  useEffect(() => {
    fetchMarketData();
  }, [fetchMarketData]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const priceValue = Number(price);
    const quantityValue = Number(quantity);
    const priceIsValid = orderType === 'market' || (Number.isInteger(priceValue) && priceValue > 0);
    if (!symbol || !priceIsValid || !Number.isInteger(quantityValue) || quantityValue <= 0) {
      alert(orderType === 'market' ? 'Symbol and quantity must be valid positive values.' : 'Symbol, price, and quantity must be valid positive values.');
      return;
    }
    try {
      await placeOrder(symbol.toUpperCase(), side, orderType === 'market' ? undefined : priceValue, quantityValue, orderType);
      setSymbol('');
      setPrice('');
      setQuantity('');
      alert(`${orderType.toUpperCase()} ${side.toUpperCase()} ${symbol} order placed successfully!`);
    } catch (err: any) {
      alert(`Failed to place order: ${err.message}`);
    }
  };

  const lastPrice = market.lastPrices[symbol.toUpperCase()] || 0;
  const priceValue = orderType === 'market' ? lastPrice : Number(price);
  const quantityValue = Number(quantity);
  const estValue = Number.isFinite(priceValue * quantityValue) ? priceValue * quantityValue : 0;
  const brokerRate = Number(side === 'buy' ? feeSchedule?.brokerBuyRate : feeSchedule?.brokerSellRate) || 0.0015;
  const marketRate = (Number(feeSchedule?.exchangeFeeRate) || 0) +
    (Number(feeSchedule?.clearingFeeRate) || 0) +
    (Number(feeSchedule?.settlementFeeRate) || 0) +
    (Number(feeSchedule?.guaranteeFundRate) || 0);
  const vatRate = Number(feeSchedule?.vatRate) || 0;
  const sellTaxRate = side === 'sell' ? Number(feeSchedule?.sellTaxRate) || 0 : 0;
  const minimumFee = Number(feeSchedule?.minimumFee) || 0;
  const estFee = Math.max(minimumFee, estValue * (brokerRate + marketRate + sellTaxRate) + (estValue * brokerRate * vatRate));
  const totalReq = side === 'buy' ? estValue + estFee : estValue - estFee;

  const formatIDR = (val: number) => new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', minimumFractionDigits: 0 }).format(val);

  return (
    <div className="glass-panel animate-fade-in" style={{ padding: '1.5rem', height: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1.5rem' }}>
        {side === 'buy' ? <TrendingUp className="text-success" /> : <TrendingDown className="text-danger" />}
        <h3>Order Entry</h3>
      </div>

      <form onSubmit={handleSubmit}>
        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1.5rem' }}>
          <button 
            type="button" 
            className={`btn-success`} 
            style={{ flex: 1, opacity: side === 'buy' ? 1 : 0.3 }}
            onClick={() => setSide('buy')}
          >
            BUY
          </button>
          <button 
            type="button" 
            className={`btn-danger`} 
            style={{ flex: 1, opacity: side === 'sell' ? 1 : 0.3 }}
            onClick={() => setSide('sell')}
          >
            SELL
          </button>
        </div>

        <div className="segmented-control" style={{ marginBottom: '1.25rem' }}>
          <button type="button" className={orderType === 'limit' ? 'active' : ''} onClick={() => setOrderType('limit')}>
            LIMIT
          </button>
          <button type="button" className={orderType === 'market' ? 'active' : ''} onClick={() => setOrderType('market')}>
            MARKET
          </button>
        </div>

        <div className="form-group">
          <label>Symbol</label>
          <input 
            type="text" 
            value={symbol} 
            onChange={e => setSymbol(e.target.value.toUpperCase())} 
            placeholder="e.g. BBCA" 
            maxLength={12}
            list="listed-securities"
            required 
          />
          <datalist id="listed-securities">
            {securities.map((security) => {
              const code = security.symbol || security.code;
              return code ? <option key={code} value={code}>{security.name || code}</option> : null;
            })}
          </datalist>
        </div>

        <div className="grid-2" style={{ gap: '1rem', marginBottom: '1.5rem' }}>
          <div>
            <label>Price (IDR)</label>
            <input 
              type="number" 
              value={price} 
              onChange={e => setPrice(e.target.value)} 
              placeholder={orderType === 'market' ? (lastPrice ? `Last ${lastPrice}` : 'market') : '0'} 
              min={1}
              required={orderType === 'limit'}
              disabled={orderType === 'market'}
            />
          </div>
          <div>
            <label>Quantity (Shares)</label>
            <input 
              type="number" 
              value={quantity} 
              onChange={e => setQuantity(e.target.value)} 
              placeholder="1" 
              min={1}
              step={1}
              required 
            />
          </div>
        </div>

        {orderType === 'market' && (
          <div className="risk-note" style={{ marginBottom: '1rem' }}>
            Market orders execute immediately against available opposite book. Unfilled remainder is cancelled.
          </div>
        )}

        {((orderType === 'market' || Number(price) > 0) && Number(quantity) > 0) && (
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
              <span>{side === 'buy' ? 'Total Required' : 'Est. Proceeds'}</span>
              <span className={side === 'buy' ? 'text-warning' : 'text-success'}>{formatIDR(totalReq)}</span>
            </div>
          </div>
        )}

        <button type="submit" className="btn-primary" style={{ width: '100%' }} disabled={isLoading}>
          <Send size={16} /> Submit {orderType.toUpperCase()} {side.toUpperCase()}
        </button>
        {error && <p className="text-danger" style={{ marginTop: '1rem', fontSize: '0.875rem' }}>{error}</p>}
      </form>
    </div>
  );
}
