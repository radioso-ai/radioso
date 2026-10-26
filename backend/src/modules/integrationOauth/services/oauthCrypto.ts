import {
  encryptField,
  decryptField,
  type FieldEncryptionKeys,
} from "../../../shared/infra/crypto/fieldEncryption.js";
import type { StoredOauthClientConfig, StoredOauthFlow, StoredOauthTokens } from "../domain.js";

const KEY_NAME = "CONNECTOR_ENCRYPTION_KEY";

const encryptJson = (value: unknown, key: FieldEncryptionKeys): string =>
  encryptField(JSON.stringify(value), key, { keyName: KEY_NAME });

const decryptJson = <T>(ciphertext: string, key: FieldEncryptionKeys): T =>
  JSON.parse(decryptField(ciphertext, key, { keyName: KEY_NAME })) as T;

export const encryptOauthClientConfig = (config: StoredOauthClientConfig, key: FieldEncryptionKeys): string =>
  encryptJson(config, key);

export const decryptOauthClientConfig = (ciphertext: string, key: FieldEncryptionKeys): StoredOauthClientConfig =>
  decryptJson<StoredOauthClientConfig>(ciphertext, key);

export const encryptOauthTokens = (tokens: StoredOauthTokens, key: FieldEncryptionKeys): string =>
  encryptJson(tokens, key);

export const decryptOauthTokens = (ciphertext: string, key: FieldEncryptionKeys): StoredOauthTokens =>
  decryptJson<StoredOauthTokens>(ciphertext, key);

export const encryptOauthFlow = (flow: StoredOauthFlow, key: FieldEncryptionKeys): string => encryptJson(flow, key);

export const decryptOauthFlow = (ciphertext: string, key: FieldEncryptionKeys): StoredOauthFlow =>
  decryptJson<StoredOauthFlow>(ciphertext, key);
