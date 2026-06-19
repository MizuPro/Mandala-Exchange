import { FastifyReply } from "fastify";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { db } from "../db/db.js";
import { users } from "../db/schema.js";
import { env } from "../config/env.js";

export interface UserTokenPayload {
  user_id: string;
}

const DEV_JWT_SECRET = "mandala_sekuritas_dev_secret";

export function jwtSecret() {
  const secret = env.jwtSecret;
  if (!secret && env.isProduction) {
    throw new Error("JWT_SECRET is required in production");
  }
  return secret || DEV_JWT_SECRET;
}

export function signUserToken(userId: string) {
  return jwt.sign({ user_id: userId }, jwtSecret(), { expiresIn: "1d" });
}

export function verifyUserToken(token: string) {
  return jwt.verify(token, jwtSecret()) as UserTokenPayload;
}

export async function authenticateUser(request: any, reply: FastifyReply) {
  try {
    const authorization = request.headers.authorization;
    const token = typeof authorization === "string" ? authorization.replace(/^Bearer\s+/i, "") : "";
    if (!token) throw new Error("No token");
    const decoded = verifyUserToken(token);
    request.user_id = decoded.user_id;
  } catch {
    return reply.status(401).send({ error: "Unauthorized" });
  }
}

export async function authenticateActiveUser(request: any, reply: FastifyReply) {
  const authResult = await authenticateUser(request, reply);
  if (reply.sent) return authResult;

  const [user] = await db.select().from(users).where(eq(users.id, request.user_id)).limit(1);
  if (!user) {
    return reply.status(401).send({ error: "Unauthorized" });
  }
  if (user.status !== "verified") {
    return reply.status(403).send({ error: "User account is not verified or active" });
  }

  request.user = user;
}

export function requireServiceToken(request: any, reply: FastifyReply, expectedToken: string | undefined, name: string) {
  const allowInsecureLocal = env.allowInsecureLocalTokens;
  const host = String(request.hostname || request.headers.host || "");
  if (!expectedToken && allowInsecureLocal && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return true;
  }
  const provided = request.headers["x-service-token"];
  if (!expectedToken || provided !== expectedToken) {
    reply.status(401).send({ error: `Missing or invalid ${name} service token` });
    return false;
  }
  return true;
}

export function requireAdminToken(request: any, reply: FastifyReply) {
  const expectedToken = env.adminToken;
  const allowInsecureLocal = env.allowInsecureLocalTokens;
  const host = String(request.hostname || request.headers.host || "");
  if (!expectedToken && allowInsecureLocal && /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) {
    return true;
  }
  const provided = request.headers["x-admin-token"];
  if (!expectedToken || provided !== expectedToken) {
    reply.status(401).send({ error: "Missing or invalid admin token" });
    return false;
  }
  return true;
}
