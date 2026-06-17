import type { FastifyInstance } from "fastify";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { config } from "../src/config.js";
import { closeDb } from "../src/db/index.js";
import { findIdentity, serviceCanAccess } from "../src/lib/auth.js";

function tokenFor(serviceName: string) {
  const identity = config.BEI_SERVICE_TOKENS.find((service) => service.name === serviceName);
  if (!identity) throw new Error(`Missing ${serviceName} test token`);
  return identity.token;
}

function identityFor(serviceName: string) {
  const identity = config.BEI_SERVICE_TOKENS.find((service) => service.name === serviceName);
  if (!identity) throw new Error(`Missing ${serviceName} test identity`);
  return identity;
}

describe("BEI integration contract guard", () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await createApp();
  });

  afterAll(async () => {
    await app.close();
    await closeDb();
  });

  it("returns 401 when no service token is provided", async () => {
    const matsRules = await app.inject({ method: "GET", url: "/v1/integration/mats/rules" });
    const sekuritasFee = await app.inject({ method: "GET", url: "/v1/public/fee-schedule" });

    expect(matsRules.statusCode).toBe(401);
    expect(sekuritasFee.statusCode).toBe(401);
  });

  it("returns 403 when a valid token does not have the route scope", async () => {
    const response = await app.inject({
      method: "POST",
      url: "/v1/issuers",
      headers: { "x-service-token": tokenFor("mats") },
      payload: {
        code: "NOPE",
        name: "Blocked Issuer Tbk",
        sector: "Technology"
      }
    });

    expect(response.statusCode).toBe(403);
  });

  it("maps tokens to service identities", () => {
    expect(findIdentity(tokenFor("admin"))?.name).toBe("admin");
    expect(findIdentity(tokenFor("mats"))?.name).toBe("mats");
    expect(findIdentity("not-a-valid-token")).toBeUndefined();
  });

  it("allows MATS only for market/rules/broker reads, trade capture, and market summary write", () => {
    const mats = identityFor("mats");

    expect(serviceCanAccess(mats, "GET", "/v1/integration/mats/rules")).toBe(true);
    expect(serviceCanAccess(mats, "GET", "/v1/integration/mats/securities")).toBe(true);
    expect(serviceCanAccess(mats, "GET", "/v1/brokers/:code/validate")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/trades/capture")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/market-summaries")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/issuers")).toBe(false);
    expect(serviceCanAccess(mats, "POST", "/v1/settlement/batches/:id/process")).toBe(false);
  });

  it("allows Sekuritas read access without settlement or corporate action writes", () => {
    const sekuritas = identityFor("sekuritas");

    expect(serviceCanAccess(sekuritas, "GET", "/v1/public/securities")).toBe(true);
    expect(serviceCanAccess(sekuritas, "GET", "/v1/public/fee-schedule")).toBe(true);
    expect(serviceCanAccess(sekuritas, "GET", "/v1/custody/accounts/:brokerCode/:investorId/summary")).toBe(true);
    expect(serviceCanAccess(sekuritas, "GET", "/v1/settlement/session/:sessionId")).toBe(true);
    expect(serviceCanAccess(sekuritas, "POST", "/v1/settlement/batches/:id/process")).toBe(false);
    expect(serviceCanAccess(sekuritas, "POST", "/v1/corporate-actions/:id/process")).toBe(false);
  });

  it("allows admin wildcard access", () => {
    const admin = identityFor("admin");

    expect(serviceCanAccess(admin, "POST", "/v1/issuers")).toBe(true);
    expect(serviceCanAccess(admin, "POST", "/v1/settlement/batches/:id/process")).toBe(true);
    expect(serviceCanAccess(admin, "POST", "/v1/corporate-actions/:id/process")).toBe(true);
  });
});
