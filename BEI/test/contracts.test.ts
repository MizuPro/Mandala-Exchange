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

  it("serves one authenticated public announcement feed without future publications", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/announcements",
      headers: { "x-service-token": tokenFor("readonly") }
    });

    expect(response.statusCode).toBe(200);
    const announcements = response.json();
    expect(Array.isArray(announcements)).toBe(true);
    for (const announcement of announcements) {
      expect(typeof announcement.id).toBe("string");
      expect(new Date(announcement.published_at).getTime()).toBeLessThanOrEqual(Date.now());
    }
  });

  it("maps tokens to service identities", () => {
    expect(findIdentity(tokenFor("admin"))?.name).toBe("admin");
    expect(findIdentity(tokenFor("mats"))?.name).toBe("mats");
    expect(findIdentity("not-a-valid-token")).toBeUndefined();
  });

  it("allows MATS only for market/rules/broker reads, trade capture, market summary write, and session status sync", () => {
    const mats = identityFor("mats");

    expect(serviceCanAccess(mats, "GET", "/v1/integration/mats/rules")).toBe(true);
    expect(serviceCanAccess(mats, "GET", "/v1/integration/mats/securities")).toBe(true);
    expect(serviceCanAccess(mats, "GET", "/v1/brokers/:code/validate")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/trades/capture")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/market-summaries")).toBe(true);
    expect(serviceCanAccess(mats, "POST", "/v1/integration/mats/sessions/active/status")).toBe(true);
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

  // BOT-v2: Contract Tests
  describe("BOT-v2 specific contract guards", () => {
    it("allows bot service to read all bot endpoints", () => {
      const bot = identityFor("bot");

      expect(serviceCanAccess(bot, "GET", "/bot/daftar-saham-aktif")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/trading-rules")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/fee-schedule")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/session-state")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/ipo-lifecycle")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/corporate-action-minimal")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/news-module")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/fair-value-module")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/market-regime")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/bot/liquidity-profile")).toBe(true);
    });

    it("denies bot service access to admin endpoints", () => {
      const bot = identityFor("bot");

      expect(serviceCanAccess(bot, "POST", "/bot/admin/fair-value")).toBe(false);
      expect(serviceCanAccess(bot, "POST", "/bot/admin/market-regime")).toBe(false);
    });

    it("allows admin to access admin endpoints", () => {
      const admin = identityFor("admin");

      expect(serviceCanAccess(admin, "POST", "/bot/admin/fair-value")).toBe(true);
      expect(serviceCanAccess(admin, "POST", "/bot/admin/market-regime")).toBe(true);
      expect(serviceCanAccess(admin, "POST", "/v1/news")).toBe(true);
      expect(serviceCanAccess(admin, "PATCH", "/v1/news/:id")).toBe(true);
      expect(serviceCanAccess(admin, "POST", "/v1/news/:id/publish")).toBe(true);
      expect(serviceCanAccess(admin, "DELETE", "/v1/news/:id")).toBe(true);
    });

    it("allows public/player to access public news and fair value endpoints", () => {
      const bot = identityFor("bot");
      const readonly = identityFor("readonly");

      expect(serviceCanAccess(bot, "GET", "/v1/public/news")).toBe(true);
      expect(serviceCanAccess(readonly, "GET", "/v1/public/news/:id")).toBe(true);
      expect(serviceCanAccess(bot, "GET", "/v1/public/fair-values")).toBe(true);
      expect(serviceCanAccess(readonly, "GET", "/v1/public/fair-values/:symbol")).toBe(true);
    });

    it("denies other services from accessing specific bot endpoints if scope is missing", () => {
      const mats = identityFor("mats");
      const readonly = identityFor("readonly");

      // mats has market:read, rules:read, broker:read, trade:capture, market-summary:write, session:write
      // mats does NOT have ipo:read or corporate-action:read
      expect(serviceCanAccess(mats, "GET", "/bot/ipo-lifecycle")).toBe(false);
      expect(serviceCanAccess(mats, "GET", "/bot/corporate-action-minimal")).toBe(false);

      // readonly has market:read, rules:read, broker:read, corporate-action:read, report:read
      // readonly does NOT have ipo:read
      expect(serviceCanAccess(readonly, "GET", "/bot/corporate-action-minimal")).toBe(true);
      expect(serviceCanAccess(readonly, "GET", "/bot/ipo-lifecycle")).toBe(false);
    });

    it("restricts HTTP requests correctly (End-to-End simulation)", async () => {
      // 1. GET /bot/daftar-saham-aktif tanpa token -> 401
      const noTokenRes = await app.inject({ method: "GET", url: "/bot/daftar-saham-aktif" });
      expect(noTokenRes.statusCode).toBe(401);

      // 2. GET /bot/daftar-saham-aktif dengan token bot valid -> 200
      const botTokenRes = await app.inject({
        method: "GET",
        url: "/bot/daftar-saham-aktif",
        headers: { "x-service-token": tokenFor("bot") }
      });
      expect(botTokenRes.statusCode).toBe(200);

      // 3. POST /bot/admin/fair-value dengan token bot -> 403 (bot tidak punya scope admin:*)
      const botAdminRes = await app.inject({
        method: "POST",
        url: "/bot/admin/fair-value",
        headers: { "x-service-token": tokenFor("bot") },
        payload: {
          symbol: "MNDL",
          fairValue: 1250,
          confidence: "medium",
          method: "admin_estimate"
        }
      });
      expect(botAdminRes.statusCode).toBe(403);

      // 4. POST /bot/admin/fair-value dengan token admin -> 201
      const adminAdminRes = await app.inject({
        method: "POST",
        url: "/bot/admin/fair-value",
        headers: { "x-service-token": tokenFor("admin") },
        payload: {
          symbol: "MNDL",
          fairValue: 1250,
          confidence: "medium",
          method: "admin_estimate"
        }
      });
      expect(adminAdminRes.statusCode).toBe(201);

      // 5. POST /v1/news (Create Draft News) -> 201
      const createNewsRes = await app.inject({
        method: "POST",
        url: "/v1/news",
        headers: { "x-service-token": tokenFor("admin") },
        payload: {
          title: "Test News Title",
          body: "Test News Body Content that is long enough.",
          symbol: "MNDL",
          sentiment: "positive",
          intensity: "medium",
          simulationOnly: false
        }
      });
      expect(createNewsRes.statusCode).toBe(201);
      const createdNews = createNewsRes.json();
      expect(createdNews.status).toBe("draft");

      // 6. PATCH /v1/news/:id (Update Draft News) -> 200
      const updateNewsRes = await app.inject({
        method: "PATCH",
        url: `/v1/news/${createdNews.id}`,
        headers: { "x-service-token": tokenFor("admin") },
        payload: {
          title: "Updated Test News Title"
        }
      });
      expect(updateNewsRes.statusCode).toBe(200);
      expect(updateNewsRes.json().title).toBe("Updated Test News Title");

      // 7. POST /v1/news/:id/publish (Publish News) -> 200
      const publishNewsRes = await app.inject({
        method: "POST",
        url: `/v1/news/${createdNews.id}/publish`,
        headers: { "x-service-token": tokenFor("admin") }
      });
      expect(publishNewsRes.statusCode).toBe(200);
      expect(publishNewsRes.json().status).toBe("published");

      // 8. GET /v1/public/news (Read Public News) -> 200
      const readPublicNewsRes = await app.inject({
        method: "GET",
        url: "/v1/public/news?symbol=MNDL",
        headers: { "x-service-token": tokenFor("bot") }
      });
      expect(readPublicNewsRes.statusCode).toBe(200);
      const publicNews = readPublicNewsRes.json();
      expect(publicNews.data.length).toBeGreaterThan(0);
      expect(publicNews.data[0].title).toBe("Updated Test News Title");

      // 9. DELETE /v1/news/:id (Try to delete published news) -> 409 Conflict
      const deletePublishedRes = await app.inject({
        method: "DELETE",
        url: `/v1/news/${createdNews.id}`,
        headers: { "x-service-token": tokenFor("admin") }
      });
      expect(deletePublishedRes.statusCode).toBe(409);

      // 10. GET /v1/public/fair-values (Read Public Fair Values) -> 200
      const readPublicFVRes = await app.inject({
        method: "GET",
        url: "/v1/public/fair-values?symbol=MNDL",
        headers: { "x-service-token": tokenFor("bot") }
      });
      expect(readPublicFVRes.statusCode).toBe(200);
      const publicFVList = readPublicFVRes.json();
      expect(publicFVList.length).toBeGreaterThan(0);
      expect(publicFVList[0].symbol).toBe("MNDL");

      // 11. GET /v1/public/fair-values/:symbol (Read Detail Public Fair Value) -> 200
      const readDetailFVRes = await app.inject({
        method: "GET",
        url: "/v1/public/fair-values/MNDL",
        headers: { "x-service-token": tokenFor("bot") }
      });
      expect(readDetailFVRes.statusCode).toBe(200);
      expect(readDetailFVRes.json().symbol).toBe("MNDL");
    });
  });
});
