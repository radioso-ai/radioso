import { describe, expect, it } from "vitest";

import {
  encryptField,
  decryptField,
  isEncryptedConnectorSecret,
  maskSecret,
} from "../../../src/modules/connectors/services/configEncryption.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); // 32 bytes

describe("config encryption", () => {
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
      // Both decrypt to the same value
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

    it("detects valid encrypted connector secrets", () => {
      const encrypted = encryptField("secret", TEST_KEY);
      expect(isEncryptedConnectorSecret(encrypted, TEST_KEY)).toBe(true);
      expect(isEncryptedConnectorSecret("plain-text-secret", TEST_KEY)).toBe(false);
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
