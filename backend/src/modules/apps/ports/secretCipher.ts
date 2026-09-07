import { AppsError } from "../domain/errors.js";

/**
 * The narrow slice of the platform's encrypted-secret path that connection binding
 * needs. There is no decrypt here: nothing in the Apps control plane reads a connection
 * secret back, and the invocation path that eventually will lives in `appRuntime`.
 */
export interface AppSecretCipherPort {
  /** Recorded beside the ciphertext so a future key rotation can find what it wrote. */
  readonly keyId: string;
  encrypt(plaintext: string): string;
}

/** The default when no encryption key is configured: binding a secret fails closed. */
export const createUnavailableAppSecretCipher = (keyName: string): AppSecretCipherPort => ({
  keyId: "unavailable",
  encrypt: () => {
    throw new AppsError(
      "connection_encryption_unavailable",
      `${keyName} is not configured, so App connection secrets cannot be stored. Set ${keyName} and retry.`,
    );
  },
});
