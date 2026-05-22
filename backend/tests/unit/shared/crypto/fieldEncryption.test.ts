import { describe, expect, it } from "vitest";

import {
  decryptField,
  encryptField,
  isEncryptedField,
  maskSecret,
} from "../../../../src/shared/infra/crypto/fieldEncryption.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); // 32 bytes

describe("field encryption", () => {
  describe("encryptField / decryptField", () => {
    it("round-trips a plaintext value", () => {
      const plaintext = "my-api-token-12345";
      const encrypted = encryptField(plaintext, TEST_KEY);
      expect(encrypted).not.toBe(plaintext);
      expect(decryptField(encrypted, TEST_KEY)).toBe(plaintext);
    });

    it("produces unique ciphertext on each call (unique IVs)", () => {
      const plaintext = "same-value";
      const a = encryptField(plaintext, TEST_KEY);
      const b = encryptField(plaintext, TEST_KEY);
      expect(a).not.toBe(b);
      expect(decryptField(a, TEST_KEY)).toBe(plaintext);
      expect(decryptField(b, TEST_KEY)).toBe(plaintext);
    });

    it("handles empty string", () => {
      const encrypted = encryptField("", TEST_KEY);
      expect(decryptField(encrypted, TEST_KEY)).toBe("");
    });

    it("handles unicode content", () => {
      const plaintext = "tökën-with-üñîcödé";
      const encrypted = encryptField(plaintext, TEST_KEY);
      expect(decryptField(encrypted, TEST_KEY)).toBe(plaintext);
    });

    it("throws on invalid key for decrypt", () => {
      const encrypted = encryptField("secret", TEST_KEY);
      const wrongKey = Buffer.from("ffffffffffffffffffffffffffffffff").toString("base64");
      expect(() => decryptField(encrypted, wrongKey)).toThrow();
    });

    it("throws on tampered ciphertext", () => {
      const encrypted = encryptField("secret", TEST_KEY);
      const tampered = encrypted.slice(0, -4) + "XXXX";
      expect(() => decryptField(tampered, TEST_KEY)).toThrow();
    });

    it("detects valid encrypted fields", () => {
      const encrypted = encryptField("secret", TEST_KEY);
      expect(isEncryptedField(encrypted, TEST_KEY)).toBe(true);
      expect(isEncryptedField("plain-text-secret", TEST_KEY)).toBe(false);
    });

    it("reports the caller-supplied key name when the key is malformed", () => {
      const badKey = Buffer.from("too-short").toString("base64");
      expect(() => encryptField("x", badKey, { keyName: "CONNECTOR_ENCRYPTION_KEY" })).toThrow(
        /CONNECTOR_ENCRYPTION_KEY must decode to 32 bytes/,
      );
    });
  });

  describe("maskSecret", () => {
    it("masks value showing last 4 characters", () => {
      expect(maskSecret("my-secret-token-1234")).toBe("****************1234");
    });

    it("masks short values entirely", () => {
      expect(maskSecret("abc")).toBe("***");
    });

    it("masks empty string", () => {
      expect(maskSecret("")).toBe("");
    });

    it("masks exactly 4 characters", () => {
      expect(maskSecret("abcd")).toBe("abcd");
    });
  });
});
