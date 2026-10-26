import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  decryptField,
  encryptField,
  encryptFieldAs,
  FIELD_ENCRYPTION_WRITE_FORMAT,
  fieldEncryptionKeyId,
  previousFieldEncryptionKeyProblems,
  FieldDecryptionError,
  isEncryptedField,
  maskSecret,
  openEncryptedField,
} from "../../../../src/shared/infra/crypto/fieldEncryption.js";

const TEST_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64"); // 32 bytes
const OLD_KEY = Buffer.alloc(32, 0x11).toString("base64");
const OLDER_KEY = Buffer.alloc(32, 0x22).toString("base64");
const UNCONFIGURED_KEY = Buffer.alloc(32, 0x33).toString("base64");
const KEY_NAMES = { current: "CONNECTOR_ENCRYPTION_KEY", previous: "CONNECTOR_ENCRYPTION_PREVIOUS_KEYS" };

/** The stored form written before ciphertext named its key: base64(iv | ciphertext | tag), no AAD. */
const encryptUnkeyed = (plaintext: string, keyBase64: string): string => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), iv, { authTagLength: 16 });
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]).toString("base64");
};

/** The previous release's reader: base64(iv | ciphertext | tag) under one key, no AAD. */
const decryptAsPreviousRelease = (stored: string, keyBase64: string): string => {
  const data = Buffer.from(stored, "base64");
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(keyBase64, "base64"), data.subarray(0, 12), {
    authTagLength: 16,
  });
  decipher.setAuthTag(data.subarray(data.length - 16));
  return Buffer.concat([decipher.update(data.subarray(12, data.length - 16)), decipher.final()]).toString("utf8");
};

/** The keyed writer, which production switches to once the write format flips. */
const encryptKeyed = (plaintext: string, keys: Parameters<typeof encryptFieldAs>[2]): string =>
  encryptFieldAs("keyed", plaintext, keys);

const decryptionFailure = (run: () => unknown): FieldDecryptionError => {
  try {
    run();
  } catch (error) {
    if (error instanceof FieldDecryptionError) return error;
    throw error;
  }
  throw new Error("expected a FieldDecryptionError");
};

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

  describe("write format", () => {
    it("writes the stored form the previous release reads, so a rolling deploy or a rollback keeps credentials readable", () => {
      const encrypted = encryptField("written-by-this-release", TEST_KEY);

      expect(FIELD_ENCRYPTION_WRITE_FORMAT).toBe("unkeyed");
      expect(encrypted).not.toContain(".");
      expect(decryptAsPreviousRelease(encrypted, TEST_KEY)).toBe("written-by-this-release");
    });

    it("encrypts under the ring's current key in the write format", () => {
      const ring = { current: TEST_KEY, previous: [OLD_KEY] };

      expect(openEncryptedField(encryptField("secret", ring), ring)).toEqual({
        plaintext: "secret",
        keyId: fieldEncryptionKeyId(TEST_KEY),
        format: FIELD_ENCRYPTION_WRITE_FORMAT,
      });
    });
  });

  describe("stored format", () => {
    it("names the encrypting key ahead of the payload", () => {
      const encrypted = encryptKeyed("secret", TEST_KEY);
      const [version, keyId, payload, ...rest] = encrypted.split(".");

      expect(version).toBe("v1");
      expect(keyId).toBe(fieldEncryptionKeyId(TEST_KEY));
      expect(Buffer.from(payload, "base64").length).toBe(12 + "secret".length + 16);
      expect(rest).toEqual([]);
    });

    it("derives a stable key id that differs per key and never contains the key", () => {
      const id = fieldEncryptionKeyId(TEST_KEY);

      expect(id).toMatch(/^[0-9a-f]{16}$/);
      expect(fieldEncryptionKeyId(TEST_KEY)).toBe(id);
      expect(fieldEncryptionKeyId(OLD_KEY)).not.toBe(id);
      expect(id).not.toContain(Buffer.from(TEST_KEY, "base64").toString("hex").slice(0, 8));
    });

    it("encrypts under the ring's current key", () => {
      const encrypted = encryptKeyed("secret", { current: TEST_KEY, previous: [OLD_KEY] });

      expect(encrypted.split(".")[1]).toBe(fieldEncryptionKeyId(TEST_KEY));
      expect(decryptField(encrypted, TEST_KEY)).toBe("secret");
    });

    it("rejects a value whose key id was swapped for another configured key's", () => {
      const encrypted = encryptKeyed("secret", TEST_KEY);
      const swapped = encrypted.replace(fieldEncryptionKeyId(TEST_KEY), fieldEncryptionKeyId(OLD_KEY));

      expect(() => decryptField(swapped, { current: TEST_KEY, previous: [OLD_KEY] })).toThrow(FieldDecryptionError);
    });

    it("rejects the payload once its header is stripped, because the header is authenticated", () => {
      const encrypted = encryptKeyed("secret", TEST_KEY);
      const payloadOnly = encrypted.split(".")[2];

      expect(() => decryptField(payloadOnly, TEST_KEY)).toThrow(FieldDecryptionError);
    });

    it("rejects an unsupported version", () => {
      const encrypted = encryptKeyed("secret", TEST_KEY);

      expect(decryptionFailure(() => decryptField(`v2${encrypted.slice(2)}`, TEST_KEY)).reason).toBe("malformed");
    });
  });

  describe("key rings", () => {
    it("decrypts a value written without a key id under the current key", () => {
      const stored = encryptUnkeyed("written-before-key-ids", TEST_KEY);

      expect(decryptField(stored, TEST_KEY)).toBe("written-before-key-ids");
      expect(openEncryptedField(stored, TEST_KEY)).toEqual({
        plaintext: "written-before-key-ids",
        keyId: fieldEncryptionKeyId(TEST_KEY),
        format: "unkeyed",
      });
    });

    it("decrypts a value written without a key id under a previous key", () => {
      const stored = encryptUnkeyed("still-readable", OLDER_KEY);
      const ring = { current: TEST_KEY, previous: [OLD_KEY, OLDER_KEY] };

      expect(decryptField(stored, ring)).toBe("still-readable");
      expect(openEncryptedField(stored, ring).keyId).toBe(fieldEncryptionKeyId(OLDER_KEY));
    });

    it("decrypts a keyed value under a previous key", () => {
      const stored = encryptKeyed("before-rotation", OLD_KEY);
      const ring = { current: TEST_KEY, previous: [OLD_KEY] };

      expect(openEncryptedField(stored, ring)).toEqual({
        plaintext: "before-rotation",
        keyId: fieldEncryptionKeyId(OLD_KEY),
        format: "keyed",
      });
    });

    it("fails cleanly on a key id the ring does not hold, naming the id and never the key", () => {
      const stored = encryptKeyed("orphaned", UNCONFIGURED_KEY);
      const failure = decryptionFailure(() => decryptField(stored, { current: TEST_KEY, previous: [OLD_KEY] }));

      expect(failure.reason).toBe("unknown_key");
      expect(failure.keyId).toBe(fieldEncryptionKeyId(UNCONFIGURED_KEY));
      expect(failure.message).toContain(fieldEncryptionKeyId(UNCONFIGURED_KEY));
      expect(failure.message).not.toContain(UNCONFIGURED_KEY);
    });

    it("fails a value written without a key id when no configured key opens it", () => {
      const stored = encryptUnkeyed("orphaned", UNCONFIGURED_KEY);

      expect(decryptionFailure(() => decryptField(stored, { current: TEST_KEY, previous: [OLD_KEY] })).reason)
        .toBe("unauthenticated");
    });

    it("accepts either format under any configured key as encrypted", () => {
      const ring = { current: TEST_KEY, previous: [OLD_KEY] };

      expect(isEncryptedField(encryptKeyed("a", OLD_KEY), ring)).toBe(true);
      expect(isEncryptedField(encryptUnkeyed("b", OLD_KEY), ring)).toBe(true);
      expect(isEncryptedField(encryptKeyed("c", UNCONFIGURED_KEY), ring)).toBe(false);
      expect(isEncryptedField("plain-text-secret", ring)).toBe(false);
    });
  });

  describe("previous key configuration", () => {
    it("accepts a single key", () => {
      expect(previousFieldEncryptionKeyProblems({ current: TEST_KEY, previous: [] }, KEY_NAMES)).toEqual([]);
    });

    it("accepts several previous keys", () => {
      expect(previousFieldEncryptionKeyProblems({ current: TEST_KEY, previous: [OLD_KEY, OLDER_KEY] }, KEY_NAMES))
        .toEqual([]);
    });

    it("rejects a previous key listed twice, by position", () => {
      const problems = previousFieldEncryptionKeyProblems({ current: TEST_KEY, previous: [OLD_KEY, OLDER_KEY, OLD_KEY] }, KEY_NAMES);

      expect(problems).toEqual(["Entries 1 and 3 of CONNECTOR_ENCRYPTION_PREVIOUS_KEYS are the same key"]);
    });

    it("rejects a previous key that is the current key", () => {
      const problems = previousFieldEncryptionKeyProblems({ current: TEST_KEY, previous: [OLD_KEY, TEST_KEY] }, KEY_NAMES);

      expect(problems).toEqual([
        "Entry 2 of CONNECTOR_ENCRYPTION_PREVIOUS_KEYS is the same key as CONNECTOR_ENCRYPTION_KEY",
      ]);
    });

    it("rejects a malformed previous key without printing it", () => {
      const malformed = Buffer.from("too-short").toString("base64");
      const problems = previousFieldEncryptionKeyProblems({ current: TEST_KEY, previous: [malformed] }, KEY_NAMES);

      expect(problems).toEqual(["Entry 1 of CONNECTOR_ENCRYPTION_PREVIOUS_KEYS must be base64 of 32 bytes"]);
      expect(problems.join(" ")).not.toContain(malformed);
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
