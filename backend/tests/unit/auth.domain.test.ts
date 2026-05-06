import { describe, expect, it } from "vitest";

import {
  decryptSecret,
  encryptSecret,
  generateApiToken,
  generateSessionToken,
  hashPassword,
  sha256,
  verifyPassword,
} from "../../src/modules/auth/domain/authPrimitives.js";

describe("auth primitives", () => {
  it("hashes and verifies passwords", async () => {
    const passwordHash = await hashPassword("correct horse battery staple");

    await expect(verifyPassword("correct horse battery staple", passwordHash)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", passwordHash)).resolves.toBe(false);
  }, 15_000);

  it("generates distinct session tokens and hashes them deterministically", () => {
    const a = generateSessionToken();
    const b = generateSessionToken();

    expect(a).not.toEqual(b);
    expect(sha256(a)).toEqual(sha256(a));
  });

  it("generates api tokens with the expected prefix", () => {
    expect(generateApiToken()).toMatch(/^sk_proj_[a-f0-9]+$/);
  });

  it("encrypts and decrypts stored tokens", () => {
    const encrypted = encryptSecret("sk_proj_secret", "0123456789abcdef0123456789abcdef");

    expect(decryptSecret(encrypted, "0123456789abcdef0123456789abcdef")).toEqual("sk_proj_secret");
  });
});
