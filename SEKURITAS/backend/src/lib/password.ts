import crypto from "crypto";

const SCRYPT_PREFIX = "scrypt";

function legacySha256(password: string) {
  return crypto.createHash("sha256").update(password).digest("hex");
}

export function hashPassword(password: string) {
  const salt = crypto.randomBytes(16).toString("hex");
  const key = crypto.scryptSync(password, salt, 64).toString("hex");
  return `${SCRYPT_PREFIX}$${salt}$${key}`;
}

export function verifyPassword(password: string, storedHash: string) {
  if (storedHash.startsWith(`${SCRYPT_PREFIX}$`)) {
    const [, salt, key] = storedHash.split("$");
    if (!salt || !key) return false;
    const candidate = crypto.scryptSync(password, salt, 64);
    const expected = Buffer.from(key, "hex");
    return expected.length === candidate.length && crypto.timingSafeEqual(expected, candidate);
  }

  const legacy = legacySha256(password);
  return legacy.length === storedHash.length && crypto.timingSafeEqual(Buffer.from(legacy), Buffer.from(storedHash));
}
