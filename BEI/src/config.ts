import "dotenv/config";
import { z } from "zod";
import type { ServiceIdentity } from "./types/auth.js";

const authScopeSchema = z.enum([
  "admin:*",
  "market:read",
  "market-summary:write",
  "rules:read",
  "broker:read",
  "trade:capture",
  "trade:read",
  "session:write",
  "settlement:read",
  "settlement:write",
  "custody:read",
  "custody:write",
  "corporate-action:read",
  "corporate-action:write",
  "ipo:read",
  "ipo:write",
  "report:read",
  "surveillance:read",
  "surveillance:write",
  // BOT-specific scopes
  "bot:provision",
  "bot:genesis",
  "bot:snapshot",
  "bot:events"
]);

const serviceTokenSchema = z.object({
  name: z.string().min(2),
  token: z.string().min(24),
  scopes: z.array(authScopeSchema).min(1)
});

const defaultServiceTokens: ServiceIdentity[] = [
  {
    name: "admin",
    token: "dev-admin-service-token-change-me-2026",
    scopes: ["admin:*"]
  },
  {
    name: "mats",
    token: "dev-mats-to-bei-token-change-me-2026",
    scopes: ["market:read", "rules:read", "broker:read", "trade:capture", "market-summary:write", "session:write"]
  },
  {
    name: "sekuritas",
    token: "dev-sekuritas-to-bei-token-change-me-2026",
    scopes: ["market:read", "rules:read", "broker:read", "settlement:read", "custody:read", "custody:write", "corporate-action:read", "ipo:read", "ipo:write", "report:read"]
  },
  {
    name: "readonly",
    token: "dev-readonly-service-token-change-me-2026",
    scopes: ["market:read", "rules:read", "broker:read", "corporate-action:read", "report:read"]
  },
  {
    // BOT Service: least privilege — hanya market:read, rules:read, dan corporate-action:read dari BEI.
    // Sekuritas menjadi coordinator untuk provisioning, genesis, snapshot, dan event stream.
    name: "bot",
    token: "dev-bot-service-token-change-me-2026",
    scopes: ["market:read", "rules:read", "corporate-action:read", "ipo:read"]
  }
];

function parseServiceTokens(value: string | undefined) {
  if (!value || value.trim() === "") return defaultServiceTokens;

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error("BEI_SERVICE_TOKENS must be a valid JSON array");
  }

  return z.array(serviceTokenSchema).min(1).parse(parsed);
}

const configSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url().default("postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei"),
  BEI_SERVICE_TOKENS: z.string().optional().transform(parseServiceTokens),
  SEKURITAS_SETTLEMENT_WEBHOOK_URL: z.string().url().optional(),
  SEKURITAS_CORPORATE_ACTION_WEBHOOK_URL: z.string().url().optional(),
  BEI_TO_SEKURITAS_TOKEN: z.string().optional(),
  REDIS_URL: z.string().url().default("redis://localhost:6379")
});

export const config = configSchema.parse(process.env);

const weakTokenPattern = /(change-me|replace-with|^dev-|^local-)/i;
if (config.NODE_ENV === "production" || config.APP_ENV === "production") {
  const errors: string[] = [];
  if (config.NODE_ENV !== "production") errors.push("NODE_ENV must be production when APP_ENV=production");
  if (config.APP_ENV !== "production") errors.push("APP_ENV must be production when NODE_ENV=production");
  if (/localhost:5441\/mandala_bei(\?|$)/.test(config.DATABASE_URL) || /\/mandala_bei(\?|$)/.test(config.DATABASE_URL)) {
    errors.push("DATABASE_URL must not point to the development BEI database in production");
  }
  for (const service of config.BEI_SERVICE_TOKENS) {
    if (service.token.length < 32 || weakTokenPattern.test(service.token)) {
      errors.push(`BEI_SERVICE_TOKENS.${service.name} must use a strong production token`);
    }
  }
  if (!config.BEI_TO_SEKURITAS_TOKEN || config.BEI_TO_SEKURITAS_TOKEN.length < 32 || weakTokenPattern.test(config.BEI_TO_SEKURITAS_TOKEN)) {
    errors.push("BEI_TO_SEKURITAS_TOKEN must use a strong production token");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid BEI production environment:\n- ${errors.join("\n- ")}`);
  }
}

if (!config.SEKURITAS_SETTLEMENT_WEBHOOK_URL) {
  if (config.NODE_ENV === "production") {
    throw new Error("SEKURITAS_SETTLEMENT_WEBHOOK_URL is required in production");
  }
  console.warn("[Config] SEKURITAS_SETTLEMENT_WEBHOOK_URL is not set — settlement notifications will fail");
}
