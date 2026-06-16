import type { FastifyRequest } from "fastify";
import { db } from "../db/index.js";
import { auditLogs } from "../db/schema.js";
import type { AuthenticatedRequest } from "../types/auth.js";

export type AuditInput = {
  actor?: string;
  action: string;
  entityType: string;
  entityId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
  correlationId?: string;
};

export async function writeAudit(input: AuditInput) {
  await db.insert(auditLogs).values({
    actor: input.actor ?? "system",
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    before: input.before,
    after: input.after,
    reason: input.reason,
    correlationId: input.correlationId
  });
}

export function actorFromRequest(request: FastifyRequest) {
  const actor = request.headers["x-actor-id"];
  if (Array.isArray(actor)) return actor[0];
  if (actor) return actor;
  return (request as AuthenticatedRequest).serviceIdentity?.name ?? "service";
}

export function correlationIdFromRequest(request: FastifyRequest) {
  const correlationId = request.headers["x-correlation-id"];
  return Array.isArray(correlationId) ? correlationId[0] : correlationId;
}
