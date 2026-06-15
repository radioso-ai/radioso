import type { AppLogger } from "../../../shared/observability/logger.js";
import type { OauthCredentialRecord, OauthReauthStatus } from "../domain.js";
import {
  isAccessTokenExpired,
  refreshAccessToken,
  type FetchLike,
} from "./oauthClient.js";
import {
  decryptOauthClientConfig,
  decryptOauthTokens,
  encryptOauthTokens,
} from "./oauthCrypto.js";

export interface OauthTokenPersistencePort {
  setOauthTokens(
    subjectId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
  ): Promise<OauthCredentialRecord | null>;
  updateStatus(subjectId: string, id: string, status: OauthReauthStatus): Promise<OauthCredentialRecord | null>;
}

export class OauthNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OauthNotAuthorizedError";
  }
}

export interface ResolveFreshAccessTokenInput {
  subjectId: string;
  record: OauthCredentialRecord;
  repository: OauthTokenPersistencePort;
  encryptionKey: string;
  encryptionKeyId?: string | null;
  assertPublicUrl?: (url: string) => void | Promise<void>;
  fetchImpl?: FetchLike;
  logger?: AppLogger;
  logContext?: Record<string, string>;
}

export const resolveFreshAccessToken = async (input: ResolveFreshAccessTokenInput): Promise<string> => {
  const { subjectId, record, repository, encryptionKey } = input;

  if (record.status === "disabled") {
    throw new OauthNotAuthorizedError("OAuth connection is disabled");
  }

  if (!record.credentialCiphertext || !record.oauthClientCiphertext) {
    await repository.updateStatus(subjectId, record.id, "needs_reauth").catch(() => undefined);
    throw new OauthNotAuthorizedError("OAuth connection is not authorized");
  }

  const tokens = decryptOauthTokens(record.credentialCiphertext, encryptionKey);
  if (!isAccessTokenExpired(tokens)) {
    return tokens.accessToken;
  }

  const config = decryptOauthClientConfig(record.oauthClientCiphertext, encryptionKey);
  try {
    await input.assertPublicUrl?.(config.tokenEndpoint);
    const refreshed = await refreshAccessToken({
      config,
      tokens,
      fetchImpl: input.fetchImpl ?? defaultFetch,
    });
    await repository.setOauthTokens(
      subjectId,
      record.id,
      encryptOauthTokens(refreshed, encryptionKey),
      input.encryptionKeyId ?? null,
    );
    input.logger?.info(
      { event: "integration.oauth", phase: "refreshed", subjectId, connectionId: record.id, ...input.logContext },
      "OAuth token refreshed",
    );
    return refreshed.accessToken;
  } catch {
    await repository.updateStatus(subjectId, record.id, "needs_reauth").catch(() => undefined);
    input.logger?.warn(
      { event: "integration.oauth", phase: "refresh_failed", subjectId, connectionId: record.id, ...input.logContext },
      "OAuth token refresh failed; connection needs re-authorization",
    );
    throw new OauthNotAuthorizedError("OAuth token refresh failed");
  }
};

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};
