import "dotenv/config";
import { z } from "zod";

const weakTokenPatterns = [
  "change-me",
  "replace-with",
  "super_secret",
  "mandala_sekuritas_dev_secret",
  "dev-",
  "local-",
];

function splitCsv(value: string | undefined, fallback: string[]) {
  if (!value) return fallback;
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

function isWeakProductionSecret(value: string | undefined) {
  if (!value || value.length < 32) return true;
  const normalized = value.toLowerCase();
  return weakTokenPatterns.some((pattern) => normalized.includes(pattern));
}

function isDefaultDevelopmentDb(value: string) {
  return /localhost:5432\/mandala_sekuritas(\?|$)/.test(value) || /\/mandala_sekuritas(\?|$)/.test(value);
}

const envSchema = z.object({
  APP_ENV: z.enum(["development", "production"]).default("development"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  FINANCE_MODE: z.enum(["simulator", "rdn"]).default("simulator"),
  PORT: z.coerce.number().int().positive().default(3002),
  DATABASE_URL: z.string().url().default("postgresql://postgres:postgres@localhost:5432/mandala_sekuritas"),
  JWT_SECRET: z.string().optional(),
  ADMIN_TOKEN: z.string().optional(),
  BOT_SERVICE_TOKEN: z.string().optional(),
  BROKER_CODE: z.string().default("MANDALA"),
  FRONTEND_ORIGINS: z.string().optional(),
  MATS_API_URL: z.string().url().default("http://localhost:8082"),
  MATS_MARKET_WS_URL: z.string().default("ws://localhost:8082/v1/market-data/ws"),
  MATS_SERVICE_TOKEN: z.string().optional(),
  MATS_TO_SEKURITAS_TOKEN: z.string().optional(),
  BEI_API_URL: z.string().url().default("http://localhost:4100"),
  BEI_SERVICE_TOKEN: z.string().optional(),
  BEI_TO_SEKURITAS_TOKEN: z.string().optional(),
  ALLOW_INSECURE_LOCAL_TOKENS: z.enum(["true", "false"]).default("false"),
  BANK_MANDALA_URL: z.string().url().optional(),
  BANK_MANDALA_API_KEY: z.string().optional(),
  WEBHOOK_SECRET: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  EMAIL_FROM: z.string().default("onboarding@resend.dev"),
});

export function parseSekuritasEnv(input: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(input);

  if (parsed.NODE_ENV === "production" || parsed.APP_ENV === "production") {
    const errors: string[] = [];
    if (parsed.APP_ENV !== "production") errors.push("APP_ENV must be production when NODE_ENV=production");
    if (parsed.NODE_ENV !== "production") errors.push("NODE_ENV must be production when APP_ENV=production");
    if (parsed.FINANCE_MODE !== "rdn") errors.push("FINANCE_MODE=simulator is not allowed in production");
    if (isDefaultDevelopmentDb(parsed.DATABASE_URL)) errors.push("DATABASE_URL must not point to the development Sekuritas database in production");

    const secrets = {
      JWT_SECRET: parsed.JWT_SECRET,
      ADMIN_TOKEN: parsed.ADMIN_TOKEN,
      BOT_SERVICE_TOKEN: parsed.BOT_SERVICE_TOKEN,
      MATS_SERVICE_TOKEN: parsed.MATS_SERVICE_TOKEN,
      MATS_TO_SEKURITAS_TOKEN: parsed.MATS_TO_SEKURITAS_TOKEN,
      BEI_SERVICE_TOKEN: parsed.BEI_SERVICE_TOKEN,
      BEI_TO_SEKURITAS_TOKEN: parsed.BEI_TO_SEKURITAS_TOKEN,
    };
    for (const [name, value] of Object.entries(secrets)) {
      if (isWeakProductionSecret(value)) errors.push(`${name} must be set to a strong production value`);
    }

    if (parsed.ALLOW_INSECURE_LOCAL_TOKENS === "true") {
      errors.push("ALLOW_INSECURE_LOCAL_TOKENS cannot be true in production");
    }

    if (errors.length > 0) {
      throw new Error(`Invalid production environment:\n- ${errors.join("\n- ")}`);
    }
  }

  if (parsed.FINANCE_MODE === "rdn") {
    const rdnErrors: string[] = [];
    if (!parsed.BANK_MANDALA_URL) rdnErrors.push("BANK_MANDALA_URL is required when FINANCE_MODE=rdn");
    if (!parsed.BANK_MANDALA_API_KEY) rdnErrors.push("BANK_MANDALA_API_KEY is required when FINANCE_MODE=rdn");
    if (!parsed.WEBHOOK_SECRET) rdnErrors.push("WEBHOOK_SECRET is required when FINANCE_MODE=rdn");
    if (rdnErrors.length > 0) {
      throw new Error(`Invalid RDN environment configuration:\n- ${rdnErrors.join("\n- ")}`);
    }
  }

  return {
    appEnv: parsed.APP_ENV,
    nodeEnv: parsed.NODE_ENV,
    financeMode: parsed.FINANCE_MODE,
    isProduction: parsed.APP_ENV === "production" || parsed.NODE_ENV === "production",
    isSimulatorFinance: parsed.FINANCE_MODE === "simulator",
    port: parsed.PORT,
    databaseUrl: parsed.DATABASE_URL,
    jwtSecret: parsed.JWT_SECRET,
    adminToken: parsed.ADMIN_TOKEN,
    botServiceToken: parsed.BOT_SERVICE_TOKEN,
    brokerCode: parsed.BROKER_CODE,
    frontendOrigins: splitCsv(parsed.FRONTEND_ORIGINS, [
      "http://localhost:5173",
      "http://localhost:4173",
    ]),
    matsApiUrl: parsed.MATS_API_URL,
    matsMarketWsUrl: parsed.MATS_MARKET_WS_URL,
    matsServiceToken: parsed.MATS_SERVICE_TOKEN || "",
    matsToSekuritasToken: parsed.MATS_TO_SEKURITAS_TOKEN,
    beiApiUrl: parsed.BEI_API_URL,
    beiServiceToken: parsed.BEI_SERVICE_TOKEN || "",
    beiToSekuritasToken: parsed.BEI_TO_SEKURITAS_TOKEN,
    allowInsecureLocalTokens: parsed.ALLOW_INSECURE_LOCAL_TOKENS === "true",
    bankMandalaUrl: parsed.BANK_MANDALA_URL,
    bankMandalaApiKey: parsed.BANK_MANDALA_API_KEY,
    webhookSecret: parsed.WEBHOOK_SECRET,
    resendApiKey: parsed.RESEND_API_KEY,
    emailFrom: parsed.EMAIL_FROM,
  };
}

export type SekuritasEnv = ReturnType<typeof parseSekuritasEnv>;

export const env = parseSekuritasEnv(process.env);
