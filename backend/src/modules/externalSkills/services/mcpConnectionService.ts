import { AppError, badRequest, conflict, notFound } from "../../../shared/domain/errors.js";
import { encryptField, decryptField } from "../../../shared/infra/crypto/fieldEncryption.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import {
  buildAuthorizationUrl,
  createOauthState,
  createPkcePair,
  decryptOauthClientConfig,
  decryptOauthFlow,
  encryptOauthClientConfig,
  encryptOauthFlow,
  encryptOauthTokens,
  exchangeAuthorizationCode,
  resolveFreshAccessToken,
  type FetchLike,
} from "../../integrationOauth/public.js";
import type {
  McpConnectionRecord,
  McpConnectionRepositoryPort,
} from "../../../db/repositories/mcpConnectionRepository.js";
import type { McpConnectionInput, McpConnectionUpdateInput, StoredOauthClientConfig } from "../domain.js";
import type { ToolServiceFactory } from "../executor/mcpSkillExecutor.js";

/** Non-secret view of a connection (the only shape returned to clients). */
export interface McpConnectionSummary {
  id: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpConnectionRecord["authMethod"];
  status: McpConnectionRecord["status"];
  hasCredential: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface DiscoveredTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

const toSummary = (record: McpConnectionRecord): McpConnectionSummary => ({
  id: record.id,
  displayName: record.displayName,
  serverUrl: record.serverUrl,
  authMethod: record.authMethod,
  status: record.status,
  hasCredential: Boolean(record.credentialCiphertext),
  createdAt: record.createdAt.toISOString(),
  updatedAt: record.updatedAt.toISOString(),
});

export class EncryptionNotConfiguredError extends AppError {
  constructor() {
    super(
      503,
      "encryption_not_configured",
      "CONNECTOR_ENCRYPTION_KEY must be set before storing MCP connection credentials",
    );
  }
}

export interface McpConnectionServiceOptions {
  repository: McpConnectionRepositoryPort;
  toolServiceFactory: ToolServiceFactory;
  encryptionKey?: string;
  encryptionKeyId?: string;
  /**
   * Public-URL / SSRF guard, enforced on create AND before every outbound
   * connection. Rejects loopback/private/link-local hosts and resolves DNS, so a
   * user cannot point a connection at internal infrastructure.
   */
  assertPublicUrl?: (url: string) => void | Promise<void>;
  /**
   * Absolute redirect URI registered with OAuth providers (the front-end callback
   * page). Required to start an OAuth authorization. Derived from APP_BASE_URL in
   * composition.
   */
  oauthRedirectUri?: string;
  /** Injectable token-endpoint fetch (defaults to global fetch); test seam. */
  fetchImpl?: FetchLike;
  /** Optional logger for status-transition signals (identity-only, no secrets). */
  logger?: AppLogger;
}

/** Adapt Node's global fetch to the narrow {@link FetchLike} the OAuth client expects. */
const globalFetchAdapter: FetchLike = async (url, init) => {
  const response = await fetch(url, {
    method: init.method,
    headers: init.headers,
    body: init.body,
    signal: init.signal,
  });
  return { ok: response.ok, status: response.status, json: () => response.json() };
};

/**
 * Owns the connection lifecycle: encrypts credentials on write, never returns
 * them (summaries only), and discovers a server's tools by building the MCP
 * client with the decrypted credential. The encryption key never leaves this
 * layer.
 */
export class McpConnectionService {
  constructor(private readonly options: McpConnectionServiceOptions) {}

  isEncryptionConfigured(): boolean {
    return Boolean(this.options.encryptionKey);
  }

  async create(agentId: string, input: McpConnectionInput): Promise<McpConnectionSummary> {
    // SSRF guard: reject loopback/private/internal targets before persisting.
    await this.options.assertPublicUrl?.(input.serverUrl);

    let credentialCiphertext: string | null = null;
    let oauthClientCiphertext: string | null = null;
    let encryptionKeyId: string | null = null;
    let status: McpConnectionRecord["status"] = "unconfigured";

    if (input.authMethod === "access_token") {
      if (!input.accessToken) {
        throw new Error("accessToken is required for access_token connections");
      }
      if (!this.options.encryptionKey) {
        throw new EncryptionNotConfiguredError();
      }
      credentialCiphertext = encryptField(input.accessToken, this.options.encryptionKey);
      encryptionKeyId = this.options.encryptionKeyId ?? null;
      status = "authorized";
    }

    if (input.authMethod === "oauth") {
      if (!input.oauth) {
        throw badRequest("oauth config is required for oauth connections");
      }
      if (!this.options.encryptionKey) {
        throw new EncryptionNotConfiguredError();
      }
      // SSRF guard for the authorization server endpoints too.
      await this.options.assertPublicUrl?.(input.oauth.authorizationEndpoint);
      await this.options.assertPublicUrl?.(input.oauth.tokenEndpoint);
      oauthClientCiphertext = encryptOauthClientConfig(input.oauth, this.options.encryptionKey);
      encryptionKeyId = this.options.encryptionKeyId ?? null;
      // Stays unconfigured until the one-time consent flow completes.
      status = "unconfigured";
    }

    const record = await this.options.repository.create({
      agentId,
      displayName: input.displayName,
      serverUrl: input.serverUrl,
      authMethod: input.authMethod,
      credentialCiphertext,
      oauthClientCiphertext,
      encryptionKeyId,
      status,
    });
    return toSummary(record);
  }

  async list(agentId: string): Promise<McpConnectionSummary[]> {
    return (await this.options.repository.listByAgent(agentId)).map(toSummary);
  }

  async get(agentId: string, id: string): Promise<McpConnectionSummary> {
    const record = await this.options.repository.findById(agentId, id);
    if (!record) {
      throw notFound("MCP connection not found");
    }
    return toSummary(record);
  }

  /** Rename a connection and/or rotate its access token (re-encrypted). */
  async update(agentId: string, id: string, input: McpConnectionUpdateInput): Promise<McpConnectionSummary> {
    const existing = await this.options.repository.findById(agentId, id);
    if (!existing) {
      throw notFound("MCP connection not found");
    }

    let credentialCiphertext: string | undefined;
    let encryptionKeyId: string | undefined;
    let status: McpConnectionRecord["status"] | undefined;
    if (input.accessToken !== undefined) {
      if (existing.authMethod !== "access_token") {
        throw badRequest("accessToken rotation is only valid for access-token connections");
      }
      if (!this.options.encryptionKey) {
        throw new EncryptionNotConfiguredError();
      }
      credentialCiphertext = encryptField(input.accessToken, this.options.encryptionKey);
      encryptionKeyId = this.options.encryptionKeyId ?? undefined;
      status = "authorized";
    }

    const updated = await this.options.repository.update(agentId, id, {
      displayName: input.displayName,
      credentialCiphertext,
      encryptionKeyId,
      status,
    });
    if (!updated) {
      throw notFound("MCP connection not found");
    }
    return toSummary(updated);
  }

  async remove(agentId: string, id: string): Promise<void> {
    let removed: boolean;
    try {
      removed = await this.options.repository.remove(agentId, id);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "23503") {
        throw conflict("Connection is still referenced by a skill definition");
      }
      throw error;
    }
    if (!removed) {
      throw notFound("MCP connection not found");
    }
  }

  /** Live `tools/list` for the skill builder; requires a usable credential. */
  async discoverTools(agentId: string, id: string): Promise<DiscoveredTool[]> {
    const record = await this.options.repository.findById(agentId, id);
    if (!record) {
      throw notFound("MCP connection not found");
    }
    // Re-check immediately before the outbound fetch (defense against a record
    // whose host has since become non-public).
    await this.options.assertPublicUrl?.(record.serverUrl);
    let accessToken: string | undefined;
    let oauthAccessTokenProvider: (() => Promise<string>) | undefined;
    if (record.authMethod === "access_token" && record.credentialCiphertext && this.options.encryptionKey) {
      accessToken = decryptField(record.credentialCiphertext, this.options.encryptionKey);
    }
    if (record.authMethod === "oauth") {
      if (!this.options.encryptionKey) {
        throw new EncryptionNotConfiguredError();
      }
      oauthAccessTokenProvider = () =>
        resolveFreshAccessToken({
          subjectId: agentId,
          record,
          repository: this.options.repository,
          encryptionKey: this.options.encryptionKey!,
          encryptionKeyId: this.options.encryptionKeyId ?? null,
          assertPublicUrl: this.options.assertPublicUrl,
          fetchImpl: this.options.fetchImpl,
          logger: this.options.logger,
          logContext: { integration: "external_skill_mcp", agentId },
        });
    }

    const service = this.options.toolServiceFactory.create({
      id: record.id,
      serverUrl: record.serverUrl,
      authMethod: record.authMethod,
      ...(accessToken ? { accessToken } : {}),
      ...(oauthAccessTokenProvider ? { oauthAccessTokenProvider } : {}),
    });
    try {
      const tools = await service.listTools();
      return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    } finally {
      await (service as { close?: () => Promise<void> }).close?.().catch(() => undefined);
    }
  }

  private requireOauthConnection(record: McpConnectionRecord | null): {
    record: McpConnectionRecord;
    config: StoredOauthClientConfig;
    key: string;
  } {
    if (!record) {
      throw notFound("MCP connection not found");
    }
    if (record.authMethod !== "oauth") {
      throw badRequest("Connection is not an OAuth connection");
    }
    if (!this.options.encryptionKey) {
      throw new EncryptionNotConfiguredError();
    }
    if (!record.oauthClientCiphertext) {
      throw badRequest("OAuth connection is missing its client configuration");
    }
    return {
      record,
      config: decryptOauthClientConfig(record.oauthClientCiphertext, this.options.encryptionKey),
      key: this.options.encryptionKey,
    };
  }

  /**
   * Start the one-time consent flow: generate PKCE + state, persist the in-flight
   * flow, and return the provider authorization URL for the author's browser.
   */
  async startOauthAuthorization(agentId: string, id: string): Promise<{ authorizationUrl: string }> {
    const { record, config, key } = this.requireOauthConnection(
      await this.options.repository.findById(agentId, id),
    );
    const redirectUri = this.options.oauthRedirectUri;
    if (!redirectUri) {
      throw new AppError(
        503,
        "oauth_redirect_not_configured",
        "APP_BASE_URL must be set so MCP OAuth connections have a redirect URI",
      );
    }
    // SSRF re-check immediately before handing the author an outbound URL.
    await this.options.assertPublicUrl?.(config.authorizationEndpoint);
    await this.options.assertPublicUrl?.(config.tokenEndpoint);

    const { codeVerifier, codeChallenge } = createPkcePair();
    const state = createOauthState();
    await this.options.repository.setOauthFlow(
      agentId,
      id,
      encryptOauthFlow({ state, codeVerifier, redirectUri }, key),
    );
    const authorizationUrl = buildAuthorizationUrl({ config, redirectUri, state, codeChallenge });
    this.options.logger?.info(
      { event: "external_skill.oauth", phase: "authorize_started", agentId, connectionId: record.id },
      "MCP OAuth authorization started",
    );
    return { authorizationUrl };
  }

  /**
   * Complete the consent flow: validate state, exchange the code for tokens, store
   * them encrypted, and mark the connection authorized. Sanitized on failure — no
   * provider error text or secret reaches the caller.
   */
  async completeOauthAuthorization(
    agentId: string,
    id: string,
    code: string,
    state: string,
  ): Promise<McpConnectionSummary> {
    const { record, config, key } = this.requireOauthConnection(
      await this.options.repository.findById(agentId, id),
    );
    if (!record.oauthFlowCiphertext) {
      throw badRequest("No pending authorization for this connection");
    }
    const flow = decryptOauthFlow(record.oauthFlowCiphertext, key);
    if (!state || state !== flow.state) {
      throw badRequest("OAuth state mismatch");
    }
    await this.options.assertPublicUrl?.(config.tokenEndpoint);

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode({
        config,
        code,
        codeVerifier: flow.codeVerifier,
        redirectUri: flow.redirectUri,
        fetchImpl: this.options.fetchImpl ?? globalFetchAdapter,
      });
    } catch {
      // Sanitized: do not surface the provider's raw error.
      throw badRequest("Authorization could not be completed");
    }

    const updated = await this.options.repository.setOauthTokens(
      agentId,
      id,
      encryptOauthTokens(tokens, key),
      this.options.encryptionKeyId ?? null,
    );
    if (!updated) {
      throw notFound("MCP connection not found");
    }
    this.options.logger?.info(
      { event: "external_skill.oauth", phase: "authorized", agentId, connectionId: record.id },
      "MCP OAuth connection authorized",
    );
    return toSummary(updated);
  }
}
