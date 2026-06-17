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

export interface Order {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "BUY" | "SELL";
  price: string;
  quantity: number;
  filled_quantity: number;
  remaining_quantity: number;
  status: string;
  reject_reason?: string;
  created_at: string;
}

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

interface AppState {
  user: User | null;
  token: string | null;
  authReady: boolean;
  portfolio: Portfolio | null;
  orders: Order[];
  securities: ListedSecurity[];
  feeSchedule: FeeSchedule | null;
  portfolioLoading: boolean;
  ordersLoading: boolean;
  orderActionLoading: boolean;
  marketLoading: boolean;
  isLoading: boolean;
  error: string | null;

  hydrateSession: () => Promise<void>;
  login: (token: string, user: User) => void;
  logout: () => void;
  fetchPortfolio: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  fetchMarketData: () => Promise<void>;
  placeOrder: (symbol: string, side: "BUY" | "SELL", price: number, quantity: number) => Promise<void>;
  cancelOrder: (id: string) => Promise<void>;
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

export const useStore = create<AppState>((set, get) => ({
  user: readStoredUser(),
  token: localStorage.getItem('token'),
  authReady: false,
  portfolio: null,
  orders: [],
  securities: [],
  feeSchedule: null,
  portfolioLoading: false,
  ordersLoading: false,
  orderActionLoading: false,
  marketLoading: false,
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
    set({ token: null, user: null, portfolio: null, orders: [], authReady: true });
  },

  fetchPortfolio: async () => {
    if (get().portfolioLoading) return;
    try {
      set({ portfolioLoading: true });
      const data = await fetchApi('/portfolio/summary');
      set({ portfolio: data, portfolioLoading: false, error: null });
    } catch (err: any) {
      if (isUnauthorized(err)) get().logout();
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

  placeOrder: async (symbol, side, price, quantity) => {
    try {
      set({ orderActionLoading: true, isLoading: true, error: null });
      await fetchApi('/orders', {
        method: 'POST',
        body: JSON.stringify({ symbol, side, price, quantity })
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
  }
}));

