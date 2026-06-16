import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/index.js";
import { brokerMembers } from "../db/schema.js";
import { actorFromRequest, correlationIdFromRequest, writeAudit } from "../lib/audit.js";
import { badRequest, notFound } from "../lib/errors.js";
import { brokerStatuses } from "../types/enums.js";

const brokerBody = z.object({
  code: z.string().min(2).max(12).transform((value) => value.toUpperCase()),
  name: z.string().min(2),
  status: z.enum(brokerStatuses).default("active"),
  serviceIdentifier: z.string().min(3),
  metadata: z.record(z.unknown()).default({})
});

export async function registerBrokerRoutes(app: FastifyInstance) {
  app.get("/brokers", async () => db.select().from(brokerMembers).orderBy(brokerMembers.code));

  app.post("/brokers", async (request) => {
    const body = brokerBody.parse(request.body);
    const [created] = await db.insert(brokerMembers).values(body).returning();
    if (!created) throw badRequest("Broker was not created");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "broker.create",
      entityType: "broker_member",
      entityId: created.id,
      after: created,
      correlationId: correlationIdFromRequest(request)
    });
    return created;
  });

  app.patch("/brokers/:code/status", async (request) => {
    const params = z.object({ code: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const body = z.object({ status: z.enum(brokerStatuses), reason: z.string().optional() }).parse(request.body);
    const [before] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, params.code));
    if (!before) throw notFound("Broker not found");
    const [updated] = await db
      .update(brokerMembers)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(brokerMembers.code, params.code))
      .returning();
    if (!updated) throw badRequest("Broker status was not updated");
    await writeAudit({
      actor: actorFromRequest(request),
      action: "broker.status.update",
      entityType: "broker_member",
      entityId: updated.id,
      before,
      after: updated,
      reason: body.reason,
      correlationId: correlationIdFromRequest(request)
    });
    return updated;
  });

  app.get("/brokers/:code/validate", async (request) => {
    const params = z.object({ code: z.string().transform((value) => value.toUpperCase()) }).parse(request.params);
    const [broker] = await db.select().from(brokerMembers).where(eq(brokerMembers.code, params.code));
    if (!broker) return { valid: false, reason: "broker_not_found" };
    if (broker.status !== "active") return { valid: false, reason: `broker_${broker.status}`, broker };
    return { valid: true, broker };
  });
}
