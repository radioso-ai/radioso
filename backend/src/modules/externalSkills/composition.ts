import { createToolSkillExecutor } from "@radioso/conversation-tools";

import type { Database } from "../../shared/infra/database.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { decryptField } from "../../shared/infra/crypto/fieldEncryption.js";
import { McpConnectionRepository } from "../../db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../db/repositories/externalSkillDefinitionRepository.js";
import { SdkMcpToolService } from "./toolService/sdkMcpToolService.js";
import { resolveFreshAccessToken } from "../integrationOauth/public.js";
import type {
  ConnectionLookup,
  McpConnectionRecord,
  McpSkillExecutorDeps,
  ToolServiceFactory,
} from "./executor/mcpSkillExecutor.js";

/**
 * Builds a ToolService for a connection. Access-token connections present a static
 * bearer header; OAuth connections present a freshly-resolved bearer token (the
 * lookup's `oauthAccessTokenProvider` refreshes transparently before the call).
 * The spine stays auth-agnostic — only this factory knows how a credential
 * becomes a request header.
 */
export const createMcpToolServiceFactory = (
  assertPublicUrl?: (url: string) => void | Promise<void>,
): ToolServiceFactory => ({
  create: (connection: McpConnectionRecord): SdkMcpToolService => {
    const credentialProvider =
      connection.authMethod === "oauth" && connection.oauthAccessTokenProvider
        ? {
            getRequestHeaders: async () => ({
              Authorization: `Bearer ${await connection.oauthAccessTokenProvider!()}`,
            }),
          }
        : connection.accessToken
          ? { getRequestHeaders: async () => ({ Authorization: `Bearer ${connection.accessToken}` }) }
          : undefined;
    return new SdkMcpToolService({
      serverUrl: connection.serverUrl,
      credentialProvider,
      assertPublicUrl,
    });
  },
});

export interface LiveMcpConnectionLookupOptions {
  fetchImpl?: Parameters<typeof resolveFreshAccessToken>[0]["fetchImpl"];
  logger?: AppLogger;
  encryptionKeyId?: string | null;
  assertPublicUrl?: (url: string) => void | Promise<void>;
}

/**
 * Connection lookup over the repository that decrypts the stored credential into
 * the lightweight record the executor/factory consume. The plaintext token lives
 * only in memory for the call and is never logged. For OAuth connections it
 * attaches a token provider that refreshes-before-call and flags `needs_reauth`
 * on refresh failure.
 */
export class LiveMcpConnectionLookup implements ConnectionLookup {
  constructor(
    private readonly repository: McpConnectionRepository,
    private readonly encryptionKey: string,
    private readonly options: LiveMcpConnectionLookupOptions = {},
  ) {}

  async findById(agentId: string, connectionId: string): Promise<McpConnectionRecord | null> {
    const record = await this.repository.findById(agentId, connectionId);
    if (!record) {
      return null;
    }
    if (record.authMethod === "oauth") {
      return {
        id: record.id,
        serverUrl: record.serverUrl,
        authMethod: record.authMethod,
        oauthAccessTokenProvider: () =>
          resolveFreshAccessToken({
            subjectId: agentId,
            record,
            repository: this.repository,
            encryptionKey: this.encryptionKey,
            encryptionKeyId: this.options.encryptionKeyId ?? null,
            assertPublicUrl: this.options.assertPublicUrl,
            fetchImpl: this.options.fetchImpl,
            logger: this.options.logger,
            logContext: { integration: "external_skill_mcp", agentId },
          }),
      };
    }
    const accessToken = record.credentialCiphertext
      ? decryptField(record.credentialCiphertext, this.encryptionKey)
      : undefined;
    return {
      id: record.id,
      serverUrl: record.serverUrl,
      authMethod: record.authMethod,
      ...(accessToken ? { accessToken } : {}),
    };
  }
}

/**
 * Assembles the executor's ports from the database + encryption key. The
 * skill-definition repository already satisfies `SkillDefinitionLookup`
 * (findEnabledByName); the connection lookup decrypts credentials; the factory
 * builds the MCP client.
 */
export const buildExternalSkillsDeps = (
  database: Database,
  encryptionKey: string,
  assertPublicUrl?: (url: string) => void | Promise<void>,
  options: LiveMcpConnectionLookupOptions = {},
): McpSkillExecutorDeps => ({
  skills: new ExternalSkillDefinitionRepository(database.kysely),
  connections: new LiveMcpConnectionLookup(new McpConnectionRepository(database.kysely), encryptionKey, {
    ...options,
    assertPublicUrl,
  }),
  toolServices: createMcpToolServiceFactory(assertPublicUrl),
  // The transport-agnostic ToolSkillBridge factory, injected from composition so the
  // executor stays free of a direct conversation-tools (concrete) dependency.
  toolSkillExecutorFactory: createToolSkillExecutor,
});
