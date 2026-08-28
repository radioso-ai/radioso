import type { AppLogger } from "../../../shared/observability/logger.js";
import { fetchPublicUrl } from "../../../shared/infra/http/publicUrlFetch.js";
import type { OauthCredentialRecord, OauthReauthStatus } from "../domain.js";
import {
  isAccessTokenExpired,
  OauthClientError,
  refreshAccessToken,
  type FetchLike,
} from "./oauthClient.js";
import {
  decryptOauthClientConfig,
  decryptOauthTokens,
  encryptOauthTokens,
} from "./oauthCrypto.js";
import {
  defaultOauthRefreshCoordinator,
  type OauthRefreshCoordinator,
} from "./oauthRefreshCoordinator.js";

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
  /**
   * Serializes refreshes for the same connection. Defaults to a shared
   * in-process single-flight coordinator; injectable for tests.
   */
  refreshCoordinator?: OauthRefreshCoordinator;
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
  const coordinator = input.refreshCoordinator ?? defaultOauthRefreshCoordinator;
  // Single-flight the refresh so concurrent callers for this connection spend the
  // rotating refresh token exactly once instead of racing each other into a
  // spurious needs_reauth.
  return coordinator.coordinate(`${subjectId}:${record.id}`, async () => {
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
    } catch (error) {
      // A transient failure (5xx / 429 / network / timeout) leaves the stored
      // credential intact: surface it as a retryable error and keep the
      // connection authorized rather than forcing a manual re-authorization for
      // a momentary provider blip. Only permanent failures (4xx invalid_grant,
      // missing refresh token) flip the connection to needs_reauth.
      if (error instanceof OauthClientError && error.retryable) {
        input.logger?.warn(
          { event: "integration.oauth", phase: "refresh_failed_transient", subjectId, connectionId: record.id, ...input.logContext },
          "OAuth token refresh failed transiently; leaving connection authorized for retry",
        );
        throw error;
      }
      await repository.updateStatus(subjectId, record.id, "needs_reauth").catch(() => undefined);
      input.logger?.warn(
        { event: "integration.oauth", phase: "refresh_failed", subjectId, connectionId: record.id, ...input.logContext },
        "OAuth token refresh failed; connection needs re-authorization",
      );
      throw new OauthNotAuthorizedError("OAuth token refresh failed");
    }
  });
};

const defaultFetch: FetchLike = async (url, init) => {
  const response = await fetchPublicUrl(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};
