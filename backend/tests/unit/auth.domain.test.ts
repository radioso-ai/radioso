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
import {
  DISPLAY_NAME_MAX_LENGTH,
  normalizeDisplayName,
} from "../../src/modules/auth/domain/userDisplayName.js";

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
    expect(generateApiToken()).toMatch(/^radioso_[a-f0-9]+$/);
  });

  it("encrypts and decrypts stored tokens", () => {
    const encrypted = encryptSecret("radioso_secret", "0123456789abcdef0123456789abcdef");

    expect(decryptSecret(encrypted, "0123456789abcdef0123456789abcdef")).toEqual("radioso_secret");
  });
});

describe("user display name", () => {
  it("trims the name and clears it when nothing is left", () => {
    expect(normalizeDisplayName("  Ada Lovelace  ")).toEqual({ ok: true, displayName: "Ada Lovelace" });
    expect(normalizeDisplayName("   ")).toEqual({ ok: true, displayName: null });
    expect(normalizeDisplayName("")).toEqual({ ok: true, displayName: null });
    expect(normalizeDisplayName(null)).toEqual({ ok: true, displayName: null });
  });

  it("accepts any script", () => {
    expect(normalizeDisplayName("山田 太郎")).toEqual({ ok: true, displayName: "山田 太郎" });
    expect(normalizeDisplayName("Zoë Ørsted-Łukasz")).toEqual({ ok: true, displayName: "Zoë Ørsted-Łukasz" });
    expect(normalizeDisplayName("محمد")).toEqual({ ok: true, displayName: "محمد" });
  });

  it("allows 80 characters after trimming and rejects 81", () => {
    const eighty = "a".repeat(DISPLAY_NAME_MAX_LENGTH);

    expect(normalizeDisplayName(`  ${eighty}  `)).toEqual({ ok: true, displayName: eighty });
    expect(normalizeDisplayName(`${eighty}b`)).toEqual({ ok: false, reason: "too_long" });
  });

  it("counts characters rather than UTF-16 code units", () => {
    const eightyAstral = "𝒜".repeat(DISPLAY_NAME_MAX_LENGTH);

    expect(normalizeDisplayName(eightyAstral)).toEqual({ ok: true, displayName: eightyAstral });
  });

  it("rejects control characters inside the name", () => {
    expect(normalizeDisplayName("Ada\nLovelace")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\tLovelace")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\u0000")).toEqual({ ok: false, reason: "control_characters" });
    expect(normalizeDisplayName("Ada\u009bLovelace")).toEqual({ ok: false, reason: "control_characters" });
  });
});
