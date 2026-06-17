export type OrderStatus =
  | "pending"
  | "accepted"
  | "open"
  | "amended"
  | "partially_filled"
  | "filled"
  | "cancelled"
  | "rejected"
  | "expired"
  | "locked_non_cancellable";

const STATUS_MAP: Record<string, OrderStatus> = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  OPEN: "open",
  AMENDED: "amended",
  PARTIAL_FILL: "partially_filled",
  PARTIALLY_FILLED: "partially_filled",
  FILLED: "filled",
  CANCELLED: "cancelled",
  CANCELED: "cancelled",
  REJECTED: "rejected",
  EXPIRED: "expired",
  LOCKED_NON_CANCELLABLE: "locked_non_cancellable",
  pending: "pending",
  accepted: "accepted",
  open: "open",
  amended: "amended",
  partial_fill: "partially_filled",
  partially_filled: "partially_filled",
  filled: "filled",
  cancelled: "cancelled",
  canceled: "cancelled",
  rejected: "rejected",
  expired: "expired",
  locked_non_cancellable: "locked_non_cancellable",
};

export function normalizeOrderStatus(status: unknown): OrderStatus {
  const raw = String(status || "").trim();
  const normalized = STATUS_MAP[raw] || STATUS_MAP[raw.toUpperCase()];
  if (!normalized) {
    throw new Error(`Unsupported order status: ${raw || "(empty)"}`);
  }
  return normalized;
}

export function isTerminalOrderStatus(status: unknown) {
  const normalized = normalizeOrderStatus(status);
  return ["filled", "cancelled", "rejected", "expired"].includes(normalized);
}

export function isFillOrderStatus(status: unknown) {
  const normalized = normalizeOrderStatus(status);
  return normalized === "filled" || normalized === "partially_filled";
}

