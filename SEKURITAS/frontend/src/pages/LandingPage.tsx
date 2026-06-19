import { Link, useNavigate } from 'react-router-dom';
import { useStore } from '../store/useStore';
import { 
  ArrowRight, 
  Activity, 
  TrendingUp, 
  Globe, 
  Mail, 
  MessageSquare, 
  Info,
  ShieldCheck,
  Building,
  Lock,
  LineChart
} from 'lucide-react';
import './LandingPage.css';

export default function LandingPage() {
  const token = useStore(state => state.token);
  const navigate = useNavigate();

  const handleCTA = () => {
    if (token) {
      navigate('/dashboard');
    } else {
      navigate('/login');
    }
  };

  return (
    <div className="landing-page-root">
      {/* Background Ambient Glows */}
      <div className="landing-glow-top-left" />
      <div className="landing-glow-bottom-right" />

      {/* Navigation Bar */}
      <nav className="landing-nav">
        <div className="landing-nav-container">
          <div className="landing-logo">
            <img 
              alt="Mandala Sekuritas Logo" 
              className="landing-logo-img" 
              src="/logo_teksbawah.png" 
              onError={(e) => {
                // Fallback to text if image is not found or loaded yet
                e.currentTarget.style.display = 'none';
              }}
            />
            <span className="landing-logo-text">Mandala Sekuritas</span>
          </div>

          <div className="landing-nav-links">
            <a href="#" className="landing-nav-link active">Home</a>
            <a href="#simulasi" className="landing-nav-link">Simulasi</a>
            <a href="#fitur" className="landing-nav-link">Fitur Utama</a>
            <a href="#edukasi" className="landing-nav-link">Edukasi</a>
          </div>

          <div className="landing-nav-actions">
            <button 
              className="landing-btn landing-btn-outline" 
              onClick={() => alert('Fitur download aplikasi mobile segera hadir!')}
            >
              Download App
            </button>
            <button className="landing-btn landing-btn-primary" onClick={handleCTA}>
              {token ? 'Ke Dashboard' : 'Mulai Investasi'}
            </button>
          </div>
        </div>
      </nav>

      {/* Hero Section */}
      <main className="landing-hero" id="home">
        <div className="landing-hero-container">
          {/* Hero Left: Narrative Info */}
          <div className="landing-hero-left">
            <div className="landing-badge">
              <span className="landing-badge-dot"></span>
              <span className="landing-badge-text">Mandala Simulator Aktif 🟢</span>
            </div>

            <h1>
              Era baru belajar <span className="highlight-red">investasi</span> & trading saham.
            </h1>

            <p className="hero-desc">
              Platform paper trading intuitif yang ramah untuk pemula, namun tetap tangguh dibekali instrumen analisis bagi para profesional. Uji strategi Anda tanpa risiko finansial sekarang juga.
            </p>

            <div className="landing-hero-actions">
              <button 
                className="landing-btn landing-btn-primary landing-btn-large" 
                onClick={handleCTA}
              >
                {token ? 'Masuk ke Dashboard' : 'Buka Akun Gratis'}
                <ArrowRight size={20} />
              </button>
              <a 
                href="#simulasi" 
                className="landing-btn landing-btn-outline landing-btn-large"
              >
                Pelajari Fitur
              </a>
            </div>

            <div className="landing-hero-stats">
              <div className="landing-stat-item">
                <p className="landing-stat-value">Risk-Free</p>
                <p className="landing-stat-label">100% Simulasi</p>
              </div>
              <div className="landing-stat-divider"></div>
              <div className="landing-stat-item">
                <p className="landing-stat-value">Rp 100 Jt</p>
                <p className="landing-stat-label">Virtual Balance</p>
              </div>
              <div className="landing-stat-divider"></div>
              <div className="landing-stat-item">
                <p className="landing-stat-value">Real-Time</p>
                <p className="landing-stat-label">Mock Market Data</p>
              </div>
            </div>
          </div>

          {/* Hero Right: 3D Isometric Dashboard Preview */}
          <div className="landing-hero-right">
            {/* Background Decorative Cubes */}
            <div className="landing-cube landing-cube-1"></div>
            <div className="landing-cube landing-cube-2"></div>
            <div className="landing-cube landing-cube-3"></div>

            <div className="landing-floating-wrapper">
              {/* Card 1: Chart Card */}
              <div className="landing-isometric-card landing-card-chart">
                <div className="landing-chart-header">
                  <div className="landing-chart-info">
                    <div className="landing-chart-avatar">M</div>
                    <div className="landing-chart-name">
                      <h3>MNDL / IDR</h3>
                      <p>Mandala Capital Corp.</p>
                    </div>
                  </div>
                  <div className="landing-chart-values">
                    <p className="landing-chart-price">+12.42%</p>
                    <p className="landing-chart-vol">Vol: 1.4M</p>
                  </div>
                </div>

                <div className="landing-chart-graph">
                  <div className="landing-chart-grid">
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                    <div className="landing-chart-grid-line"></div>
                  </div>
                  
                  {/* Candlesticks simulation */}
                  <div className="landing-chart-candlesticks">
                    <div className="landing-candle up" style={{ height: '35%' }}></div>
                    <div className="landing-candle up" style={{ height: '55%' }}></div>
                    <div className="landing-candle down" style={{ height: '40%' }}></div>
                    <div className="landing-candle up" style={{ height: '75%' }}></div>
                    <div className="landing-candle up" style={{ height: '95%' }}></div>
                    <div className="landing-candle up" style={{ height: '85%' }}></div>
                    <div className="landing-candle down" style={{ height: '60%' }}></div>
                    <div className="landing-candle up" style={{ height: '70%' }}></div>
                  </div>
                </div>

                <div className="landing-chart-badges">
                  <span className="landing-chart-badge rsi">RSI 65.4</span>
                  <span className="landing-chart-badge" style={{ color: '#aec7fd', borderColor: 'rgba(174, 199, 253, 0.2)' }}>EMA 20</span>
                  <span className="landing-chart-badge" style={{ color: '#10b981', borderColor: 'rgba(16, 185, 129, 0.2)' }}>Breakout</span>
                </div>
              </div>

              {/* Card 2: Portfolio Snapshot */}
              <div className="landing-isometric-card landing-card-portfolio">
                <h4 className="landing-portfolio-title">Portfolio Snapshot</h4>
                <div className="landing-portfolio-content">
                  <div className="landing-portfolio-chart">
                    <svg className="landing-portfolio-svg" viewBox="0 0 36 36">
                      <circle cx="18" cy="18" r="16" fill="none" stroke="#2d1b19" strokeWidth="4"></circle>
                      <circle cx="18" cy="18" r="16" fill="none" stroke="#E62225" strokeWidth="4" strokeDasharray="70 100"></circle>
                    </svg>
                    <div className="landing-portfolio-center">70%</div>
                  </div>

                  <div className="landing-portfolio-legend">
                    <div className="landing-legend-item">
                      <span className="landing-legend-dot equities"></span>
                      <span>Equities</span>
                    </div>
                    <div className="landing-legend-item">
                      <span className="landing-legend-dot cash"></span>
                      <span>Cash</span>
                    </div>
                    <div className="landing-portfolio-profit">
                      Profit: +Rp 8.4M
                    </div>
                  </div>
                </div>
              </div>

              {/* Card 3: Order Book */}
              <div className="landing-isometric-card landing-card-orderbook">
                <div className="landing-orderbook-title">
                  <span>Order Book</span>
                  <Activity size={14} className="text-secondary" />
                </div>
                
                <div className="landing-orderbook-grid">
                  <div className="landing-orderbook-col bids">
                    <div className="landing-orderbook-row"><span>1,245</span><span>500K</span></div>
                    <div className="landing-orderbook-row"><span>1,240</span><span>1.2M</span></div>
                    <div className="landing-orderbook-row"><span>1,235</span><span>800K</span></div>
                  </div>
                  <div className="landing-orderbook-col asks">
                    <div className="landing-orderbook-row"><span>1,250</span><span>200K</span></div>
                    <div className="landing-orderbook-row"><span>1,255</span><span>150K</span></div>
                    <div className="landing-orderbook-row"><span>1,260</span><span>900K</span></div>
                  </div>
                </div>

                <div className="landing-orderbook-actions">
                  <button className="landing-ob-btn buy" onClick={handleCTA}>Beli</button>
                  <button className="landing-ob-btn sell" onClick={handleCTA}>Jual</button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </main>

      {/* Partners / Ticker Bar */}
      <section className="landing-ticker" id="simulasi">
        <div className="landing-ticker-wrapper">
          <div className="landing-ticker-item">
            <Building size={20} />
            <span>BURSA EFEK INDONESIA (SIMULASI)</span>
          </div>
          <div className="landing-ticker-item">
            <ShieldCheck size={20} />
            <span>OJK REGULASI INTEGRASI (SIMULASI)</span>
          </div>
          <div className="landing-ticker-item">
            <Lock size={20} />
            <span>KSEI TERDAFTAR (virtual)</span>
          </div>
          <div className="landing-ticker-item">
            <LineChart size={20} />
            <span>SIPF PROTECTED (MOCK)</span>
          </div>
          {/* Repeat for seamless loop */}
          <div className="landing-ticker-item">
            <Building size={20} />
            <span>BURSA EFEK INDONESIA (SIMULASI)</span>
          </div>
          <div className="landing-ticker-item">
            <ShieldCheck size={20} />
            <span>OJK REGULASI INTEGRASI (SIMULASI)</span>
          </div>
          <div className="landing-ticker-item">
            <Lock size={20} />
            <span>KSEI TERDAFTAR (VIRTUAL)</span>
          </div>
        </div>
      </section>

      {/* Disclaimer Section */}
      <section className="landing-disclaimer" id="fitur">
        <div className="landing-disclaimer-container">
          <div className="landing-disclaimer-title">
            <Info size={24} color="#E62225" />
            <h2>Pemberitahuan & Disclaimer Simulasi</h2>
          </div>
          <p className="landing-disclaimer-text">
            Mandala Sekuritas pada situs ini adalah platform simulasi paper trading edukatif (Mandala Exchange Simulator) untuk kebutuhan pengujian sistem dan pembelajaran investasi. Seluruh dana, transaksi, komisi, dan portofolio yang ada di dalam platform ini bersifat virtual dan tidak melibatkan uang atau efek riil di bursa nyata.
          </p>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-container">
          <div className="landing-footer-top">
            <div className="landing-footer-brand">
              <span className="landing-footer-title">Mandala Sekuritas</span>
              <p className="landing-footer-desc">
                Portal simulasi transaksi bursa modern. Cepat, aman, dan tanpa risiko keuangan.
              </p>
            </div>

            <div className="landing-footer-links">
              <a href="#" className="landing-footer-link">Kebijakan Privasi</a>
              <a href="#" className="landing-footer-link">Syarat & Ketentuan</a>
              <a href="#" className="landing-footer-link">Keterbukaan Risiko</a>
              <a href="#" className="landing-footer-link">Hubungi Kami</a>
            </div>

            <div className="landing-footer-socials">
              <a href="#" className="landing-social-btn"><Globe size={18} /></a>
              <a href="#" className="landing-social-btn"><Mail size={18} /></a>
              <a href="#" className="landing-social-btn"><MessageSquare size={18} /></a>
            </div>
          </div>

          <div className="landing-footer-bottom">
            <p className="landing-footer-copy">
              © {new Date().getFullYear()} Mandala Sekuritas. All rights reserved. Platform Simulasi Edukatif.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
