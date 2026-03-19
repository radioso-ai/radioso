import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;

const decodeKey = (keyBase64: string): Buffer => {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error("CONNECTOR_ENCRYPTION_KEY must decode to 32 bytes");
  }

  return key;
};

/**
 * Encrypt a plaintext config field value using AES-256-GCM.
 * Returns a base64 string containing IV + ciphertext + auth tag.
 */
export const encryptField = (plaintext: string, keyBase64: string): string => {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
};

/**
 * Decrypt a field value previously encrypted with encryptField().
 */
export const decryptField = (ciphertext: string, keyBase64: string): string => {
  const key = decodeKey(keyBase64);
  const data = Buffer.from(ciphertext, "base64");

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};

/**
 * Mask a secret value, showing only the last 4 characters.
 */
export const maskSecret = (value: string): string => {
  if (value.length === 0) {
    return "";
  }

  if (value.length < 4) {
    return "*".repeat(value.length);
  }

  if (value.length === 4) {
    return value;
  }

  return "*".repeat(value.length - 4) + value.slice(-4);
};
