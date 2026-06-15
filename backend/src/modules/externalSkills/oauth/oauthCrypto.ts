import { encryptField, decryptField } from "../../../shared/infra/crypto/fieldEncryption.js";
import type { StoredOauthClientConfig, StoredOauthFlow, StoredOauthTokens } from "../domain.js";

/**
 * Encrypt/decrypt the JSON-serialized OAuth artifacts at rest, reusing the shared
 * field encryption (AES-256-GCM, the existing operator key). No new crypto. These
 * helpers are the only place OAuth secrets are turned into ciphertext; nothing
 * here logs.
 */

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

const encryptJson = (value: unknown, key: string): string =>
  encryptField(JSON.stringify(value), key, { keyName: KEY_NAME });

const decryptJson = <T>(ciphertext: string, key: string): T =>
  JSON.parse(decryptField(ciphertext, key, { keyName: KEY_NAME })) as T;

export const encryptOauthClientConfig = (config: StoredOauthClientConfig, key: string): string =>
  encryptJson(config, key);

export const decryptOauthClientConfig = (ciphertext: string, key: string): StoredOauthClientConfig =>
  decryptJson<StoredOauthClientConfig>(ciphertext, key);

export const encryptOauthTokens = (tokens: StoredOauthTokens, key: string): string =>
  encryptJson(tokens, key);

export const decryptOauthTokens = (ciphertext: string, key: string): StoredOauthTokens =>
  decryptJson<StoredOauthTokens>(ciphertext, key);

export const encryptOauthFlow = (flow: StoredOauthFlow, key: string): string => encryptJson(flow, key);

export const decryptOauthFlow = (ciphertext: string, key: string): StoredOauthFlow =>
  decryptJson<StoredOauthFlow>(ciphertext, key);
