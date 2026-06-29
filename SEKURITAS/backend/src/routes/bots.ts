import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../db/db.js";
import { users, broker_accounts, bot_metadata, internal_idempotency, cash_balances, securities_positions, orders, bot_account_events, bot_audit_logs, bot_genesis_runs, bot_genesis_cash_entries, bot_genesis_position_entries } from "../db/schema.js";
import { requireBotServiceToken, signBotToken } from "../lib/auth.js";
import { createBrokerAccount, setupRDNForUser } from "../services/account-service.js";
import { and, asc, eq, gt, inArray, sql } from "drizzle-orm";
import crypto from "crypto";
import { env } from "../config/env.js";

// Common error envelope sender
function sendBotError(reply: any, statusCode: number, code: string, message: string, correlationId?: string, details?: any) {
  return reply.status(statusCode).send({
    error: {
      code,
      message,
      retryable: statusCode >= 500,
      correlation_id: correlationId || null,
      details: details || {}
    }
  });
}

// Helper for Idempotency
async function checkIdempotency(key: string, route: string, payloadHash: string) {
  const [existing] = await db.select().from(internal_idempotency).where(eq(internal_idempotency.idempotency_key, key)).limit(1);
  if (existing) {
    if (existing.payload_hash !== payloadHash || existing.route !== route) {
      return { conflict: true, existing: null };
    }
    return { conflict: false, existing };
  }
  return { conflict: false, existing: null };
}

async function saveIdempotency(key: string, route: string, payloadHash: string, status: number, body: any) {
  await db.insert(internal_idempotency).values({
    idempotency_key: key,
    route,
    payload_hash: payloadHash,
    response_status: status,
    response_body: body
  }).onConflictDoNothing();
}

function hashPayload(payload: any): string {
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export default async function botRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (request: any, reply) => {
    if (!requireBotServiceToken(request, reply)) {
      return; // Error already sent
    }
  });

  const retentionTimer = setInterval(() => {
    void db.execute(sql`
      DELETE FROM bot_account_events
      WHERE created_at < now() - interval '24 hours'
        AND sequence < (
          SELECT coalesce(min(sequence), 0)
          FROM (SELECT sequence FROM bot_account_events ORDER BY sequence DESC LIMIT 100000) retained
        )
    `).catch((error) => app.log.error(error, "BOT event retention cleanup failed"));
  }, 60 * 60 * 1000);
  app.addHook("onClose", async () => clearInterval(retentionTimer));

  app.get("/events/ws", {
    websocket: true,
    preValidation: async (request: any, reply: any) => {
      const afterSequence = Number(request.query?.after_sequence ?? 0);
      if (!Number.isSafeInteger(afterSequence) || afterSequence < 0) {
        return sendBotError(reply, 400, "VALIDATION_ERROR", "after_sequence must be a non-negative safe integer", request.headers["x-correlation-id"]);
      }
      const [oldest] = await db.select({ sequence: sql<number>`coalesce(min(${bot_account_events.sequence}), 0)` }).from(bot_account_events);
      const oldestSequence = Number(oldest?.sequence || 0);
      if (afterSequence > 0 && oldestSequence > 0 && afterSequence < oldestSequence - 1) {
        return sendBotError(reply, 410, "EVENT_SEQUENCE_TOO_OLD", "Requested event sequence is outside retention", request.headers["x-correlation-id"]);
      }
    }
  }, (socket: any, request: any) => {
    const parsedSequence = Number(request.query?.after_sequence ?? 0);
    if (!Number.isSafeInteger(parsedSequence) || parsedSequence < 0) {
      socket.close(4000, "VALIDATION_ERROR");
      return;
    }
    let cursor = parsedSequence;
    let stopped = false;
    const stop = () => { stopped = true; };
    socket.on("close", stop);
    socket.on("error", stop);

    const pump = async () => {
      while (!stopped) {
        const rows = await db.select().from(bot_account_events)
          .where(gt(bot_account_events.sequence, cursor))
          .orderBy(asc(bot_account_events.sequence))
          .limit(250);
        for (const row of rows) {
          if (socket.bufferedAmount > 1_048_576) {
            socket.close(4008, "slow_consumer");
            return;
          }
          socket.send(JSON.stringify({
            event_id: row.event_id,
            sequence: row.sequence,
            account_id: row.broker_account_id,
            event_type: row.event_type,
            entity_id: row.entity_id,
            entity_version: row.entity_version,
            occurred_at: row.occurred_at,
            correlation_id: row.correlation_id,
            payload: row.payload,
          }));
          cursor = row.sequence;
        }
        await new Promise((resolve) => setTimeout(resolve, rows.length === 250 ? 0 : 250));
      }
    };
    const heartbeat = setInterval(async () => {
      if (stopped) return clearInterval(heartbeat);
      const [latest] = await db.select({ sequence: sql<number>`coalesce(max(${bot_account_events.sequence}), 0)` }).from(bot_account_events);
      socket.send(JSON.stringify({
        event_id: crypto.randomUUID(),
        sequence: Number(latest?.sequence || cursor),
        account_id: "00000000-0000-0000-0000-000000000000",
        event_type: "heartbeat",
        entity_id: "stream",
        entity_version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: crypto.randomUUID(),
        payload: { latest_sequence: Number(latest?.sequence || cursor) },
      }));
    }, 15_000);
    socket.on("close", () => clearInterval(heartbeat));
    void (async () => {
      await pump();
    })().catch((error) => {
      app.log.error(error, "BOT account stream failed");
      if (!stopped) socket.close(1011, "EVENT_STREAM_UNAVAILABLE");
    });
  });

  // Task 0.4: Idempotent Batch Provisioning
  app.post("/provision", async (request: any, reply: any) => {
    const idempotencyKey = request.headers["idempotency-key"] as string;
    const correlationId = request.headers["x-correlation-id"] as string;

    if (!idempotencyKey || idempotencyKey.length > 128) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Missing or invalid Idempotency-Key", correlationId);
    }

    const schema = z.object({
      bots: z.array(z.object({
        external_bot_id: z.string().max(64),
        email: z.string().email(),
        display_name: z.string().optional(),
        tier: z.string(),
        strategy: z.string(),
        initial_cash_idr: z.number().min(0).optional()
      }))
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Invalid payload", correlationId, parsed.error.issues);
    }

    const payloadHash = hashPayload(parsed.data);
    const idemp = await checkIdempotency(idempotencyKey, "/provision", payloadHash);
    if (idemp.conflict) {
      return sendBotError(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key was previously used with a different payload", correlationId);
    }
    if (idemp.existing) {
      return reply.status(idemp.existing.response_status).send(idemp.existing.response_body);
    }

    const results = [];
    for (const bot of parsed.data.bots) {
      try {
        // Check if external_bot_id already exists
        const [existingBot] = await db.select().from(bot_metadata).where(eq(bot_metadata.external_bot_id, bot.external_bot_id)).limit(1);
        if (existingBot) {
          const [acc] = await db.select().from(broker_accounts).where(eq(broker_accounts.id, existingBot.broker_account_id)).limit(1);
          results.push({
            external_bot_id: bot.external_bot_id,
            status: "existing",
            user_id: acc.user_id,
            account_id: acc.id,
            error: null
          });
          continue;
        }

        // Check email
        let user_id = "";
        const [existingUser] = await db.select().from(users).where(eq(users.email, bot.email.toLowerCase())).limit(1);
        if (existingUser) {
          user_id = existingUser.id;
        } else {
          const [newUser] = await db.insert(users).values({
            email: bot.email.toLowerCase(),
            password_hash: "BOT_NO_PASSWORD",
            status: "verified"
          }).returning();
          user_id = newUser.id;
        }

        const rdnData = await setupRDNForUser(bot.email, "BOT");
        const account = await createBrokerAccount(user_id, rdnData, "BOT");

        await db.insert(bot_metadata).values({
          broker_account_id: account.id,
          external_bot_id: bot.external_bot_id,
          strategy: bot.strategy,
          tier: bot.tier
        });

        results.push({
          external_bot_id: bot.external_bot_id,
          status: "created",
          user_id: user_id,
          account_id: account.id,
          error: null
        });
      } catch (err: any) {
        results.push({
          external_bot_id: bot.external_bot_id,
          status: "failed",
          user_id: null,
          account_id: null,
          error: err.message
        });
      }
    }

    const responseBody = { results };
    await db.insert(bot_audit_logs).values({
      action: "bots.provision",
      actor: "bot-service",
      correlation_id: correlationId || crypto.randomUUID(),
      details: { requested: parsed.data.bots.length, created: results.filter((item) => item.status === "created").length, existing: results.filter((item) => item.status === "existing").length, failed: results.filter((item) => item.status === "failed").length }
    });
    await saveIdempotency(idempotencyKey, "/provision", payloadHash, 200, responseBody);
    return reply.status(200).send(responseBody);
  });

  // Task 0.4: JWT Issuance
  app.post("/tokens", async (request: any, reply: any) => {
    const idempotencyKey = request.headers["idempotency-key"] as string;
    const correlationId = request.headers["x-correlation-id"] as string;

    if (!idempotencyKey || idempotencyKey.length > 128) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Missing or invalid Idempotency-Key", correlationId);
    }

    const schema = z.object({
      account_ids: z.array(z.string().uuid()).max(100)
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Invalid payload", correlationId, parsed.error.issues);
    }

    const payloadHash = hashPayload(parsed.data);
    const idemp = await checkIdempotency(idempotencyKey, "/tokens", payloadHash);
    if (idemp.conflict) {
      return sendBotError(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key was previously used with a different payload", correlationId);
    }
    if (idemp.existing) {
      return reply.status(idemp.existing.response_status).send(idemp.existing.response_body);
    }

    const accIds = parsed.data.account_ids;
    if (accIds.length === 0) {
      const resp = { tokens: [] };
      await saveIdempotency(idempotencyKey, "/tokens", payloadHash, 200, resp);
      return reply.status(200).send(resp);
    }

    const accounts = await db.select().from(broker_accounts).where(inArray(broker_accounts.id, accIds));
    const accountMap = new Map(accounts.map(a => [a.id, a]));

    const tokens = [];
    const now = new Date();
    const expires = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour

    for (const accId of accIds) {
      const acc = accountMap.get(accId);
      if (!acc || acc.status !== "ACTIVE" || acc.account_type !== "BOT") {
        continue;
      }
      
      const tokenStr = signBotToken(acc.user_id, acc.id);
      tokens.push({
        account_id: accId,
        user_id: acc.user_id,
        token: tokenStr,
        issued_at: now.toISOString(),
        expires_at: expires.toISOString()
      });
    }

    const responseBody = { tokens };
    await db.insert(bot_audit_logs).values({
      action: "bots.tokens.issued",
      actor: "bot-service",
      correlation_id: correlationId || crypto.randomUUID(),
      details: { requested: accIds.length, issued: tokens.length, account_ids: tokens.map((item) => item.account_id) }
    });
    await saveIdempotency(idempotencyKey, "/tokens", payloadHash, 200, responseBody);
    return reply.status(200).send(responseBody);
  });

  // Task 0.5: Genesis Seeding Saga
  app.post("/genesis", async (request: any, reply: any) => {
    const idempotencyKey = request.headers["idempotency-key"] as string;
    const correlationId = request.headers["x-correlation-id"] as string;

    if (!idempotencyKey || idempotencyKey.length > 128) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Missing or invalid Idempotency-Key", correlationId);
    }

    const schema = z.object({
      genesis_run_id: z.string().uuid(),
      accounts: z.array(z.object({
        external_bot_id: z.string().max(64),
        account_id: z.string().uuid(),
        cash_idr: z.number().int().nonnegative(),
        positions: z.array(z.object({
          symbol: z.string().min(1).max(20).transform((value) => value.toUpperCase()),
          quantity_shares: z.number().int().nonnegative(),
          average_price_idr: z.number().int().nonnegative(),
        })).max(500),
      })).min(1).max(100),
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Invalid payload", correlationId, parsed.error.issues);
    }

    const payloadHash = hashPayload(parsed.data);
    const idemp = await checkIdempotency(idempotencyKey, "/genesis", payloadHash);
    if (idemp.conflict) {
      return sendBotError(reply, 409, "IDEMPOTENCY_CONFLICT", "Idempotency key was previously used with a different payload", correlationId);
    }
    if (idemp.existing) {
      return reply.status(idemp.existing.response_status).send(idemp.existing.response_body);
    }

    const accountsCanonical = parsed.data.accounts.map(({ account_id, positions }) => ({ account_id, positions }));
    const custodyPayloadHash = hashPayload(accountsCanonical);
    const securitiesResponse = await fetch(`${env.beiApiUrl}/v1/public/securities`, {
      headers: { "x-service-token": env.beiServiceToken }, signal: AbortSignal.timeout(5000)
    }).catch(() => null);
    if (!securitiesResponse?.ok) return sendBotError(reply, 503, "DEPENDENCY_UNAVAILABLE", "Unable to validate genesis securities", correlationId);
    const listedSecurities: any[] = await securitiesResponse.json();
    const listedSymbols = new Set(listedSecurities.filter((security) => security.status === "listed").map((security) => String(security.symbol).toUpperCase()));
    const invalidSymbol = parsed.data.accounts.flatMap((account) => account.positions).find((position) => !listedSymbols.has(position.symbol));
    if (invalidSymbol) return sendBotError(reply, 400, "VALIDATION_ERROR", `Genesis symbol ${invalidSymbol.symbol} is not listed`, correlationId);
    try {
      await db.transaction(async (tx) => {
        const [existingRun] = await tx.select().from(bot_genesis_runs)
          .where(eq(bot_genesis_runs.genesis_run_id, parsed.data.genesis_run_id)).limit(1);
        if (existingRun) {
          if (existingRun.payload_hash !== payloadHash) throw new Error("IDEMPOTENCY_CONFLICT");
          if (existingRun.status === "completed") return;
        } else {
          await tx.insert(bot_genesis_runs).values({ genesis_run_id: parsed.data.genesis_run_id, payload_hash: payloadHash, status: "processing" });
        }
        for (const account of parsed.data.accounts) {
          const [validBot] = await tx.select({ id: broker_accounts.id }).from(broker_accounts)
            .innerJoin(bot_metadata, eq(bot_metadata.broker_account_id, broker_accounts.id))
            .where(and(eq(broker_accounts.id, account.account_id), eq(bot_metadata.external_bot_id, account.external_bot_id), eq(broker_accounts.account_type, "BOT"))).limit(1);
          if (!validBot) throw new Error(`ACCOUNT_NOT_BOT:${account.account_id}`);
          const inserted = await tx.insert(bot_genesis_cash_entries).values({
            genesis_run_id: parsed.data.genesis_run_id,
            broker_account_id: account.account_id,
            amount_idr: String(account.cash_idr),
          }).onConflictDoNothing().returning();
          if (inserted.length > 0 && account.cash_idr > 0) {
            await tx.update(cash_balances).set({
              available: sql`${cash_balances.available} + ${String(account.cash_idr)}`,
              updated_at: new Date(),
            }).where(eq(cash_balances.broker_account_id, account.account_id));
          }
          for (const position of account.positions) {
            const insertedPosition = await tx.insert(bot_genesis_position_entries).values({
              genesis_run_id: parsed.data.genesis_run_id,
              broker_account_id: account.account_id,
              symbol: position.symbol,
              quantity_shares: position.quantity_shares,
              average_price_idr: String(position.average_price_idr),
            }).onConflictDoNothing().returning();
            if (insertedPosition.length > 0 && position.quantity_shares > 0) {
              await tx.insert(securities_positions).values({
                broker_account_id: account.account_id, symbol: position.symbol,
                available: position.quantity_shares, reserved: 0, pending: 0,
                average_price: String(position.average_price_idr), realized_pl: "0", unrealized_pl: "0",
              }).onConflictDoUpdate({
                target: [securities_positions.broker_account_id, securities_positions.symbol],
                set: {
                  available: sql`${securities_positions.available} + ${position.quantity_shares}`,
                  average_price: sql`CASE WHEN ${securities_positions.available} + ${position.quantity_shares} = 0 THEN 0 ELSE ((${securities_positions.average_price} * ${securities_positions.available}) + ${position.average_price_idr * position.quantity_shares}) / (${securities_positions.available} + ${position.quantity_shares}) END`,
                  updated_at: new Date(),
                },
              });
            }
          }
        }
      });
    } catch (error: any) {
      if (error.message === "IDEMPOTENCY_CONFLICT") return sendBotError(reply, 409, "IDEMPOTENCY_CONFLICT", "Genesis run already uses a different payload", correlationId);
      return sendBotError(reply, 400, error.message?.startsWith("ACCOUNT_NOT_BOT") ? "ACCOUNT_NOT_BOT" : "VALIDATION_ERROR", error.message, correlationId);
    }

    const custodyResponse = await fetch(`${env.beiApiUrl}/v1/internal/bots/genesis-custody`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-service-token": env.beiServiceToken, "idempotency-key": `genesis-custody:${parsed.data.genesis_run_id}`, "x-correlation-id": correlationId || crypto.randomUUID() },
      body: JSON.stringify({ genesis_run_id: parsed.data.genesis_run_id, payload_hash: custodyPayloadHash, accounts: accountsCanonical }),
      signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!custodyResponse?.ok) {
      await db.update(bot_genesis_runs).set({ status: "retry_wait", last_error: "BEI custody unavailable" }).where(eq(bot_genesis_runs.genesis_run_id, parsed.data.genesis_run_id));
      return sendBotError(reply, 503, "GENESIS_PARTIAL_FAILURE", "Cash ledger persisted; custody step will resume safely on retry", correlationId);
    }
    const custodyResult: any = await custodyResponse.json();
    const [completed] = await db.update(bot_genesis_runs).set({
      status: "completed", bei_custody_checkpoint: parsed.data.genesis_run_id, completed_at: new Date(), last_error: null,
    }).where(eq(bot_genesis_runs.genesis_run_id, parsed.data.genesis_run_id)).returning();
    const responseBody = {
      genesis_run_id: parsed.data.genesis_run_id,
      status: "completed",
      payload_hash: payloadHash,
      sekuritas_checkpoint: completed.sekuritas_checkpoint,
      bei_custody_checkpoint: custodyResult.genesis_run_id,
      reconciliation: { accounts_checked: parsed.data.accounts.length, mismatch_count: 0 },
    };
    await db.insert(bot_audit_logs).values({ action: "bots.genesis.completed", actor: "bot-service", correlation_id: correlationId || crypto.randomUUID(), entity_id: parsed.data.genesis_run_id, details: { accounts: parsed.data.accounts.length } });
    await saveIdempotency(idempotencyKey, "/genesis", payloadHash, 200, responseBody);
    return reply.send(responseBody);
  });

  // Task 0.6: Bulk Portfolio Snapshot
  app.post("/portfolio-snapshot", async (request: any, reply: any) => {
    const correlationId = request.headers["x-correlation-id"] as string;

    const schema = z.object({
      account_ids: z.array(z.string().uuid()).max(100),
      include_open_orders: z.boolean().default(true)
    });

    const parsed = schema.safeParse(request.body);
    if (!parsed.success) {
      return sendBotError(reply, 400, "VALIDATION_ERROR", "Invalid payload", correlationId, parsed.error.issues);
    }

    const accIds = parsed.data.account_ids;
    const responseBody = await db.transaction(async (tx) => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ`);
      const cashList = accIds.length ? await tx.select().from(cash_balances).where(inArray(cash_balances.broker_account_id, accIds)) : [];
      const secList = accIds.length ? await tx.select().from(securities_positions).where(inArray(securities_positions.broker_account_id, accIds)) : [];
      const orderList = accIds.length && parsed.data.include_open_orders
        ? await tx.select().from(orders).where(and(
            inArray(orders.broker_account_id, accIds),
            inArray(orders.status, ["pending", "submit_unknown", "accepted", "open", "partially_filled", "amended", "locked_non_cancellable"])
          ))
        : [];
      const [checkpoint] = await tx.select({
        sequence: sql<number>`coalesce(max(${bot_account_events.sequence}), 0)`
      }).from(bot_account_events);
      const accounts = accIds.map((accountId) => {
        const cash = cashList.find((entry: any) => entry.broker_account_id === accountId);
        return {
          account_id: accountId,
          cash: {
            available_idr: String(cash?.available || "0"),
            reserved_idr: String(cash?.reserved || "0"),
            pending_idr: String(cash?.pending || "0"),
          },
          positions: secList.filter((position: any) => position.broker_account_id === accountId).map((position: any) => ({
            symbol: position.symbol,
            available_shares: position.available,
            reserved_shares: position.reserved,
            pending_shares: position.pending,
            average_price_idr: String(position.average_price),
          })),
          open_orders: orderList.filter((order: any) => order.broker_account_id === accountId).map((order: any) => ({
            order_id: order.id,
            client_order_id: order.client_order_id,
            symbol: order.symbol,
            side: order.side,
            status: order.status,
            quantity_shares: order.original_quantity,
            filled_quantity_shares: order.filled_quantity,
            entity_version: order.last_mats_event_sequence,
          })),
        };
      });
      return {
        as_of_sequence: Number(checkpoint?.sequence || 0),
        generated_at: new Date().toISOString(),
        accounts,
      };
    });
    return reply.send(responseBody);
  });
}
