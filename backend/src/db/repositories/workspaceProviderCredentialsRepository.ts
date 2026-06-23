import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
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

const credentialColumns = ["workspace_id", "provider", "ciphertext", "created_at", "updated_at"] as const;
const credentialSummaryColumns = ["workspace_id", "provider", "updated_at"] as const;

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
  constructor(private readonly db: Db) {}

  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: LlmProviderName,
  ): Promise<WorkspaceProviderCredentialRecord | null> {
    const row = await this.db
      .selectFrom("workspace_provider_credentials")
      .select(credentialColumns)
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", provider)
      .executeTakeFirst();

    return row ? mapRecord(row as CredentialRow) : null;
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]> {
    const rows = await this.db
      .selectFrom("workspace_provider_credentials")
      .select(credentialSummaryColumns)
      .where("workspace_id", "=", workspaceId)
      .orderBy("provider", "asc")
      .execute();

    return rows.map((row) => mapSummary(row as CredentialSummaryRow));
  }

  async upsert(input: {
    workspaceId: string;
    provider: LlmProviderName;
    ciphertext: string;
  }): Promise<WorkspaceProviderCredentialRecord> {
    const row = await this.db
      .insertInto("workspace_provider_credentials")
      .values({
        workspace_id: input.workspaceId,
        provider: input.provider,
        ciphertext: input.ciphertext,
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", "provider"]).doUpdateSet((eb) => ({
          ciphertext: eb.ref("excluded.ciphertext"),
          updated_at: currentTimestamp(),
        })),
      )
      .returning(credentialColumns)
      .executeTakeFirstOrThrow();

    return mapRecord(row as CredentialRow);
  }

  async remove(workspaceId: string, provider: LlmProviderName): Promise<boolean> {
    const result = await this.db
      .deleteFrom("workspace_provider_credentials")
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", provider)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }
}
