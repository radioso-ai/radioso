import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type {
  OauthAuthorizationStartResult,
  OauthConnectionCreateInput,
  OauthConnectionSummary,
  StoredOauthClientConfig,
  StoredOauthFlow,
} from "../domain.js";
import {
  buildAuthorizationUrl,
  createPkcePair,
  exchangeAuthorizationCodeWithMetadata,
  type FetchLike,
  type OauthTokenResponseNormalizer,
} from "./oauthClient.js";
import {
  decryptOauthClientConfig,
  decryptOauthFlow,
  encryptOauthClientConfig,
  encryptOauthFlow,
  encryptOauthTokens,
} from "./oauthCrypto.js";
import type {
  OauthConnectionRecord,
  OauthConnectionRepositoryPort,
} from "../../../db/repositories/oauthConnectionRepository.js";
import { badRequest, notFound, serviceUnavailable } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";

export interface OauthProviderDefinition {
  id: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  defaultScopes: string[];
  allowedScopes?: string[];
  tokenResponseNormalizer?: OauthTokenResponseNormalizer;
}

export interface OauthProviderRegistryPort {
  get(provider: string): OauthProviderDefinition | null;
}

export class StaticOauthProviderRegistry implements OauthProviderRegistryPort {
  private readonly providers: Map<string, OauthProviderDefinition>;

  constructor(providers: OauthProviderDefinition[]) {
    this.providers = new Map(providers.map((provider) => [provider.id, provider]));
  }

  get(provider: string): OauthProviderDefinition | null {
    return this.providers.get(provider) ?? null;
  }
}

export interface OauthConnectionServiceOptions {
  repository: OauthConnectionRepositoryPort;
  providers: OauthProviderRegistryPort;
  encryptionKey?: string;
  appBaseUrl?: string;
  fetchImpl?: FetchLike;
  assertPublicUrl?: (url: string) => Promise<void> | void;
  logger?: Pick<AppLogger, "info" | "warn">;
}

interface SignedStatePayload {
  v: 1;
  provider: string;
  workspaceId: string;
  connectionId: string;
  nonce: string;
}

const CALLBACK_PATH_PREFIX = "/api/v1/oauth/callback";
const FRONTEND_CALLBACK_PATH = "/oauth/connections/callback";

const toSummary = (record: OauthConnectionRecord): OauthConnectionSummary => ({
  id: record.id,
  provider: record.provider,
  displayName: record.displayName,
  status: record.status,
  grantedScopes: record.grantedScopes,
  providerAccountId: record.providerAccountId,
  updatedAt: record.updatedAt.toISOString(),
});

const normalizeBaseUrl = (baseUrl?: string): string | null => {
  if (!baseUrl) {
    return null;
  }
  return baseUrl.replace(/\/$/, "");
};

const encodePayload = (payload: SignedStatePayload): string =>
  Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");

const decodePayload = (encoded: string): SignedStatePayload => {
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Partial<SignedStatePayload>;
    if (
      parsed.v !== 1 ||
      typeof parsed.provider !== "string" ||
      typeof parsed.workspaceId !== "string" ||
      typeof parsed.connectionId !== "string" ||
      typeof parsed.nonce !== "string"
    ) {
      throw new Error("Invalid OAuth state payload");
    }
    return parsed as SignedStatePayload;
  } catch {
    throw badRequest("Invalid OAuth state");
  }
};

export class OauthConnectionService {
  constructor(private readonly options: OauthConnectionServiceOptions) {}

  async create(
    workspaceId: string,
    input: OauthConnectionCreateInput,
  ): Promise<OauthAuthorizationStartResult> {
    const provider = this.requireProvider(input.provider);
    const scopes = this.resolveScopes(provider, input.requestedScopes);
    const key = this.requireEncryptionKey();
    await this.options.assertPublicUrl?.(provider.authorizationEndpoint);
    await this.options.assertPublicUrl?.(provider.tokenEndpoint);
    const config: StoredOauthClientConfig = {
      authorizationEndpoint: provider.authorizationEndpoint,
      tokenEndpoint: provider.tokenEndpoint,
      clientId: provider.clientId,
      ...(provider.clientSecret ? { clientSecret: provider.clientSecret } : {}),
      scopes,
    };
    const record = await this.options.repository.create({
      workspaceId,
      provider: provider.id,
      displayName: input.displayName,
      grantedScopes: scopes,
      oauthClientCiphertext: encryptOauthClientConfig(config, key),
      status: "pending",
    });
    return this.startAuthorizationForRecord(record, provider, config, key);
  }

  async get(workspaceId: string, connectionId: string): Promise<OauthConnectionSummary> {
    return toSummary(await this.requireConnection(workspaceId, connectionId));
  }

  async list(workspaceId: string): Promise<OauthConnectionSummary[]> {
    const records = await this.options.repository.listByWorkspace(workspaceId);
    return records.map(toSummary);
  }

  async reauthorize(workspaceId: string, connectionId: string): Promise<OauthAuthorizationStartResult> {
    const key = this.requireEncryptionKey();
    const record = await this.requireConnection(workspaceId, connectionId);
    const provider = this.requireProvider(record.provider);
    if (!record.oauthClientCiphertext) {
      throw badRequest("OAuth client configuration is missing");
    }
    const config = decryptOauthClientConfig(record.oauthClientCiphertext, key);
    return this.startAuthorizationForRecord(record, provider, config, key);
  }

  async completeCallback(providerId: string, input: { code: string; state: string }): Promise<{
    redirectUrl: string;
    connection: OauthConnectionSummary;
  }> {
    const key = this.requireEncryptionKey();
    const provider = this.requireProvider(providerId);
    const statePayload = this.verifyState(input.state, key);
    if (statePayload.provider !== provider.id) {
      throw badRequest("OAuth state provider mismatch");
    }
    const record = await this.requireConnection(statePayload.workspaceId, statePayload.connectionId);
    if (record.provider !== provider.id) {
      throw badRequest("OAuth connection provider mismatch");
    }
    if (!record.oauthClientCiphertext || !record.oauthFlowCiphertext) {
      throw badRequest("OAuth authorization was not started");
    }

    const config = decryptOauthClientConfig(record.oauthClientCiphertext, key);
    const flow = decryptOauthFlow(record.oauthFlowCiphertext, key);
    if (flow.state !== input.state) {
      throw badRequest("OAuth state mismatch");
    }

    const tokens = await exchangeAuthorizationCodeWithMetadata({
      config,
      code: input.code,
      codeVerifier: flow.codeVerifier,
      redirectUri: flow.redirectUri,
      fetchImpl: this.options.fetchImpl ?? globalThis.fetch,
      tokenResponseNormalizer: provider.tokenResponseNormalizer,
    });
    const grantedScopes = tokens.tokens.scope?.split(/\s+/).filter(Boolean) ?? config.scopes ?? record.grantedScopes;
    const updated = await this.options.repository.setOauthTokens(
      record.workspaceId,
      record.id,
      encryptOauthTokens(tokens.tokens, key),
      null,
      grantedScopes,
      tokens.providerAccountId ?? null,
    );
    if (!updated) {
      throw notFound("OAuth connection not found");
    }

    this.options.logger?.info(
      { event: "integration_oauth", phase: "authorized", provider: provider.id, workspaceId: record.workspaceId, connectionId: record.id },
      "workspace OAuth connection authorized",
    );
    return {
      redirectUrl: this.buildFrontendRedirect(updated, "authorized"),
      connection: toSummary(updated),
    };
  }

  private async startAuthorizationForRecord(
    record: OauthConnectionRecord,
    provider: OauthProviderDefinition,
    config: StoredOauthClientConfig,
    key: string,
  ): Promise<OauthAuthorizationStartResult> {
    const baseUrl = normalizeBaseUrl(this.options.appBaseUrl);
    if (!baseUrl) {
      throw serviceUnavailable("APP_BASE_URL must be set so OAuth connections have a redirect URI");
    }
    const redirectUri = `${baseUrl}${CALLBACK_PATH_PREFIX}/${encodeURIComponent(provider.id)}`;
    const state = this.signState(
      {
        v: 1,
        provider: provider.id,
        workspaceId: record.workspaceId,
        connectionId: record.id,
        nonce: randomBytes(16).toString("base64url"),
      },
      key,
    );
    const pkce = createPkcePair();
    const flow: StoredOauthFlow = {
      state,
      codeVerifier: pkce.codeVerifier,
      redirectUri,
    };
    await this.options.repository.setOauthFlow(record.workspaceId, record.id, encryptOauthFlow(flow, key));
    this.options.logger?.info(
      { event: "integration_oauth", phase: "authorize_started", provider: provider.id, workspaceId: record.workspaceId, connectionId: record.id },
      "workspace OAuth authorization started",
    );
    return {
      connectionId: record.id,
      authorizationUrl: buildAuthorizationUrl({ config, redirectUri, state, codeChallenge: pkce.codeChallenge }),
      status: "pending",
    };
  }

  private requireProvider(providerId: string): OauthProviderDefinition {
    const provider = this.options.providers.get(providerId);
    if (!provider) {
      throw badRequest("Unsupported OAuth provider");
    }
    return provider;
  }

  private resolveScopes(provider: OauthProviderDefinition, requestedScopes?: string[]): string[] {
    const scopes = requestedScopes?.length ? requestedScopes : provider.defaultScopes;
    const allowed = new Set(provider.allowedScopes ?? provider.defaultScopes);
    const unsupported = scopes.filter((scope) => !allowed.has(scope));
    if (unsupported.length > 0) {
      throw badRequest("Unsupported OAuth scopes", { scopes: unsupported });
    }
    return scopes;
  }

  private requireEncryptionKey(): string {
    if (!this.options.encryptionKey) {
      throw serviceUnavailable("CONNECTOR_ENCRYPTION_KEY must be set before saving OAuth credentials");
    }
    return this.options.encryptionKey;
  }

  private async requireConnection(workspaceId: string, connectionId: string): Promise<OauthConnectionRecord> {
    const record = await this.options.repository.findById(workspaceId, connectionId);
    if (!record) {
      throw notFound("OAuth connection not found");
    }
    return record;
  }

  private signState(payload: SignedStatePayload, key: string): string {
    const encoded = encodePayload(payload);
    const signature = createHmac("sha256", key).update(encoded).digest("base64url");
    return `${encoded}.${signature}`;
  }

  private verifyState(state: string, key: string): SignedStatePayload {
    const [encoded, signature, extra] = state.split(".");
    if (!encoded || !signature || extra !== undefined) {
      throw badRequest("Invalid OAuth state");
    }
    const expected = createHmac("sha256", key).update(encoded).digest("base64url");
    const actualBuffer = Buffer.from(signature, "base64url");
    const expectedBuffer = Buffer.from(expected, "base64url");
    if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
      throw badRequest("Invalid OAuth state");
    }
    return decodePayload(encoded);
  }

  private buildFrontendRedirect(record: OauthConnectionRecord, status: "authorized"): string {
    const baseUrl = normalizeBaseUrl(this.options.appBaseUrl) ?? "";
    const url = new URL(`${baseUrl}${FRONTEND_CALLBACK_PATH}`);
    url.searchParams.set("provider", record.provider);
    url.searchParams.set("connectionId", record.id);
    url.searchParams.set("status", status);
    return url.toString();
  }
}
