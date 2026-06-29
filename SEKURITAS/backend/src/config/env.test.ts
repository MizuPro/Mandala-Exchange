import { describe, expect, it } from "vitest";
import { parseSekuritasEnv } from "./env.js";

const strongBase = {
  APP_ENV: "production",
  NODE_ENV: "production",
  FINANCE_MODE: "rdn",
  DATABASE_URL: "postgresql://mandala_sekuritas_prod:secret@localhost:5532/mandala_sekuritas_prod",
  JWT_SECRET: "prod-jwt-secret-1234567890abcdef1234567890",
  ADMIN_TOKEN: "prod-admin-token-1234567890abcdef1234567890",
  BOT_SERVICE_TOKEN: "prod-bot-service-1234567890abcdef1234567",
  MATS_SERVICE_TOKEN: "prod-mats-service-1234567890abcdef123456",
  MATS_TO_SEKURITAS_TOKEN: "prod-mats-webhook-1234567890abcdef123456",
  BEI_SERVICE_TOKEN: "prod-bei-service-1234567890abcdef1234567",
  BEI_TO_SEKURITAS_TOKEN: "prod-bei-webhook-1234567890abcdef1234567",
  BANK_MANDALA_URL: "https://bankmandala-api.example.com",
  BANK_MANDALA_API_KEY: "prod-bank-mandala-api-key-1234567890",
  WEBHOOK_SECRET: "prod-webhook-secret-1234567890abcdef",
} as NodeJS.ProcessEnv;

describe("Sekuritas environment validation", () => {
  it("rejects simulator finance mode in production", () => {
    expect(() => parseSekuritasEnv({ ...strongBase, FINANCE_MODE: "simulator" })).toThrow(/FINANCE_MODE=simulator/);
  });

  it("rejects the development database in production", () => {
    expect(() => parseSekuritasEnv({
      ...strongBase,
      DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/mandala_sekuritas",
    })).toThrow(/development Sekuritas database/);
  });

  it("accepts a strict production RDN configuration", () => {
    const parsed = parseSekuritasEnv(strongBase);

    expect(parsed.isProduction).toBe(true);
    expect(parsed.financeMode).toBe("rdn");
    expect(parsed.isSimulatorFinance).toBe(false);
  });
});
