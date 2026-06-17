import { FastifyInstance } from "fastify";
import { db } from "../db/db.js";
import { users, email_verifications } from "../db/schema.js";
import { createBrokerAccount } from "../services/account-service.js";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import { z } from "zod";
import { authenticateUser, signUserToken } from "../lib/auth.js";
import { hashPassword, verifyPassword } from "../lib/password.js";

const authBodySchema = z.object({
  email: z.string().email().transform((value) => value.toLowerCase().trim()),
  password: z.string().min(6),
});

const verifyEmailSchema = z.object({
  token: z.string().min(1),
});

function publicUser(user: typeof users.$inferSelect) {
  return {
    id: user.id,
    email: user.email,
    is_verified: user.status === "verified",
    status: user.status,
  };
}

export default async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (request, reply) => {
    const parsed = authBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid registration payload" });
    }
    const { email, password } = parsed.data;

    const existing = await db.select().from(users).where(eq(users.email, email)).limit(1);
    if (existing.length > 0) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    const password_hash = hashPassword(password);
    const status = "unverified";

    const [user] = await db.insert(users).values({
      email,
      password_hash,
      status
    }).returning();

    // Create broker account automatically
    await createBrokerAccount(user.id, "HUMAN");

    const token = crypto.randomBytes(16).toString("hex");
    const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.insert(email_verifications).values({
      user_id: user.id,
      token,
      expires_at
    });

    return {
      token: signUserToken(user.id),
      user: publicUser(user),
      verification_token: process.env.NODE_ENV === "production" ? undefined : token,
      message: "User registered successfully. Email verification is required before trading."
    };
  });

  app.post("/login", async (request, reply) => {
    const parsed = authBodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid login payload" });
    }
    const { email, password } = parsed.data;
    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user || !verifyPassword(password, user.password_hash)) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    if (user.status === "unverified") {
      return reply.status(403).send({ error: "Email not verified" });
    }
    if (user.status === "suspended") {
      return reply.status(403).send({ error: "User account suspended" });
    }

    return { token: signUserToken(user.id), user: publicUser(user) };
  });

  app.get("/me", { preHandler: authenticateUser }, async (request: any, reply) => {
    const [user] = await db.select().from(users).where(eq(users.id, request.user_id)).limit(1);
    if (!user) return reply.status(404).send({ error: "User not found" });
    return { user: publicUser(user) };
  });

  app.post("/verify-email", async (request, reply) => {
    const parsed = verifyEmailSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.issues[0]?.message || "Invalid verification payload" });
    }
    const { token } = parsed.data;

    const [verification] = await db.select().from(email_verifications).where(eq(email_verifications.token, token)).limit(1);

    if (!verification || verification.used || new Date() > verification.expires_at) {
      return reply.status(400).send({ error: "Invalid or expired token" });
    }

    await db.transaction(async (tx) => {
      await tx.update(email_verifications).set({ used: true }).where(eq(email_verifications.id, verification.id));
      await tx.update(users).set({ status: "verified" }).where(eq(users.id, verification.user_id));
    });

    return { message: "Email verified successfully" };
  });
}
