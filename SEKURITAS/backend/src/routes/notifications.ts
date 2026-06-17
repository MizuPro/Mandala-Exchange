import { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";
import { listNotifications, markNotificationRead } from "../services/notification-service.js";

export default async function notificationRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.get("/", async (request: any, reply) => {
    const query = z.object({
      unread: z.coerce.boolean().default(false),
      limit: z.coerce.number().int().min(1).max(100).default(50),
    }).parse(request.query);
    const rows = await listNotifications(request.user_id, query.unread, query.limit);
    return reply.send(rows);
  });

  app.patch("/:id/read", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid() }).parse(request.params);
    try {
      const row = await markNotificationRead(request.user_id, params.id);
      return reply.send(row);
    } catch (error: any) {
      return reply.status(404).send({ error: error.message || "Notification not found" });
    }
  });
}
