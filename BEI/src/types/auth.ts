import type { FastifyRequest } from "fastify";

export type AuthScope =
  | "admin:*"
  | "market:read"
  | "market-summary:write"
  | "rules:read"
  | "broker:read"
  | "trade:capture"
  | "trade:read"
  | "session:write"
  | "settlement:read"
  | "settlement:write"
  | "custody:read"
  | "custody:write"
  | "corporate-action:read"
  | "corporate-action:write"
  | "ipo:read"
  | "ipo:write"
  | "report:read"
  | "surveillance:read"
  | "surveillance:write"
  | "bot:events"
  | "bot:provision"
  | "bot:genesis"
  | "bot:snapshot";

export type ServiceIdentity = {
  name: string;
  token: string;
  scopes: AuthScope[];
};

export type RoutePermission = {
  method: string;
  path: string;
  scopes: AuthScope[];
};

export type AuthenticatedRequest = FastifyRequest & {
  serviceIdentity?: Omit<ServiceIdentity, "token">;
};
