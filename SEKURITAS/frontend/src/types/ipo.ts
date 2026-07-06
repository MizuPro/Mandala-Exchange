export type IpoStatus = 'draft' | 'bookbuilding' | 'subscription' | 'allocation' | 'listed' | 'cancelled';

export interface IpoEvent {
  id: string;
  version: number;
  issuer_code: string;
  symbol: string;
  company_name: string;
  status: IpoStatus;
  offered_shares: number;
  offering_price_idr: number;
  subscription_lot_size: number;
  bookbuilding_start?: string;
  bookbuilding_end?: string;
  subscription_start: string;
  subscription_end: string;
  listing_at: string;
  ipo_hype_score?: number;
  ipo_archetype?: string;
  oversubscription_ratio?: number;
  float_ratio?: 'low' | 'medium' | 'high';
  sector_sentiment?: string;
  listing_sentiment?: string;
  fair_value_initial?: number;
  fair_value_confidence?: 'low' | 'medium' | 'high';
  published_at?: string;
  updated_at?: string;
}

export type IpoSubscriptionStatus = 
  | 'cash_reserved' 
  | 'submitted_to_bei' 
  | 'allocated' 
  | 'refunded' 
  | 'settled' 
  | 'cancelled' 
  | 'reversed';

export interface IpoSubscription {
  subscription_id: string;
  ipo_event_id: string;
  symbol: string;
  status: IpoSubscriptionStatus;
  requested_shares: number;
  allocated_shares: number;
  offering_price_idr: string;
  reserved_cash_idr: string;
  actual_debit_idr: string;
  official_fee_idr: string;
  bei_subscription_id?: string;
  event_version: number;
  created_at: string;
  updated_at: string;
}
