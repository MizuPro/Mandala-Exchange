import { FastifyInstance } from "fastify";
import { beiClient } from "../services/bei-client.js";
import { handleMarketWsClient } from "../services/market-ws-proxy.js";

export default async function marketRoutes(app: FastifyInstance) {
  app.get("/ws", { websocket: true }, (socket, request) => {
    handleMarketWsClient(socket, request.log);
  });

  // Proxy Listed Securities
  app.get("/securities", async (request, reply) => {
    try {
      const data = await beiClient.getListedSecurities();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch securities from BEI" });
    }
  });

  // Proxy Fee Schedule
  app.get("/fees", async (request, reply) => {
    try {
      const data = await beiClient.getFeeSchedule();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch fees from BEI" });
    }
  });

  app.get("/securities/:symbol", async (request: any, reply) => {
    try {
      const data = await beiClient.getSecurity(request.params.symbol);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch security detail from BEI" });
    }
  });

  app.get("/securities/:symbol/fundamentals", async (request: any, reply) => {
    try {
      const data = await beiClient.getFundamentals(request.params.symbol);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch fundamentals from BEI" });
    }
  });

  app.get("/securities/:symbol/announcements", async (request: any, reply) => {
    try {
      const data = await beiClient.getAnnouncements(request.params.symbol);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch issuer announcements from BEI" });
    }
  });

  app.get("/announcements", async (request: any, reply) => {
    const symbol = String(request.query?.symbol || "").trim();
    if (!symbol) return reply.status(400).send({ error: "symbol query is required" });
    try {
      const data = await beiClient.getAnnouncements(symbol);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch issuer announcements from BEI" });
    }
  });

  app.get("/corporate-actions", async (_request, reply) => {
    try {
      const data = await beiClient.getCorporateActions();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch corporate actions from BEI" });
    }
  });

  app.get("/ipo-events", async (_request, reply) => {
    try {
      const data = await beiClient.getIpoEvents();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch IPO events from BEI" });
    }
  });

  app.get("/reports/trades/:sessionId", async (request: any, reply) => {
    try {
      const data = await beiClient.getTradesReport(request.params.sessionId);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch trades report from BEI" });
    }
  });

  app.get("/reports/settlements/:sessionId", async (request: any, reply) => {
    try {
      const data = await beiClient.getSettlementsReport(request.params.sessionId);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch settlements report from BEI" });
    }
  });

  app.get("/reports/market-summary/:sessionId", async (request: any, reply) => {
    try {
      const data = await beiClient.getMarketSummaryReport(request.params.sessionId);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch market summary report from BEI" });
    }
  });

  // Market Indices (MDX, dll)
  app.get("/indices", async (_request, reply) => {
    try {
      const data = await beiClient.getMarketIndices();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch market indices from BEI" });
    }
  });

  // Index History untuk chart
  app.get("/indices/:code/history", async (request: any, reply) => {
    try {
      const period = (request.query as any)?.period || "7D";
      const data = await beiClient.getIndexHistory(request.params.code, period);
      return reply.send(data);
    } catch (e: any) {
      return reply.status(502).send({ error: e.message || "Failed to fetch index history from BEI" });
    }
  });
}
