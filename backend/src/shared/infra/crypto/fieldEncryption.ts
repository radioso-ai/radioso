import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MIN_ENCRYPTED_PAYLOAD_BYTES = IV_LENGTH + AUTH_TAG_LENGTH;

export interface FieldEncryptionOptions {
  /** Operator-facing name of the configuration source, used only in error messages. */
  keyName?: string;
}

const decodeKey = (keyBase64: string, keyName: string): Buffer => {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${keyName} must decode to 32 bytes`);
  }

  return key;
};

export const encryptField = (
  plaintext: string,
  keyBase64: string,
  options: FieldEncryptionOptions = {},
): string => {
  const key = decodeKey(keyBase64, options.keyName ?? "encryption key");
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return Buffer.concat([iv, encrypted, authTag]).toString("base64");
};

export const decryptField = (
  ciphertext: string,
  keyBase64: string,
  options: FieldEncryptionOptions = {},
): string => {
  const key = decodeKey(keyBase64, options.keyName ?? "encryption key");
  const data = Buffer.from(ciphertext, "base64");
  if (data.length < MIN_ENCRYPTED_PAYLOAD_BYTES) {
    throw new Error("Ciphertext is not a valid encrypted field");
  }

  const iv = data.subarray(0, IV_LENGTH);
  const authTag = data.subarray(data.length - AUTH_TAG_LENGTH);
  const encrypted = data.subarray(IV_LENGTH, data.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};

export const isEncryptedField = (
  value: string,
  keyBase64: string,
  options: FieldEncryptionOptions = {},
): boolean => {
  try {
    void decryptField(value, keyBase64, options);
    return true;
  } catch {
    return false;
  }
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
