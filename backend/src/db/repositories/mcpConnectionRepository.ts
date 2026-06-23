import { randomUUID } from "node:crypto";

import type { McpAuthMethod, McpConnectionStatus } from "../../modules/externalSkills/domain.js";
import { currentTimestamp, tableExists } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";

export interface McpConnectionRecord {
  id: string;
  agentId: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  credentialCiphertext: string | null;
  encryptionKeyId: string | null;
  oauthClientCiphertext: string | null;
  oauthFlowCiphertext: string | null;
  status: McpConnectionStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpConnectionInput {
  agentId: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  credentialCiphertext?: string | null;
  encryptionKeyId?: string | null;
  oauthClientCiphertext?: string | null;
  status?: McpConnectionStatus;
}

export interface UpdateMcpConnectionInput {
  displayName?: string;
  credentialCiphertext?: string;
  encryptionKeyId?: string;
  status?: McpConnectionStatus;
}

interface McpConnectionRow {
  id: string;
  agent_id: string;
  display_name: string;
  server_url: string;
  auth_method: McpAuthMethod;
  credential_ciphertext: string | null;
  encryption_key_id: string | null;
  oauth_client_ciphertext: string | null;
  oauth_flow_ciphertext: string | null;
  status: McpConnectionStatus;
  created_at: Date;
  updated_at: Date;
}

const mapRecord = (row: McpConnectionRow): McpConnectionRecord => ({
  id: row.id,
  agentId: row.agent_id,
  displayName: row.display_name,
  serverUrl: row.server_url,
  authMethod: row.auth_method,
  credentialCiphertext: row.credential_ciphertext,
  encryptionKeyId: row.encryption_key_id,
  oauthClientCiphertext: row.oauth_client_ciphertext,
  oauthFlowCiphertext: row.oauth_flow_ciphertext,
  status: row.status,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

export const mcpConnectionColumns = [
  "id",
  "agent_id",
  "display_name",
  "server_url",
  "auth_method",
  "credential_ciphertext",
  "encryption_key_id",
  "oauth_client_ciphertext",
  "oauth_flow_ciphertext",
  "status",
  "created_at",
  "updated_at",
] as const;

export interface McpConnectionRepositoryPort {
  create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord>;
  findById(agentId: string, id: string): Promise<McpConnectionRecord | null>;
  listByAgent(agentId: string): Promise<McpConnectionRecord[]>;
  updateStatus(agentId: string, id: string, status: McpConnectionStatus): Promise<McpConnectionRecord | null>;
  update(agentId: string, id: string, input: UpdateMcpConnectionInput): Promise<McpConnectionRecord | null>;
  setOauthFlow(agentId: string, id: string, oauthFlowCiphertext: string): Promise<McpConnectionRecord | null>;
  setOauthTokens(
    agentId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
  ): Promise<McpConnectionRecord | null>;
  remove(agentId: string, id: string): Promise<boolean>;
}

export class McpConnectionRepository implements McpConnectionRepositoryPort {
  constructor(private readonly db: Db) {}

  async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
    const row = await this.db
      .insertInto("mcp_connections")
      .values({
        id: randomUUID(),
        agent_id: input.agentId,
        display_name: input.displayName,
        server_url: input.serverUrl,
        auth_method: input.authMethod,
        credential_ciphertext: input.credentialCiphertext ?? null,
        encryption_key_id: input.encryptionKeyId ?? null,
        oauth_client_ciphertext: input.oauthClientCiphertext ?? null,
        status: input.status ?? "unconfigured",
      })
      .returning(mcpConnectionColumns)
      .executeTakeFirstOrThrow();
    return mapRecord(row as McpConnectionRow);
  }

  /** Persist the in-flight authorization (PKCE/state); sets status back to unconfigured. */
  async setOauthFlow(
    agentId: string,
    id: string,
    oauthFlowCiphertext: string,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({ oauth_flow_ciphertext: oauthFlowCiphertext, updated_at: currentTimestamp() })
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  /** Store freshly issued/refreshed OAuth tokens, mark authorized, and clear the flow. */
  async setOauthTokens(
    agentId: string,
    id: string,
    credentialCiphertext: string,
    encryptionKeyId: string | null,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({
        credential_ciphertext: credentialCiphertext,
        encryption_key_id: encryptionKeyId,
        oauth_flow_ciphertext: null,
        status: "authorized",
        updated_at: currentTimestamp(),
      })
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async findById(agentId: string, id: string): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .selectFrom("mcp_connections")
      .select(mcpConnectionColumns)
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async listByAgent(agentId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.db
      .selectFrom("mcp_connections")
      .select(mcpConnectionColumns)
      .where("agent_id", "=", agentId)
      .orderBy("created_at", "asc")
      .execute();
    return rows.map((row) => mapRecord(row as McpConnectionRow));
  }

  async updateStatus(
    agentId: string,
    id: string,
    status: McpConnectionStatus,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({ status, updated_at: currentTimestamp() })
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateMcpConnectionInput,
  ): Promise<McpConnectionRecord | null> {
    const row = await this.db
      .updateTable("mcp_connections")
      .set({
        ...(input.displayName !== undefined ? { display_name: input.displayName } : {}),
        ...(input.credentialCiphertext !== undefined ? { credential_ciphertext: input.credentialCiphertext } : {}),
        ...(input.encryptionKeyId !== undefined ? { encryption_key_id: input.encryptionKeyId } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        updated_at: currentTimestamp(),
      })
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .returning(mcpConnectionColumns)
      .executeTakeFirst();
    return row ? mapRecord(row as McpConnectionRow) : null;
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    // Guard mirrors the original: only check references when agent_skills exists (it may be
    // absent in a partially-migrated schema), then soft-block the delete if still referenced.
    if (await tableExists(this.db, "agent_skills")) {
      const reference = await this.db
        .selectFrom("agent_skills")
        .select(({ fn }) => fn.count<string>("id").as("count"))
        .where("kind", "=", "external_mcp")
        .where("agent_id", "=", agentId)
        .where("target_type", "=", "mcp_connection")
        .where("target_id", "=", id)
        .executeTakeFirst();
      if (Number(reference?.count ?? 0) > 0) {
        const error = new Error("MCP connection is still referenced by skills") as Error & { code?: string };
        error.code = "23503";
        throw error;
      }
    }

    const result = await this.db
      .deleteFrom("mcp_connections")
      .where("agent_id", "=", agentId)
      .where("id", "=", id)
      .executeTakeFirst();
    return Number(result.numDeletedRows) > 0;
  }
}
