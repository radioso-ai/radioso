import { AppError, conflict, notFound } from "../../../shared/domain/errors.js";
import { encryptField, decryptField } from "../../../shared/infra/crypto/fieldEncryption.js";
import type {
  McpConnectionRecord,
  McpConnectionRepositoryPort,
} from "../../../db/repositories/mcpConnectionRepository.js";
import type { McpConnectionInput, McpConnectionUpdateInput } from "../domain.js";
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
}

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

    const record = await this.options.repository.create({
      agentId,
      displayName: input.displayName,
      serverUrl: input.serverUrl,
      authMethod: input.authMethod,
      credentialCiphertext,
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
    const accessToken =
      record.authMethod === "access_token" && record.credentialCiphertext && this.options.encryptionKey
        ? decryptField(record.credentialCiphertext, this.options.encryptionKey)
        : undefined;

    const service = this.options.toolServiceFactory.create({
      id: record.id,
      serverUrl: record.serverUrl,
      authMethod: record.authMethod,
      ...(accessToken ? { accessToken } : {}),
    });
    try {
      const tools = await service.listTools();
      return tools.map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema }));
    } finally {
      await (service as { close?: () => Promise<void> }).close?.().catch(() => undefined);
    }
  }
}
