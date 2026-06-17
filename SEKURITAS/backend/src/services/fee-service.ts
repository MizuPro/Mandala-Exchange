import { beiClient } from "./bei-client.js";

export interface FeeScheduleSnapshot {
  brokerBuyRate: number;
  brokerSellRate: number;
  exchangeFeeRate: number;
  clearingFeeRate: number;
  settlementFeeRate: number;
  guaranteeFundRate: number;
  vatRate: number;
  sellTaxRate: number;
  minimumFee: number;
}

export interface FeeBreakdown {
  brokerFee: number;
  marketFee: number;
  vatFee: number;
  sellTax: number;
  totalFee: number;
  snapshot: FeeScheduleSnapshot;
}

const fallbackSchedule: FeeScheduleSnapshot = {
  brokerBuyRate: 0.001,
  brokerSellRate: 0.001,
  exchangeFeeRate: 0.0004,
  clearingFeeRate: 0.00003,
  settlementFeeRate: 0,
  guaranteeFundRate: 0,
  vatRate: 0.11,
  sellTaxRate: 0.001,
  minimumFee: 0,
};

let cached: { value: FeeScheduleSnapshot; expiresAt: number } | null = null;

function numeric(value: unknown, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readRate(data: any, camelKey: string, snakeKey: string, fallback: number) {
  return numeric(data?.[camelKey] ?? data?.[snakeKey], fallback);
}

export async function getFeeScheduleSnapshot(): Promise<FeeScheduleSnapshot> {
  if (cached && cached.expiresAt > Date.now()) return cached.value;

  try {
    const data = await beiClient.getFeeSchedule();
    const value: FeeScheduleSnapshot = {
      brokerBuyRate: readRate(data, "brokerBuyRate", "broker_buy_rate", fallbackSchedule.brokerBuyRate),
      brokerSellRate: readRate(data, "brokerSellRate", "broker_sell_rate", fallbackSchedule.brokerSellRate),
      exchangeFeeRate: readRate(data, "exchangeFeeRate", "exchange_fee_rate", fallbackSchedule.exchangeFeeRate),
      clearingFeeRate: readRate(data, "clearingFeeRate", "clearing_fee_rate", fallbackSchedule.clearingFeeRate),
      settlementFeeRate: readRate(data, "settlementFeeRate", "settlement_fee_rate", fallbackSchedule.settlementFeeRate),
      guaranteeFundRate: readRate(data, "guaranteeFundRate", "guarantee_fund_rate", fallbackSchedule.guaranteeFundRate),
      vatRate: readRate(data, "vatRate", "vat_rate", fallbackSchedule.vatRate),
      sellTaxRate: readRate(data, "sellTaxRate", "sell_tax_rate", fallbackSchedule.sellTaxRate),
      minimumFee: readRate(data, "minimumFee", "minimum_fee", fallbackSchedule.minimumFee),
    };
    cached = { value, expiresAt: Date.now() + 60_000 };
    return value;
  } catch {
    return fallbackSchedule;
  }
}

export function calculateFee(value: number, side: "BUY" | "SELL", snapshot: FeeScheduleSnapshot = fallbackSchedule): FeeBreakdown {
  const brokerRate = side === "BUY" ? snapshot.brokerBuyRate : snapshot.brokerSellRate;
  const brokerFee = value * brokerRate;
  const marketFee = value * (
    snapshot.exchangeFeeRate +
    snapshot.clearingFeeRate +
    snapshot.settlementFeeRate +
    snapshot.guaranteeFundRate
  );
  const vatFee = brokerFee * snapshot.vatRate;
  const sellTax = side === "SELL" ? value * snapshot.sellTaxRate : 0;
  const totalFee = Math.max(snapshot.minimumFee, brokerFee + marketFee + vatFee + sellTax);

  return { brokerFee, marketFee, vatFee, sellTax, totalFee, snapshot };
}

export async function estimateFee(value: number, side: "BUY" | "SELL") {
  return calculateFee(value, side, await getFeeScheduleSnapshot());
}
