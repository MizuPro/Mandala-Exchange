import { create } from 'zustand';
import { fetchApi } from '../api/client';

export interface User {
  id: string;
  email: string;
  is_verified: boolean;
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
  created_at: string;
}

interface AppState {
  user: User | null;
  token: string | null;
  portfolio: Portfolio | null;
  orders: Order[];
  isLoading: boolean;
  error: string | null;
  
  login: (token: string, user: User) => void;
  logout: () => void;
  fetchPortfolio: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  placeOrder: (symbol: string, side: "BUY" | "SELL", price: number, quantity: number) => Promise<void>;
  cancelOrder: (id: string) => Promise<void>;
}

export const useStore = create<AppState>((set, get) => ({
  user: null,
  token: localStorage.getItem('token'),
  portfolio: null,
  orders: [],
  isLoading: false,
  error: null,

  login: (token, user) => {
    localStorage.setItem('token', token);
    set({ token, user, error: null });
  },

  logout: () => {
    localStorage.removeItem('token');
    set({ token: null, user: null, portfolio: null, orders: [] });
  },

  fetchPortfolio: async () => {
    try {
      set({ isLoading: true });
      const data = await fetchApi('/portfolio/summary');
      set({ portfolio: data, isLoading: false });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
    }
  },

  fetchOrders: async () => {
    try {
      const data = await fetchApi('/orders');
      set({ orders: data });
    } catch (err: any) {
      console.error(err);
    }
  },

  placeOrder: async (symbol, side, price, quantity) => {
    try {
      set({ isLoading: true, error: null });
      await fetchApi('/orders', {
        method: 'POST',
        body: JSON.stringify({ symbol, side, price, quantity })
      });
      await get().fetchOrders();
      await get().fetchPortfolio();
      set({ isLoading: false });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  },

  cancelOrder: async (id) => {
    try {
      set({ isLoading: true, error: null });
      await fetchApi(`/orders/${id}`, { method: 'DELETE' });
      await get().fetchOrders();
      await get().fetchPortfolio();
      set({ isLoading: false });
    } catch (err: any) {
      set({ error: err.message, isLoading: false });
      throw err;
    }
  }
}));
