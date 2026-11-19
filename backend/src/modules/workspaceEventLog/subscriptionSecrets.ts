import { createHmac } from "node:crypto";

import { AppError } from "../../shared/domain/errors.js";
import { decryptField, encryptField, type FieldEncryptionKeyRing } from "../../shared/infra/crypto/fieldEncryption.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

/** Separates the target hash from any other HMAC a key may be used for. */
const TARGET_HASH_CONTEXT = "radioso:workspace-event-subscription-target:v1\u0000";

/** Seals and opens a subscription's target URL and signing secret, and names its target without revealing it. */
export interface SubscriptionSealer {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
  /**
   * The keyed hash of a normalized target URL under every configured key, the current key's first:
   * equal URLs hash equal, and the hash reveals nothing without the key.
   */
  targetHashes(normalizedUrl: string): [string, ...string[]];
}

const encryptionNotConfigured = (): AppError => new AppError(
  503,
  "encryption_not_configured",
  `${KEY_NAME} is not configured; cannot store event subscription secrets. Set ${KEY_NAME} to enable event subscriptions.`,
);

/**
 * The sealer over `CONNECTOR_ENCRYPTION_KEY`, the same key webhook destinations use, so the
 * re-encryption command moves both sealed columns with the rest. Without a key nothing can be
 * sealed, opened or hashed, and a create answers `encryption_not_configured`.
 */
export const connectorKeySealer = (key: FieldEncryptionKeyRing | undefined): SubscriptionSealer => {
  const ring = (): FieldEncryptionKeyRing => {
    if (!key || key.current.length === 0) throw encryptionNotConfigured();
    return key;
  };
  const hashUnder = (secret: string, normalizedUrl: string): string =>
    createHmac("sha256", secret).update(`${TARGET_HASH_CONTEXT}${normalizedUrl}`).digest("hex");
  return {
    seal: (plaintext) => encryptField(plaintext, ring(), { keyName: KEY_NAME }),
    open: (ciphertext) => decryptField(ciphertext, ring(), { keyName: KEY_NAME }),
    targetHashes(normalizedUrl) {
      const keys = ring();
      return [hashUnder(keys.current, normalizedUrl), ...keys.previous.map((previous) => hashUnder(previous, normalizedUrl))];
    },
  };
};
