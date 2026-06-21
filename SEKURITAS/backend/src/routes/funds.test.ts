import { describe, expect, it } from "vitest";
import { isSimulatorFundsEnabled } from "./funds.js";

describe("funds route mode guard", () => {
  it("allows simulator funds only outside production", () => {
    expect(isSimulatorFundsEnabled({ financeMode: "simulator", isProduction: false } as any)).toBe(true);
  });

  it("rejects production RDN mode", () => {
    expect(isSimulatorFundsEnabled({ financeMode: "rdn", isProduction: true } as any)).toBe(false);
  });

  it("allows non-production fallback even when finance mode is RDN", () => {
    expect(isSimulatorFundsEnabled({ financeMode: "rdn", isProduction: false } as any)).toBe(true);
  });
});
