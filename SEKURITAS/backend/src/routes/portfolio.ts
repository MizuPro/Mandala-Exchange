import { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../db/db.js";
import {
  securities_positions,
  broker_accounts,
  cash_balances,
  sid_references,
  sre_references,
  rdn_references,
  trade_fills,
  orders,
} from "../db/schema.js";
import { desc, eq } from "drizzle-orm";
import { authenticateActiveUser } from "../lib/auth.js";
import { beiClient } from "../services/bei-client.js";

const BROKER_CODE = process.env.BROKER_CODE || "MANDALA";

async function getBrokerAccount(userId: string) {
  const [brokerAcc] = await db.select().from(broker_accounts).where(eq(broker_accounts.user_id, userId)).limit(1);
  return brokerAcc;
}

export default async function portfolioRoutes(app: FastifyInstance) {
  app.addHook("onRequest", authenticateActiveUser);

  app.get("/summary", async (request: any, reply: FastifyReply) => {
    const user_id = request.user_id;
    
    const brokerAcc = await getBrokerAccount(user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
    const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, brokerAcc.id));
    
    return {
      cash: cash ? { available: cash.available, reserved: cash.reserved, pending: cash.pending } : { available: "0", reserved: "0", pending: "0" },
      positions: positions.map(p => ({
        symbol: p.symbol,
        available: p.available,
        reserved: p.reserved,
        pending: p.pending,
        average_price: p.average_price,
        realized_pl: p.realized_pl
      }))
    };
  });

  app.get("/account", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const [sid] = await db.select().from(sid_references).where(eq(sid_references.broker_account_id, brokerAcc.id)).limit(1);
    const [sre] = await db.select().from(sre_references).where(eq(sre_references.broker_account_id, brokerAcc.id)).limit(1);
    const [rdn] = await db.select().from(rdn_references).where(eq(rdn_references.broker_account_id, brokerAcc.id)).limit(1);

    return {
      account: {
        id: brokerAcc.id,
        account_type: brokerAcc.account_type,
        status: brokerAcc.status,
        created_at: brokerAcc.created_at,
      },
      references: {
        sid: sid?.sid || null,
        sre: sre?.sre || null,
        rdn: rdn?.rdn || null,
      },
    };
  });

  app.get("/detail", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const [cash] = await db.select().from(cash_balances).where(eq(cash_balances.broker_account_id, brokerAcc.id)).limit(1);
    const positions = await db.select().from(securities_positions).where(eq(securities_positions.broker_account_id, brokerAcc.id));
    const [sid] = await db.select().from(sid_references).where(eq(sid_references.broker_account_id, brokerAcc.id)).limit(1);
    const [sre] = await db.select().from(sre_references).where(eq(sre_references.broker_account_id, brokerAcc.id)).limit(1);
    const [rdn] = await db.select().from(rdn_references).where(eq(rdn_references.broker_account_id, brokerAcc.id)).limit(1);

    return {
      summary: {
        cash: cash ? { available: cash.available, reserved: cash.reserved, pending: cash.pending } : { available: "0", reserved: "0", pending: "0" },
        positions,
      },
      account: {
        account: {
          id: brokerAcc.id,
          account_type: brokerAcc.account_type,
          status: brokerAcc.status,
          created_at: brokerAcc.created_at,
        },
        references: {
          sid: sid?.sid || null,
          sre: sre?.sre || null,
          rdn: rdn?.rdn || null,
        },
      },
    };
  });

  app.get("/fills", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const rows = await db
      .select({
        id: trade_fills.id,
        trade_id: trade_fills.trade_id,
        price: trade_fills.price,
        quantity: trade_fills.quantity,
        timestamp: trade_fills.timestamp,
        order_id: orders.id,
        client_order_id: orders.client_order_id,
        mats_order_id: orders.mats_order_id,
        symbol: orders.symbol,
        side: orders.side,
        order_type: orders.order_type,
      })
      .from(trade_fills)
      .innerJoin(orders, eq(trade_fills.order_id, orders.id))
      .where(eq(orders.broker_account_id, brokerAcc.id))
      .orderBy(desc(trade_fills.timestamp))
      .limit(100);
    return rows;
  });

  app.get("/trades", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });

    const userOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.broker_account_id, brokerAcc.id))
      .orderBy(desc(orders.created_at))
      .limit(100);
    return userOrders;
  });

  app.get("/settlement/:sessionId", async (request: any, reply: FastifyReply) => {
    try {
      const data = await beiClient.getSettlementSession(request.params.sessionId);
      return reply.send(data);
    } catch (error: any) {
      return reply.status(502).send({ error: error.message || "Failed to fetch settlement status from BEI" });
    }
  });

  app.get("/custody/summary", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });
    try {
      const data = await beiClient.getCustodySummary(BROKER_CODE, brokerAcc.id);
      return reply.send(data);
    } catch (error: any) {
      return reply.status(502).send({ error: error.message || "Failed to fetch custody summary from BEI" });
    }
  });

  app.get("/custody/reconciliation", async (request: any, reply: FastifyReply) => {
    const brokerAcc = await getBrokerAccount(request.user_id);
    if (!brokerAcc) return reply.status(404).send({ error: "Broker account not found" });
    try {
      const data = await beiClient.getReconciliation(BROKER_CODE, brokerAcc.id);
      return reply.send(data);
    } catch (error: any) {
      return reply.status(502).send({ error: error.message || "Failed to fetch reconciliation from BEI" });
    }
  });
}
