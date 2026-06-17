import crypto from "crypto";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.js";

describe("password hashing", () => {
  it("verifies scrypt hashes and rejects the wrong password", () => {
    const hash = hashPassword("correct-password");

    expect(verifyPassword("correct-password", hash)).toBe(true);
    expect(verifyPassword("wrong-password", hash)).toBe(false);
  });

  it("keeps legacy sha256 hashes readable during migration", () => {
    const legacyHash = crypto.createHash("sha256").update("legacy-password").digest("hex");

    expect(verifyPassword("legacy-password", legacyHash)).toBe(true);
    expect(verifyPassword("wrong-password", legacyHash)).toBe(false);
  });
});
