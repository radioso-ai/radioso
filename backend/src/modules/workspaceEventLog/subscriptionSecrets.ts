import { AppError } from "../../shared/domain/errors.js";
import { decryptField, encryptField, type FieldEncryptionKeyRing } from "../../shared/infra/crypto/fieldEncryption.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

/** Seals and opens a subscription's target URL and signing secret under the credential key ring. */
export interface SubscriptionSealer {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
}

const encryptionNotConfigured = (): AppError => new AppError(
  503,
  "encryption_not_configured",
  `${KEY_NAME} is not configured; cannot store event subscription secrets. Set ${KEY_NAME} to enable event subscriptions.`,
);

/**
 * The sealer over `CONNECTOR_ENCRYPTION_KEY`, the same key webhook destinations use, so the
 * re-encryption command moves both columns with the rest. Without a key nothing can be sealed or
 * opened, and a create answers `encryption_not_configured`.
 */
export const connectorKeySealer = (key: FieldEncryptionKeyRing | undefined): SubscriptionSealer => ({
  seal(plaintext) {
    if (!key || key.current.length === 0) throw encryptionNotConfigured();
    return encryptField(plaintext, key, { keyName: KEY_NAME });
  },
  open(ciphertext) {
    if (!key || key.current.length === 0) throw encryptionNotConfigured();
    return decryptField(ciphertext, key, { keyName: KEY_NAME });
  },
});
