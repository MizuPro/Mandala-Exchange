import { create } from 'zustand';
import { ApiError, fetchApi } from '../api/client';

export interface User {
  id: string;
  email: string;
  is_verified: boolean;
  status?: string;
}

export interface Portfolio {
  cash: { available: string, reserved: string, pending: string };
  positions: Array<{ symbol: string, available: number, reserved: number, pending: number, average_price: string, realized_pl: string }>;
}

import { components } from '../types/api';

export type Order = components["schemas"]["Order"];

export interface ListedSecurity {
  symbol?: string;
  code?: string;
  name?: string;
  tradingStatus?: string;
  trading_status?: string;
}

export interface FeeSchedule {
  brokerBuyRate?: string;
  brokerSellRate?: string;
  exchangeFeeRate?: string;
  clearingFeeRate?: string;
  settlementFeeRate?: string;
  guaranteeFundRate?: string;
  vatRate?: string;
  sellTaxRate?: string;
  minimumFee?: string;
}

export interface MarketState {
  connected: boolean;
  sessionStatus: string;
  timeRemainingSeconds?: number;
  durationSeconds?: number;
  marketHalt: boolean;
  suspendedSymbols: string[];
  lastPrices: Record<string, number>;
  depth: Record<string, { bids: any[]; asks: any[] }>;
  trades: any[];
}

export interface AccountProfile {
  account: { id: string; account_type: string; status: string; created_at: string };
  references: { sid: string | null; sre: string | null; rdn: string | null };
}

export interface CompanyState {
  symbol: string;
  detail: any | null;
  fundamentals: any | null;
  announcements: any[];
}

export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  read_at?: string | null;
  created_at: string;
}

interface AppState {
  user: User | null;
  token: string | null;
  authReady: boolean;
  portfolio: Portfolio | null;
  orders: Order[];
  securities: ListedSecurity[];
  feeSchedule: FeeSchedule | null;
  accountProfile: AccountProfile | null;
  company: CompanyState;
  corporateActions: any[];
  ipoEvents: any[];
  settlementStatus: any[];
  custodySummary: any | null;
  reconciliation: any | null;
  tradeHistory: any[];
  leaderboard: any | null;
  notifications: NotificationItem[];
  market: MarketState;
  portfolioLoading: boolean;
  ordersLoading: boolean;
  orderActionLoading: boolean;
  marketLoading: boolean;
  dashboardLoading: boolean;
  isLoading: boolean;
  error: string | null;

  hydrateSession: () => Promise<void>;
  login: (token: string, user: User) => void;
  logout: () => void;
  verifyEmail: (token: string) => Promise<void>;
  fetchPortfolio: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  fetchMarketData: () => Promise<void>;
  fetchAccountProfile: () => Promise<void>;
  fetchCompany: (symbol: string) => Promise<void>;
  fetchCorporateActions: () => Promise<void>;
  fetchIpoEvents: () => Promise<void>;
  fetchSettlementStatus: (sessionId: string) => Promise<void>;
  fetchCustodySummary: () => Promise<void>;
  fetchReconciliation: () => Promise<void>;
  fetchTradeHistory: () => Promise<void>;
  fetchLeaderboard: () => Promise<void>;
  fetchNotifications: () => Promise<void>;
  markNotificationRead: (id: string) => Promise<void>;
  placeOrder: (symbol: string, side: "buy" | "sell", price: number | undefined, quantity: number, orderType?: "limit" | "market") => Promise<void>;
  amendOrder: (id: string, payload: { price?: number; quantity?: number }) => Promise<void>;
  cancelOrder: (id: string) => Promise<void>;
  applyMarketEvent: (event: any) => void;
}

function readStoredUser() {
  const raw = localStorage.getItem('user');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as User;
  } catch {
    localStorage.removeItem('user');
    return null;
  }
}

function isUnauthorized(err: unknown) {
  return err instanceof ApiError && err.status === 401;
}

function isAccountForbidden(err: unknown) {
  return err instanceof ApiError && err.status === 403;
}

export const useStore = create<AppState>((set, get) => ({
  user: readStoredUser(),
  token: localStorage.getItem('token'),
  authReady: false,
  portfolio: null,
  orders: [],
  securities: [],
  feeSchedule: null,
  accountProfile: null,
  company: { symbol: '', detail: null, fundamentals: null, announcements: [] },
  corporateActions: [],
  ipoEvents: [],
  settlementStatus: [],
  custodySummary: null,
  reconciliation: null,
  tradeHistory: [],
  leaderboard: null,
  notifications: [],
  market: { connected: false, sessionStatus: "", marketHalt: false, suspendedSymbols: [], lastPrices: {}, depth: {}, trades: [] },
  portfolioLoading: false,
  ordersLoading: false,
  orderActionLoading: false,
  marketLoading: false,
  dashboardLoading: false,
  isLoading: false,
  error: null,

  hydrateSession: async () => {
    if (!localStorage.getItem('token')) {
      set({ authReady: true, user: null, token: null });
      return;
    }

    try {
      const data = await fetchApi('/auth/me');
      localStorage.setItem('user', JSON.stringify(data.user));
      set({ user: data.user, token: localStorage.getItem('token'), authReady: true, error: null });
    } catch (err: any) {
      if (isUnauthorized(err)) {
        get().logout();
      } else {
        set({ error: err.message });
      }
      set({ authReady: true });
    }
  },

  login: (token, user) => {
    if (!token) throw new Error('Missing auth token');
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    set({ token, user, authReady: true, error: null });
  },

  logout: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    set({
      token: null,
      user: null,
      portfolio: null,
      orders: [],
      accountProfile: null,
      notifications: [],
      authReady: true
    });
  },

  verifyEmail: async (token) => {
    const data = await fetchApi('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ token })
    });
    const current = get().user;
    if (current) {
      const verified = { ...current, is_verified: true, status: 'verified' };
      localStorage.setItem('user', JSON.stringify(verified));
      set({ user: verified, error: null });
    }
    return data;
  },

  fetchPortfolio: async () => {
    if (get().portfolioLoading) return;
    try {
      set({ portfolioLoading: true });
      const data = await fetchApi('/portfolio/summary');
      set({ portfolio: data, portfolioLoading: false, error: null });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      if (isAccountForbidden(err)) set({ error: 'Account verification is required before trading.' });
      set({ error: err.message, portfolioLoading: false });
    }
  },

  fetchOrders: async () => {
    if (get().ordersLoading) return;
    try {
      set({ ordersLoading: true });
      const data = await fetchApi('/orders');
      set({ orders: data, ordersLoading: false, error: null });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      if (isAccountForbidden(err)) set({ error: 'Account verification is required before trading.' });
      set({ error: err.message, ordersLoading: false });
    }
  },

  fetchMarketData: async () => {
    if (get().marketLoading) return;
    try {
      set({ marketLoading: true });
      const [securities, feeSchedule] = await Promise.all([
        fetchApi('/market/securities'),
        fetchApi('/market/fees'),
      ]);
      set({
        securities: Array.isArray(securities) ? securities : [],
        feeSchedule,
        marketLoading: false,
      });
    } catch (err: any) {
      set({ marketLoading: false, error: err.message });
    }
  },

  fetchAccountProfile: async () => {
    try {
      const data = await fetchApi('/portfolio/account');
      set({ accountProfile: data, error: null });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      set({ error: err.message });
    }
  },

  fetchCompany: async (symbol) => {
    const cleanSymbol = symbol.trim().toUpperCase();
    if (!cleanSymbol) return;
    try {
      set({ dashboardLoading: true, error: null });
      const [detail, fundamentals, announcements] = await Promise.all([
        fetchApi(`/market/securities/${encodeURIComponent(cleanSymbol)}`),
        fetchApi(`/market/securities/${encodeURIComponent(cleanSymbol)}/fundamentals`),
        fetchApi(`/market/securities/${encodeURIComponent(cleanSymbol)}/announcements`),
      ]);
      set({
        company: {
          symbol: cleanSymbol,
          detail,
          fundamentals,
          announcements: Array.isArray(announcements) ? announcements : [],
        },
        dashboardLoading: false,
      });
    } catch (err: any) {
      set({ dashboardLoading: false, error: err.message });
    }
  },

  fetchCorporateActions: async () => {
    try {
      const data = await fetchApi('/market/corporate-actions');
      set({ corporateActions: Array.isArray(data) ? data : [], error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchIpoEvents: async () => {
    try {
      const data = await fetchApi('/market/ipo-events');
      set({ ipoEvents: Array.isArray(data) ? data : [], error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchSettlementStatus: async (sessionId) => {
    const cleanSession = sessionId.trim();
    if (!cleanSession) return;
    try {
      const data = await fetchApi(`/portfolio/settlement/${encodeURIComponent(cleanSession)}`);
      set({ settlementStatus: Array.isArray(data) ? data : [], error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchCustodySummary: async () => {
    try {
      const data = await fetchApi('/portfolio/custody/summary');
      set({ custodySummary: data, error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchReconciliation: async () => {
    try {
      const data = await fetchApi('/portfolio/custody/reconciliation');
      set({ reconciliation: data, error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchTradeHistory: async () => {
    try {
      const data = await fetchApi('/portfolio/fills');
      set({ tradeHistory: Array.isArray(data) ? data : [], error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchLeaderboard: async () => {
    try {
      const data = await fetchApi('/leaderboard');
      set({ leaderboard: data, error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  fetchNotifications: async () => {
    try {
      const data = await fetchApi('/notifications');
      set({ notifications: Array.isArray(data) ? data : [], error: null });
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  markNotificationRead: async (id) => {
    try {
      await fetchApi(`/notifications/${id}/read`, { method: 'PATCH' });
      await get().fetchNotifications();
    } catch (err: any) {
      set({ error: err.message });
    }
  },

  placeOrder: async (symbol, side, price, quantity, orderType = "limit") => {
    try {
      set({ orderActionLoading: true, isLoading: true, error: null });
      await fetchApi('/orders', {
        method: 'POST',
        body: JSON.stringify({
          symbol,
          side,
          order_type: orderType,
          ...(orderType === "limit" ? { price } : {}),
          quantity
        })
      });
      await Promise.all([get().fetchOrders(), get().fetchPortfolio(), get().fetchNotifications()]);
      set({ orderActionLoading: false, isLoading: false });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      set({ error: err.message, orderActionLoading: false, isLoading: false });
      throw err;
    }
  },

  amendOrder: async (id, payload) => {
    try {
      set({ orderActionLoading: true, isLoading: true, error: null });
      await fetchApi(`/orders/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(payload)
      });
      await Promise.all([get().fetchOrders(), get().fetchPortfolio()]);
      set({ orderActionLoading: false, isLoading: false });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      set({ error: err.message, orderActionLoading: false, isLoading: false });
      throw err;
    }
  },

  cancelOrder: async (id) => {
    try {
      set({ orderActionLoading: true, isLoading: true, error: null });
      await fetchApi(`/orders/${id}`, { method: 'DELETE' });
      await Promise.all([get().fetchOrders(), get().fetchPortfolio()]);
      set({ orderActionLoading: false, isLoading: false });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
      set({ error: err.message, orderActionLoading: false, isLoading: false });
      throw err;
    }
  },

  applyMarketEvent: (event) => {
    if (!event || typeof event !== 'object') return;
    set((state) => {
      const market = { ...state.market, connected: true };
      if (event.type === 'session_state') {
        market.sessionStatus = event.payload?.status || event.payload?.session_status || '';
      }
      if (event.type === 'session_timer') {
        market.timeRemainingSeconds = event.payload?.time_remaining_seconds;
        market.durationSeconds = event.payload?.duration_seconds;
      }
      if (event.type === 'market_halt') {
        const symbol = event.symbol || event.payload?.symbol;
        if (symbol) {
          if (event.payload?.status === 'suspended') {
            if (!market.suspendedSymbols.includes(symbol)) {
              market.suspendedSymbols = [...market.suspendedSymbols, symbol];
            }
          } else if (event.payload?.status === 'resumed') {
            market.suspendedSymbols = market.suspendedSymbols.filter(s => s !== symbol);
          }
        } else {
          market.marketHalt = event.payload?.status === 'halted';
        }
      }
      if (event.type === 'last_price' && event.symbol) {
        market.lastPrices = { ...market.lastPrices, [event.symbol]: Number(event.payload?.last || event.payload?.price || 0) };
      }
      if (event.type === 'depth_snapshot' && event.symbol) {
        market.depth = { ...market.depth, [event.symbol]: { bids: event.payload?.bids || [], asks: event.payload?.asks || [] } };
      }
      if (event.type === 'trade_tape') {
        market.trades = [event.payload, ...market.trades].filter(Boolean).slice(0, 20);
      }
      return { market };
    });
  }
}));
