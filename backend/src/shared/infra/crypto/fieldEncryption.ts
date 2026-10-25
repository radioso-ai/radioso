import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const KEY_LENGTH = 32;
const MIN_ENCRYPTED_PAYLOAD_BYTES = IV_LENGTH + AUTH_TAG_LENGTH;

/**
 * Stored form: `v1.<key id>.<base64(iv | ciphertext | tag)>`. Values written before ciphertext named
 * its key are `base64(iv | ciphertext | tag)` alone; base64 has no dot, so the two never collide.
 * The `v1.<key id>.` header is GCM additional authenticated data: changing or stripping it fails
 * decryption.
 */
const FORMAT_VERSION = "v1";
const KEYED_FORMAT = /^v1\.([0-9a-f]{16})\.([A-Za-z0-9+/]+={0,2})$/;
const FORMAT_SEPARATOR = ".";

/**
 * A key id is a truncated HMAC of a fixed label under the key: stable for a key, different across
 * keys, and no help in recovering the key, so reports and errors may print it.
 */
const KEY_ID_LABEL = "radioso field encryption key id";
const KEY_ID_BYTES = 8;

export interface FieldEncryptionOptions {
  /** Operator-facing name of the configuration source, used only in error messages. */
  keyName?: string;
}

/**
 * The deployment's credential keys. `current` encrypts every new value; `previous` keys only
 * decrypt, so values written under them stay readable until they are re-encrypted.
 */
export interface FieldEncryptionKeyRing {
  readonly current: string;
  readonly previous: readonly string[];
}

/** One base64 key, or a key ring. A single key behaves as a ring with no previous keys. */
export type FieldEncryptionKeys = string | FieldEncryptionKeyRing;

/** `keyed` values carry their key id; `unkeyed` values were written before they did. */
type FieldCiphertextFormat = "keyed" | "unkeyed";

export interface OpenedEncryptedField {
  plaintext: string;
  /** Id of the configured key that decrypted the value. */
  keyId: string;
  format: FieldCiphertextFormat;
}

/**
 * - `malformed`: not in either stored form.
 * - `unknown_key`: names a key the ring does not hold.
 * - `unauthenticated`: no configured key authenticates it (tampered, truncated, or an unkeyed value
 *   under a key the ring does not hold).
 */
type FieldDecryptionFailure = "malformed" | "unknown_key" | "unauthenticated";

const FAILURE_MESSAGES: Record<FieldDecryptionFailure, string> = {
  malformed: "Ciphertext is not a valid encrypted field",
  unknown_key: "Ciphertext was encrypted under a key that is not configured",
  unauthenticated: "No configured key decrypts this ciphertext",
};

/** A decryption failure. Its message names at most a key id, never a key or a value. */
export class FieldDecryptionError extends Error {
  constructor(
    readonly reason: FieldDecryptionFailure,
    readonly keyId: string | null = null,
  ) {
    super(keyId ? `${FAILURE_MESSAGES[reason]} (key id ${keyId})` : FAILURE_MESSAGES[reason]);
    this.name = "FieldDecryptionError";
  }
}

interface RingKey {
  id: string;
  key: Buffer;
}

const decodeKey = (keyBase64: string, keyName: string): Buffer => {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== KEY_LENGTH) {
    throw new Error(`${keyName} must decode to 32 bytes`);
  }

  return key;
};

const keyIdOf = (key: Buffer): string =>
  createHmac("sha256", key).update(KEY_ID_LABEL).digest().subarray(0, KEY_ID_BYTES).toString("hex");

const ringOf = (keys: FieldEncryptionKeys): FieldEncryptionKeyRing =>
  typeof keys === "string" ? { current: keys, previous: [] } : keys;

const ringKey = (keyBase64: string, keyName: string): RingKey => {
  const key = decodeKey(keyBase64, keyName);
  return { id: keyIdOf(key), key };
};

/** Current key first, then previous keys in configured order. */
const ringKeys = (keys: FieldEncryptionKeys, options: FieldEncryptionOptions): RingKey[] => {
  const ring = ringOf(keys);
  const keyName = options.keyName ?? "encryption key";
  return [
    ringKey(ring.current, keyName),
    ...ring.previous.map((previous) => ringKey(previous, `previous ${keyName}`)),
  ];
};

const headerFor = (keyId: string): string => `${FORMAT_VERSION}${FORMAT_SEPARATOR}${keyId}${FORMAT_SEPARATOR}`;

const openPayload = (payload: Buffer, key: Buffer, additionalData: Buffer | null): string => {
  const iv = payload.subarray(0, IV_LENGTH);
  const authTag = payload.subarray(payload.length - AUTH_TAG_LENGTH);
  const encrypted = payload.subarray(IV_LENGTH, payload.length - AUTH_TAG_LENGTH);

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH });
  if (additionalData) decipher.setAAD(additionalData);
  decipher.setAuthTag(authTag);

  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString("utf8");
};

const decodePayload = (encoded: string): Buffer => {
  const payload = Buffer.from(encoded, "base64");
  if (payload.length < MIN_ENCRYPTED_PAYLOAD_BYTES) {
    throw new FieldDecryptionError("malformed");
  }
  return payload;
};

const openKeyed = (ciphertext: string, candidates: readonly RingKey[]): OpenedEncryptedField => {
  const match = KEYED_FORMAT.exec(ciphertext);
  const keyId = match?.[1];
  const encoded = match?.[2];
  if (!keyId || !encoded) throw new FieldDecryptionError("malformed");
  const payload = decodePayload(encoded);
  const candidate = candidates.find((entry) => entry.id === keyId);
  if (!candidate) throw new FieldDecryptionError("unknown_key", keyId);
  try {
    const plaintext = openPayload(payload, candidate.key, Buffer.from(headerFor(keyId), "utf8"));
    return { plaintext, keyId, format: "keyed" };
  } catch {
    throw new FieldDecryptionError("unauthenticated", keyId);
  }
};

/** GCM's tag makes trying each key safe: only the key that encrypted the value authenticates it. */
const openUnkeyed = (ciphertext: string, candidates: readonly RingKey[]): OpenedEncryptedField => {
  const payload = decodePayload(ciphertext);
  for (const candidate of candidates) {
    try {
      return { plaintext: openPayload(payload, candidate.key, null), keyId: candidate.id, format: "unkeyed" };
    } catch {
      // Not this key; try the next one.
    }
  }
  throw new FieldDecryptionError("unauthenticated");
};

export const fieldEncryptionKeyId = (keyBase64: string, options: FieldEncryptionOptions = {}): string =>
  keyIdOf(decodeKey(keyBase64, options.keyName ?? "encryption key"));

/** The key that encrypts new values. */
export const currentFieldEncryptionKey = (keys: FieldEncryptionKeys): string => ringOf(keys).current;

/**
 * Why a ring's previous keys cannot be used, one sentence per problem: a malformed entry, an entry
 * listed twice, or an entry that repeats the current key. Entries are named by position, never by
 * value, so the result is safe to print at boot. The current key's own format is checked where it
 * is configured.
 */
export const previousFieldEncryptionKeyProblems = (
  ring: FieldEncryptionKeyRing,
  names: { current: string; previous: string },
): string[] => {
  const idOrNull = (value: string): string | null => {
    const key = Buffer.from(value, "base64");
    return key.length === KEY_LENGTH ? keyIdOf(key) : null;
  };
  const problems: string[] = [];
  const currentId = idOrNull(ring.current);
  const firstEntryById = new Map<string, number>();
  ring.previous.forEach((value, index) => {
    const entry = index + 1;
    const id = idOrNull(value);
    if (id === null) {
      problems.push(`Entry ${entry} of ${names.previous} must be base64 of 32 bytes`);
      return;
    }
    if (currentId !== null && id === currentId) {
      problems.push(`Entry ${entry} of ${names.previous} is the same key as ${names.current}`);
      return;
    }
    const firstEntry = firstEntryById.get(id);
    if (firstEntry === undefined) {
      firstEntryById.set(id, entry);
    } else {
      problems.push(`Entries ${firstEntry} and ${entry} of ${names.previous} are the same key`);
    }
  });
  return problems;
};

/** Encrypts under the current key, in the keyed stored form. */
export const encryptField = (
  plaintext: string,
  keys: FieldEncryptionKeys,
  options: FieldEncryptionOptions = {},
): string => {
  const current = ringKey(currentFieldEncryptionKey(keys), options.keyName ?? "encryption key");
  const header = headerFor(current.id);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, current.key, iv, { authTagLength: AUTH_TAG_LENGTH });
  cipher.setAAD(Buffer.from(header, "utf8"));

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  return `${header}${Buffer.concat([iv, encrypted, authTag]).toString("base64")}`;
};

/** Decrypts either stored form under whichever configured key wrote it, and says which. */
export const openEncryptedField = (
  ciphertext: string,
  keys: FieldEncryptionKeys,
  options: FieldEncryptionOptions = {},
): OpenedEncryptedField => {
  const candidates = ringKeys(keys, options);
  return ciphertext.includes(FORMAT_SEPARATOR)
    ? openKeyed(ciphertext, candidates)
    : openUnkeyed(ciphertext, candidates);
};

export const decryptField = (
  ciphertext: string,
  keys: FieldEncryptionKeys,
  options: FieldEncryptionOptions = {},
): string => openEncryptedField(ciphertext, keys, options).plaintext;

export const isEncryptedField = (
  value: string,
  keys: FieldEncryptionKeys,
  options: FieldEncryptionOptions = {},
): boolean => {
  try {
    void decryptField(value, keys, options);
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
