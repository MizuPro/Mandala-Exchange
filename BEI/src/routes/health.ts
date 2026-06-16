import type { FastifyInstance } from "fastify";
import { pool } from "../db/index.js";

export async function registerHealthRoutes(app: FastifyInstance) {
  app.get("/health", async () => {
    const dbResult = await pool.query("SELECT 1 AS ok");
    return {
      status: "ok",
      service: "bei",
      database: dbResult.rows[0]?.ok === 1 ? "ok" : "unknown",
      timestamp: new Date().toISOString()
    };
  });
}
