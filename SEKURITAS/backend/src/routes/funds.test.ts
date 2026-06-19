import { describe, expect, it } from "vitest";
import { isSimulatorFundsEnabled } from "./funds.js";

describe("funds route mode guard", () => {
  it("allows simulator funds only outside production", () => {
    expect(isSimulatorFundsEnabled({ isSimulatorFinance: true, isProduction: false } as any)).toBe(true);
  });

  it("rejects simulator funds in production", () => {
    expect(isSimulatorFundsEnabled({ isSimulatorFinance: true, isProduction: true } as any)).toBe(false);
  });

  it("rejects non-simulator finance mode", () => {
    expect(isSimulatorFundsEnabled({ isSimulatorFinance: false, isProduction: false } as any)).toBe(false);
  });
});
