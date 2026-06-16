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
  "settlement:read",
  "settlement:write",
  "custody:read",
  "corporate-action:read",
  "corporate-action:write",
  "report:read",
  "surveillance:read",
  "surveillance:write"
]);

const serviceTokenSchema = z.object({
  name: z.string().min(2),
  token: z.string().min(24),
  scopes: z.array(authScopeSchema).min(1)
});

const defaultServiceTokens: ServiceIdentity[] = [
  {
    name: "admin",
    token: "dev-admin-service-token-change-me",
    scopes: ["admin:*"]
  },
  {
    name: "mats",
    token: "dev-mats-service-token-change-me",
    scopes: ["market:read", "rules:read", "broker:read", "trade:capture", "market-summary:write"]
  },
  {
    name: "sekuritas",
    token: "dev-sekuritas-service-token-change-me",
    scopes: ["market:read", "rules:read", "broker:read", "settlement:read", "custody:read", "corporate-action:read", "report:read"]
  },
  {
    name: "readonly",
    token: "dev-readonly-service-token-change-me",
    scopes: ["market:read", "rules:read", "broker:read", "corporate-action:read", "report:read"]
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
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(4100),
  HOST: z.string().default("0.0.0.0"),
  DATABASE_URL: z.string().url().default("postgres://mandala_bei:mandala_bei@localhost:5441/mandala_bei"),
  BEI_SERVICE_TOKENS: z.string().optional().transform(parseServiceTokens)
});

export const config = configSchema.parse(process.env);
