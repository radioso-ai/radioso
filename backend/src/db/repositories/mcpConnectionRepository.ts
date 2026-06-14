import { randomUUID } from "node:crypto";

import type { Database } from "../../shared/infra/database.js";
import type { McpAuthMethod, McpConnectionStatus } from "../../modules/externalSkills/domain.js";

export interface McpConnectionRecord {
  id: string;
  agentId: string;
  displayName: string;
  serverUrl: string;
  authMethod: McpAuthMethod;
  credentialCiphertext: string | null;
  encryptionKeyId: string | null;
  oauthClientCiphertext: string | null;
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
  status: row.status,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const COLUMNS =
  "id, agent_id, display_name, server_url, auth_method, credential_ciphertext, encryption_key_id, oauth_client_ciphertext, status, created_at, updated_at";

export interface McpConnectionRepositoryPort {
  create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord>;
  findById(agentId: string, id: string): Promise<McpConnectionRecord | null>;
  listByAgent(agentId: string): Promise<McpConnectionRecord[]>;
  updateStatus(agentId: string, id: string, status: McpConnectionStatus): Promise<McpConnectionRecord | null>;
  update(agentId: string, id: string, input: UpdateMcpConnectionInput): Promise<McpConnectionRecord | null>;
  remove(agentId: string, id: string): Promise<boolean>;
}

export class McpConnectionRepository implements McpConnectionRepositoryPort {
  constructor(private readonly database: Database) {}

  async create(input: CreateMcpConnectionInput): Promise<McpConnectionRecord> {
    const [row] = await this.database.query<McpConnectionRow>(
      `INSERT INTO mcp_connections
         (id, agent_id, display_name, server_url, auth_method, credential_ciphertext, encryption_key_id, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.agentId,
        input.displayName,
        input.serverUrl,
        input.authMethod,
        input.credentialCiphertext ?? null,
        input.encryptionKeyId ?? null,
        input.status ?? "unconfigured",
      ],
    );
    return mapRecord(row);
  }

  async findById(agentId: string, id: string): Promise<McpConnectionRecord | null> {
    const [row] = await this.database.query<McpConnectionRow>(
      `SELECT ${COLUMNS} FROM mcp_connections WHERE agent_id = $1 AND id = $2`,
      [agentId, id],
    );
    return row ? mapRecord(row) : null;
  }

  async listByAgent(agentId: string): Promise<McpConnectionRecord[]> {
    const rows = await this.database.query<McpConnectionRow>(
      `SELECT ${COLUMNS} FROM mcp_connections WHERE agent_id = $1 ORDER BY created_at ASC`,
      [agentId],
    );
    return rows.map(mapRecord);
  }

  async updateStatus(
    agentId: string,
    id: string,
    status: McpConnectionStatus,
  ): Promise<McpConnectionRecord | null> {
    const [row] = await this.database.query<McpConnectionRow>(
      `UPDATE mcp_connections SET status = $3, updated_at = NOW()
       WHERE agent_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [agentId, id, status],
    );
    return row ? mapRecord(row) : null;
  }

  async update(
    agentId: string,
    id: string,
    input: UpdateMcpConnectionInput,
  ): Promise<McpConnectionRecord | null> {
    const [row] = await this.database.query<McpConnectionRow>(
      `UPDATE mcp_connections SET
         display_name = COALESCE($3, display_name),
         credential_ciphertext = COALESCE($4, credential_ciphertext),
         encryption_key_id = COALESCE($5, encryption_key_id),
         status = COALESCE($6, status),
         updated_at = NOW()
       WHERE agent_id = $1 AND id = $2
       RETURNING ${COLUMNS}`,
      [agentId, id, input.displayName ?? null, input.credentialCiphertext ?? null, input.encryptionKeyId ?? null, input.status ?? null],
    );
    return row ? mapRecord(row) : null;
  }

  async remove(agentId: string, id: string): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM mcp_connections WHERE agent_id = $1 AND id = $2`,
      [agentId, id],
    );
    return affected > 0;
  }
}
