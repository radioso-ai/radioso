import type { AppLogger } from "../../../shared/observability/logger.js";
import { fetchPublicUrl } from "../../../shared/infra/http/publicUrlFetch.js";
import type { McpConnectionRecord } from "../../../db/repositories/mcpConnectionRepository.js";
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

/** Narrow persistence port the resolver needs to store refreshed tokens / flag re-auth. */
export interface OauthTokenPersistencePort {
  setOauthTokens(
    agentId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
  ): Promise<McpConnectionRecord | null>;
  updateStatus(agentId: string, id: string, status: "needs_reauth"): Promise<McpConnectionRecord | null>;
}

export class OauthNotAuthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OauthNotAuthorizedError";
  }
}

export interface ResolveFreshAccessTokenInput {
  agentId: string;
  record: McpConnectionRecord;
  repository: OauthTokenPersistencePort;
  encryptionKey: string;
  encryptionKeyId?: string | null;
  assertPublicUrl?: (url: string) => void | Promise<void>;
  fetchImpl?: FetchLike;
  logger?: AppLogger;
}

/**
 * Resolve a usable access token for an OAuth connection at call time (US2 AC2/AC3):
 * return the stored token if still valid, otherwise refresh it transparently and
 * persist the result. If refresh fails (or no credential is stored), flag the
 * connection `needs_reauth` and throw so the skill degrades to its failure
 * outcome. Never logs tokens or secrets — identity fields only.
 */
export const resolveFreshAccessToken = async (input: ResolveFreshAccessTokenInput): Promise<string> => {
  const { agentId, record, repository, encryptionKey } = input;

  if (!record.credentialCiphertext || !record.oauthClientCiphertext) {
    await repository.updateStatus(agentId, record.id, "needs_reauth").catch(() => undefined);
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
      agentId,
      record.id,
      encryptOauthTokens(refreshed, encryptionKey),
      input.encryptionKeyId ?? null,
    );
    input.logger?.info(
      { event: "external_skill.oauth", phase: "refreshed", agentId, connectionId: record.id },
      "MCP OAuth token refreshed",
    );
    return refreshed.accessToken;
  } catch {
    await repository.updateStatus(agentId, record.id, "needs_reauth").catch(() => undefined);
    input.logger?.warn(
      { event: "external_skill.oauth", phase: "refresh_failed", agentId, connectionId: record.id },
      "MCP OAuth token refresh failed; connection needs re-authorization",
    );
    throw new OauthNotAuthorizedError("OAuth token refresh failed");
  }
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
