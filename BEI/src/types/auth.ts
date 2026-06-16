import type { FastifyRequest } from "fastify";

export type AuthScope =
  | "admin:*"
  | "market:read"
  | "market-summary:write"
  | "rules:read"
  | "broker:read"
  | "trade:capture"
  | "trade:read"
  | "settlement:read"
  | "settlement:write"
  | "custody:read"
  | "corporate-action:read"
  | "corporate-action:write"
  | "report:read"
  | "surveillance:read"
  | "surveillance:write";

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
