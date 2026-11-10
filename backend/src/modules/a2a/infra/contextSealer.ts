import { serviceUnavailable } from "../../../shared/domain/errors.js";
import { decryptField, encryptField, type FieldEncryptionKeys } from "../../../shared/infra/crypto/fieldEncryption.js";
import type { A2aContextSealer } from "../contracts/ports.js";
import { decodeContextClaims, encodeContextClaims } from "../domain/contextClaims.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

/** Field ciphertext is base64 (with `.`-separated headers once keyed); a context id travels URL-safe. */
const toUrlSafe = (ciphertext: string): string =>
  ciphertext.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");

const fromUrlSafe = (token: string): string => {
  const segments = token.replaceAll("-", "+").replaceAll("_", "/").split(".");
  const payload = segments.pop() ?? "";
  return [...segments, payload.padEnd(payload.length + ((4 - (payload.length % 4)) % 4), "=")].join(".");
};

/**
 * Seals a converse opening into the context id an A2A caller holds, with the deployment's field
 * encryption keys: the token is authenticated, so a caller can neither read the workspace, agent
 * and session it names nor forge one, and keys rotated into `previous` keep it readable.
 *
 * With no key configured there is nothing to seal with. Opening a context then fails as
 * unavailable rather than falling back to a weaker token, and no token opens.
 */
export const createA2aContextSealer = (keys: FieldEncryptionKeys | undefined): A2aContextSealer => ({
  seal(opening) {
    if (!keys) {
      throw serviceUnavailable("A2A contexts are unavailable: no field encryption key is configured.", {
        code: "a2a_context_sealing_unavailable",
      });
    }
    return toUrlSafe(encryptField(encodeContextClaims(opening), keys, { keyName: KEY_NAME }));
  },
  open(token) {
    if (!keys || token.length === 0) {
      return null;
    }
    try {
      return decodeContextClaims(decryptField(fromUrlSafe(token), keys, { keyName: KEY_NAME }));
    } catch {
      return null;
    }
  },
});
