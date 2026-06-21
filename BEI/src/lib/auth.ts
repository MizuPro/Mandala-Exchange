import type { FastifyInstance } from "fastify";
import { config } from "../config.js";
import type { AuthScope, AuthenticatedRequest, RoutePermission, ServiceIdentity } from "../types/auth.js";

const publicRoutes = new Set(["GET /health", "GET /admin"]);

const routePermissions: RoutePermission[] = [
  { method: "GET", path: "/v1/public/securities", scopes: ["market:read"] },
  { method: "GET", path: "/v1/public/securities/:symbol", scopes: ["market:read"] },
  { method: "GET", path: "/v1/public/securities/:symbol/fundamentals", scopes: ["market:read"] },
  { method: "GET", path: "/v1/public/securities/:symbol/candles", scopes: ["market:read"] },
  { method: "GET", path: "/v1/issuers/:issuerId/announcements", scopes: ["market:read"] },
  { method: "GET", path: "/v1/announcements", scopes: ["market:read"] },
  { method: "GET", path: "/v1/indices", scopes: ["market:read"] },
  { method: "GET", path: "/v1/indices/:code/history", scopes: ["market:read"] },
  { method: "GET", path: "/v1/public/fee-schedule", scopes: ["rules:read"] },
  { method: "GET", path: "/v1/integration/mats/securities", scopes: ["market:read"] },
  { method: "GET", path: "/v1/integration/mats/rules", scopes: ["rules:read"] },
  { method: "GET", path: "/v1/integration/mats/sessions/active", scopes: ["rules:read"] },
  { method: "POST", path: "/v1/integration/mats/sessions/active/status", scopes: ["session:write"] },
  { method: "GET", path: "/v1/brokers/:code/validate", scopes: ["broker:read"] },
  { method: "POST", path: "/v1/trades/capture", scopes: ["trade:capture"] },
  { method: "POST", path: "/v1/market-summaries", scopes: ["market-summary:write"] },

  { method: "GET", path: "/v1/rules/profiles", scopes: ["rules:read"] },
  { method: "GET", path: "/v1/brokers", scopes: ["broker:read"] },
  { method: "GET", path: "/v1/trades/session/:sessionId", scopes: ["trade:read", "report:read"] },
  { method: "GET", path: "/v1/trades/:id", scopes: ["trade:read", "report:read"] },
  { method: "GET", path: "/v1/settlement/session/:sessionId", scopes: ["settlement:read"] },
  { method: "GET", path: "/v1/custody/accounts/:brokerCode/:investorId/summary", scopes: ["custody:read"] },
  { method: "GET", path: "/v1/reconciliation/:brokerCode/:investorId", scopes: ["custody:read"] },
  { method: "GET", path: "/v1/corporate-actions", scopes: ["corporate-action:read"] },
  { method: "GET", path: "/v1/ipo-events", scopes: ["corporate-action:read"] },
  { method: "GET", path: "/v1/surveillance/alerts", scopes: ["surveillance:read"] },

  { method: "GET", path: "/v1/reports/trades/:sessionId", scopes: ["report:read"] },
  { method: "GET", path: "/v1/reports/settlements/:sessionId", scopes: ["report:read"] },
  { method: "GET", path: "/v1/reports/custody-movements", scopes: ["report:read", "custody:read"] },
  { method: "GET", path: "/v1/reports/fee-tax/:sessionId", scopes: ["report:read"] },
  { method: "GET", path: "/v1/reports/market-summary/:sessionId", scopes: ["report:read", "market:read"] },
  { method: "GET", path: "/v1/reports/corporate-actions", scopes: ["report:read", "corporate-action:read"] },

  { method: "POST", path: "/v1/settlement/batches", scopes: ["settlement:write"] },
  { method: "POST", path: "/v1/settlement/batches/:id/process", scopes: ["settlement:write"] },
  { method: "POST", path: "/v1/corporate-actions/:id/process", scopes: ["corporate-action:write"] },
  { method: "POST", path: "/v1/surveillance/scan/:sessionId", scopes: ["surveillance:write"] }
];

export function findIdentity(token: string | undefined): ServiceIdentity | undefined {
  if (!token) return undefined;
  return config.BEI_SERVICE_TOKENS.find((identity) => identity.token === token);
}

function getRouteKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

export function requiredScopes(method: string, path: string): AuthScope[] {
  const route = routePermissions.find((permission) => permission.method === method && permission.path === path);
  return route?.scopes ?? ["admin:*"];
}

export function hasScope(identity: ServiceIdentity, required: AuthScope[]) {
  if (identity.scopes.includes("admin:*")) return true;
  return required.some((scope) => identity.scopes.includes(scope));
}

export function serviceCanAccess(identity: ServiceIdentity, method: string, path: string) {
  return hasScope(identity, requiredScopes(method, path));
}

export async function registerAuth(app: FastifyInstance) {
  app.addHook("preHandler", async (request, reply) => {
    const routePath = request.routeOptions.url ?? request.url;
    const routeKey = getRouteKey(request.method, routePath);
    if (publicRoutes.has(routeKey)) return;

    const token = request.headers["x-service-token"];
    const value = Array.isArray(token) ? token[0] : token;
    const identity = findIdentity(value);

    if (!identity) {
      return reply.status(401).send({
        error: "Unauthorized",
        message: "Missing or invalid x-service-token"
      });
    }

    const scopes = requiredScopes(request.method, routePath);
    if (!hasScope(identity, scopes)) {
      return reply.status(403).send({
        error: "Forbidden",
        message: "Token does not have the required scope",
        requiredScopes: scopes,
        service: identity.name
      });
    }

    (request as AuthenticatedRequest).serviceIdentity = {
      name: identity.name,
      scopes: identity.scopes
    };
  });
}
