import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";
import { calculateLeaderboard, latestLeaderboardSnapshots } from "../services/leaderboard-service.js";

export default async function leaderboardRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.get("/", async (request: any, reply) => {
    const query = z.object({
      session_id: z.string().optional(),
      snapshot: z.coerce.boolean().default(false),
    }).parse(request.query);
    const data = await calculateLeaderboard(query.session_id, query.snapshot);
    return reply.send(data);
  });

  app.get("/snapshots", async (request: any, reply) => {
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(500).default(100),
    }).parse(request.query);
    return reply.send(await latestLeaderboardSnapshots(query.limit));
  });
}
