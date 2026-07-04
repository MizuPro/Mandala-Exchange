import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { authenticateActiveUser } from "../lib/auth.js";
import {
  cancelIpoSubscription,
  getIpoSubscription,
  IpoSubscriptionError,
  listIpoSubscriptions,
  subscribeIpo
} from "../services/ipo-subscription-service.js";

function identity(request: any) {
  return { accountId: request.account_id, userId: request.user_id };
}

function sendError(reply: any, error: unknown, correlationId?: string) {
  const known = error instanceof IpoSubscriptionError
    ? error
    : new IpoSubscriptionError(500, "INTERNAL_ERROR", error instanceof Error ? error.message : "IPO subscription failed", true);
  return reply.status(known.statusCode).send({
    error: {
      code: known.code,
      message: known.message,
      retryable: known.retryable,
      correlation_id: correlationId || null,
      details: known.details
    }
  });
}

export default async function ipoSubscriptionRoutes(app: FastifyInstance) {
  app.addHook("preHandler", authenticateActiveUser);

  app.post("/:id/subscriptions", async (request: any, reply) => {
    const correlationId = request.headers["x-correlation-id"] as string;
    const idempotencyKey = request.headers["idempotency-key"] as string;
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ requested_shares: z.coerce.number().int().positive().safe() }).safeParse(request.body);
    if (!idempotencyKey || idempotencyKey.length > 128 || !params.success || !body.success) {
      return sendError(reply, new IpoSubscriptionError(400, "VALIDATION_ERROR", "Invalid IPO subscription request"), correlationId);
    }
    try {
      const result = await subscribeIpo({
        identity: identity(request),
        ipoEventId: params.data.id,
        requestedShares: body.data.requested_shares,
        idempotencyKey
      });
      return reply.status(result.status === "cash_reserved" ? 202 : 201).send(result);
    } catch (error) {
      return sendError(reply, error, correlationId);
    }
  });

  app.get("/subscriptions", async (request: any, reply) => {
    try {
      return reply.send({ items: await listIpoSubscriptions(identity(request)) });
    } catch (error) {
      return sendError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.get("/:id/subscriptions", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, new IpoSubscriptionError(400, "VALIDATION_ERROR", "Invalid IPO event ID"));
    try {
      return reply.send({ items: await listIpoSubscriptions(identity(request), params.data.id) });
    } catch (error) {
      return sendError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.get("/:id/subscriptions/:subscriptionId", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, new IpoSubscriptionError(400, "VALIDATION_ERROR", "Invalid subscription ID"));
    try {
      const result = await getIpoSubscription(identity(request), params.data.subscriptionId);
      if (result.ipo_event_id !== params.data.id) throw new IpoSubscriptionError(404, "NOT_FOUND", "Subscription not found");
      return reply.send(result);
    } catch (error) {
      return sendError(reply, error, request.headers["x-correlation-id"]);
    }
  });

  app.post("/:id/subscriptions/:subscriptionId/cancel", async (request: any, reply) => {
    const params = z.object({ id: z.string().uuid(), subscriptionId: z.string().uuid() }).safeParse(request.params);
    if (!params.success) return sendError(reply, new IpoSubscriptionError(400, "VALIDATION_ERROR", "Invalid subscription ID"));
    try {
      return reply.send(await cancelIpoSubscription({
        identity: identity(request),
        ipoEventId: params.data.id,
        subscriptionId: params.data.subscriptionId
      }));
    } catch (error) {
      return sendError(reply, error, request.headers["x-correlation-id"]);
    }
  });
}
