import { FastifyInstance } from "fastify";
import { beiClient } from "../services/bei-client.js";

export default async function marketRoutes(app: FastifyInstance) {
  // Proxy Listed Securities
  app.get("/securities", async (request, reply) => {
    try {
      const data = await beiClient.getListedSecurities();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to fetch securities from BEI" });
    }
  });

  // Proxy Fee Schedule
  app.get("/fees", async (request, reply) => {
    try {
      const data = await beiClient.getFeeSchedule();
      return reply.send(data);
    } catch (e: any) {
      return reply.status(500).send({ error: "Failed to fetch fees from BEI" });
    }
  });

  // Additional endpoints for Announcements, IPO, Corporate Actions would go here
  // proxying the BEI API.
}
