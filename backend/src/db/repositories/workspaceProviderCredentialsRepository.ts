import type { Database } from "../../shared/infra/database.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";

export interface WorkspaceProviderCredentialRecord {
  workspaceId: string;
  provider: LlmProviderName;
  ciphertext: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceProviderCredentialSummary {
  workspaceId: string;
  provider: LlmProviderName;
  updatedAt: Date;
}

interface CredentialRow {
  workspace_id: string;
  provider: LlmProviderName;
  ciphertext: string;
  created_at: Date;
  updated_at: Date;
}

interface CredentialSummaryRow {
  workspace_id: string;
  provider: LlmProviderName;
  updated_at: Date;
}

const mapRecord = (row: CredentialRow): WorkspaceProviderCredentialRecord => ({
  workspaceId: row.workspace_id,
  provider: row.provider,
  ciphertext: row.ciphertext,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapSummary = (row: CredentialSummaryRow): WorkspaceProviderCredentialSummary => ({
  workspaceId: row.workspace_id,
  provider: row.provider,
  updatedAt: new Date(row.updated_at),
});

export interface WorkspaceProviderCredentialsRepositoryPort {
  findByWorkspaceAndProvider(
    workspaceId: string,
    provider: LlmProviderName,
  ): Promise<WorkspaceProviderCredentialRecord | null>;
  listByWorkspace(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]>;
  upsert(input: {
    workspaceId: string;
    provider: LlmProviderName;
    ciphertext: string;
  }): Promise<WorkspaceProviderCredentialRecord>;
  remove(workspaceId: string, provider: LlmProviderName): Promise<boolean>;
}

export class WorkspaceProviderCredentialsRepository
  implements WorkspaceProviderCredentialsRepositoryPort
{
  constructor(private readonly database: Database) {}

  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: LlmProviderName,
  ): Promise<WorkspaceProviderCredentialRecord | null> {
    const [row] = await this.database.query<CredentialRow>(
      `SELECT workspace_id, provider, ciphertext, created_at, updated_at
       FROM workspace_provider_credentials
       WHERE workspace_id = $1 AND provider = $2`,
      [workspaceId, provider],
    );

    return row ? mapRecord(row) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]> {
    const rows = await this.database.query<CredentialSummaryRow>(
      `SELECT workspace_id, provider, updated_at
       FROM workspace_provider_credentials
       WHERE workspace_id = $1
       ORDER BY provider ASC`,
      [workspaceId],
    );

    return rows.map(mapSummary);
  }

  async upsert(input: {
    workspaceId: string;
    provider: LlmProviderName;
    ciphertext: string;
  }): Promise<WorkspaceProviderCredentialRecord> {
    const [row] = await this.database.query<CredentialRow>(
      `INSERT INTO workspace_provider_credentials (workspace_id, provider, ciphertext)
       VALUES ($1, $2, $3)
       ON CONFLICT (workspace_id, provider)
       DO UPDATE SET ciphertext = EXCLUDED.ciphertext,
                     updated_at = NOW()
       RETURNING workspace_id, provider, ciphertext, created_at, updated_at`,
      [input.workspaceId, input.provider, input.ciphertext],
    );

    return mapRecord(row);
  }

  async remove(workspaceId: string, provider: LlmProviderName): Promise<boolean> {
    const affected = await this.database.execute(
      `DELETE FROM workspace_provider_credentials
       WHERE workspace_id = $1 AND provider = $2`,
      [workspaceId, provider],
    );
    return affected > 0;
  }
}
