import { describe, expect, it } from "vitest";
import { isFillOrderStatus, isTerminalOrderStatus, normalizeOrderStatus } from "./order-status.js";

describe("order status normalization", () => {
  it("normalizes MATS lowercase and legacy uppercase statuses", () => {
    expect(normalizeOrderStatus("PARTIAL_FILL")).toBe("partially_filled");
    expect(normalizeOrderStatus("partially_filled")).toBe("partially_filled");
    expect(normalizeOrderStatus("CANCELED")).toBe("cancelled");
    expect(normalizeOrderStatus("SUBMIT_UNKNOWN")).toBe("submit_unknown");
  });

  it("classifies fill and terminal statuses", () => {
    expect(isFillOrderStatus("filled")).toBe(true);
    expect(isFillOrderStatus("partially_filled")).toBe(true);
    expect(isTerminalOrderStatus("rejected")).toBe(true);
    expect(isTerminalOrderStatus("locked_non_cancellable")).toBe(false);
  });
});
