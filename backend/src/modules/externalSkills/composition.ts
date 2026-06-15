import { createToolSkillExecutor } from "@radioso/conversation-tools";

import type { Database } from "../../shared/infra/database.js";
import { decryptField } from "../../shared/infra/crypto/fieldEncryption.js";
import { McpConnectionRepository } from "../../db/repositories/mcpConnectionRepository.js";
import { ExternalSkillDefinitionRepository } from "../../db/repositories/externalSkillDefinitionRepository.js";
import { SdkMcpToolService } from "./toolService/sdkMcpToolService.js";
import type {
  ConnectionLookup,
  McpConnectionRecord,
  McpSkillExecutorDeps,
  ToolServiceFactory,
} from "./executor/mcpSkillExecutor.js";

/**
 * Builds a ToolService for a connection. Access-token connections present a
 * bearer header; OAuth (P2) will pass an SDK `authProvider` here instead. The
 * spine stays auth-agnostic — only this factory knows how a credential becomes
 * a request.
 */
export const createMcpToolServiceFactory = (
  assertPublicUrl?: (url: string) => void | Promise<void>,
): ToolServiceFactory => ({
  create: (connection: McpConnectionRecord): SdkMcpToolService =>
    new SdkMcpToolService({
      serverUrl: connection.serverUrl,
      credentialProvider: connection.accessToken
        ? { getRequestHeaders: async () => ({ Authorization: `Bearer ${connection.accessToken}` }) }
        : undefined,
      assertPublicUrl,
    }),
});

/**
 * Connection lookup over the repository that decrypts the stored credential into
 * the lightweight record the executor/factory consume. The plaintext token lives
 * only in memory for the call and is never logged.
 */
export class LiveMcpConnectionLookup implements ConnectionLookup {
  constructor(
    private readonly repository: McpConnectionRepository,
    private readonly encryptionKey: string,
  ) {}

  async findById(agentId: string, connectionId: string): Promise<McpConnectionRecord | null> {
    const record = await this.repository.findById(agentId, connectionId);
    if (!record) {
      return null;
    }
    const accessToken =
      record.authMethod === "access_token" && record.credentialCiphertext
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
): McpSkillExecutorDeps => ({
  skills: new ExternalSkillDefinitionRepository(database),
  connections: new LiveMcpConnectionLookup(new McpConnectionRepository(database), encryptionKey),
  toolServices: createMcpToolServiceFactory(assertPublicUrl),
  // The transport-agnostic ToolSkillBridge factory, injected from composition so the
  // executor stays free of a direct conversation-tools (concrete) dependency.
  toolSkillExecutorFactory: createToolSkillExecutor,
});
