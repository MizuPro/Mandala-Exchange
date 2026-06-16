import { FastifyInstance } from "fastify";
import { db } from "../db/db.js";
import { users, email_verifications } from "../db/schema.js";
import { createBrokerAccount } from "../services/account-service.js";
import { eq } from "drizzle-orm";
import crypto from "crypto";
import jwt from "jsonwebtoken";

export default async function authRoutes(app: FastifyInstance) {
  app.post("/register", async (request, reply) => {
    const { email, password, type = "HUMAN" } = request.body as any; // simplify with zod later

    // Dummy password hash for MVP
    const password_hash = crypto.createHash('sha256').update(password).digest('hex');

    const status = type === "BOT" ? "verified" : "unverified";

    const [user] = await db.insert(users).values({
      email,
      password_hash,
      status
    }).returning();

    // Create broker account automatically
    await createBrokerAccount(user.id, type);

    if (type === "HUMAN") {
      // Create email verification
      const token = crypto.randomBytes(16).toString("hex");
      const expires_at = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours
      await db.insert(email_verifications).values({
        user_id: user.id,
        token,
        expires_at
      });
      // Mock sending email...
    }

    return { message: "User registered successfully", user_id: user.id, status };
  });

  app.post("/login", async (request, reply) => {
    const { email, password } = request.body as any;
    const password_hash = crypto.createHash('sha256').update(password).digest('hex');

    const [user] = await db.select().from(users).where(eq(users.email, email)).limit(1);

    if (!user || user.password_hash !== password_hash) {
      return reply.status(401).send({ error: "Invalid credentials" });
    }

    if (user.status === "unverified") {
      return reply.status(403).send({ error: "Email not verified" });
    }

    const token = jwt.sign({ user_id: user.id }, process.env.JWT_SECRET || "secret", { expiresIn: "1d" });
    return { token, user_id: user.id };
  });

  app.post("/verify-email", async (request, reply) => {
    const { token } = request.body as any;

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
