import type { FastifyInstance } from "fastify";
import crypto from "node:crypto";
import { z } from "zod";
import { pool } from "../db/index.js";

const requestSchema = z.object({
  genesis_run_id: z.string().uuid(),
  payload_hash: z.string().length(64),
  accounts: z.array(z.object({
    account_id: z.string().uuid(),
    positions: z.array(z.object({
      symbol: z.string().min(1).max(20).transform((value) => value.toUpperCase()),
      quantity_shares: z.number().int().nonnegative(),
      average_price_idr: z.number().int().nonnegative(),
    })).max(500),
  })).max(100),
});

export async function registerBotGenesisRoutes(app: FastifyInstance) {
  app.post("/internal/bots/genesis-custody", async (request, reply) => {
    const parsed = requestSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: { code: "VALIDATION_ERROR", message: "Invalid genesis custody payload", retryable: false, details: parsed.error.issues } });
    }
    const body = parsed.data;
    const canonicalHash = crypto.createHash("sha256").update(JSON.stringify(body.accounts)).digest("hex");
    if (canonicalHash !== body.payload_hash) {
      return reply.status(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Payload hash mismatch", retryable: false, details: {} } });
    }
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const existing = await client.query("SELECT payload_hash, status, result FROM bot_genesis_custody_runs WHERE genesis_run_id=$1 FOR UPDATE", [body.genesis_run_id]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== body.payload_hash) {
          await client.query("ROLLBACK");
          return reply.status(409).send({ error: { code: "IDEMPOTENCY_CONFLICT", message: "Genesis run already uses a different payload", retryable: false, details: {} } });
        }
        await client.query("COMMIT");
        return existing.rows[0].result;
      }
      await client.query("INSERT INTO bot_genesis_custody_runs(genesis_run_id,payload_hash,status) VALUES($1,$2,'processing')", [body.genesis_run_id, body.payload_hash]);
      const broker = await client.query("SELECT id, code FROM broker_members WHERE code='MANDALA' AND status='active' LIMIT 1");
      if (!broker.rows[0]) throw new Error("MANDALA broker is not active");
      let entries = 0;
      for (const account of body.accounts) {
        const custody = await client.query(`
          INSERT INTO custody_accounts(broker_id,investor_id,sid,sre,rdn,status)
          VALUES($1,$2,$3,$4,$5,'active')
          ON CONFLICT(broker_id,investor_id) DO UPDATE SET updated_at=now()
          RETURNING id
        `, [broker.rows[0].id, account.account_id, `BOTSID-${account.account_id}`, `BOTSRE-${account.account_id}`, `BOTRDN-${account.account_id}`]);
        for (const position of account.positions) {
          if (position.quantity_shares === 0) continue;
          const security = await client.query("SELECT id FROM listed_securities WHERE symbol=$1 AND status='listed' LIMIT 1", [position.symbol]);
          if (!security.rows[0]) throw new Error(`Listed security ${position.symbol} not found`);
          await client.query(`
            INSERT INTO custody_ledger_entries(custody_account_id,security_id,entry_type,asset_type,quantity,cash_amount,position_state,reference_type,reference_id,idempotency_key,metadata)
            VALUES($1,$2,'ipo_allocation','security',$3,0,'settled','bot_genesis',$4,$5,$6)
            ON CONFLICT(idempotency_key) DO NOTHING
          `, [custody.rows[0].id, security.rows[0].id, position.quantity_shares, body.genesis_run_id, `genesis:${body.genesis_run_id}:${account.account_id}:${position.symbol}`, JSON.stringify({ average_price_idr: position.average_price_idr })]);
          entries++;
        }
      }
      const result = { genesis_run_id: body.genesis_run_id, status: "completed", custody_entries: entries };
      await client.query("UPDATE bot_genesis_custody_runs SET status='completed',result=$2,completed_at=now() WHERE genesis_run_id=$1", [body.genesis_run_id, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      request.log.error(error, "BOT genesis custody failed");
      return reply.status(503).send({ error: { code: "GENESIS_PARTIAL_FAILURE", message: "Custody genesis failed", retryable: true, details: {} } });
    } finally {
      client.release();
    }
  });
}
