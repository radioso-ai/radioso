import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
import type { VoiceVendor } from "../../shared/domain/voiceVendor.js";
import type { LlmProviderName, OpenAIDataResidency } from "../../shared/infra/llm/providerTypes.js";

/** A third-party account a workspace holds an API key for: a model provider or a voice vendor. */
export type WorkspaceCredentialProvider = LlmProviderName | VoiceVendor;

export interface WorkspaceProviderCredentialRecord {
  workspaceId: string;
  provider: WorkspaceCredentialProvider;
  ciphertext: string;
  /**
   * Meaningful only for `provider: "openai"`; every other provider's row carries the column
   * (it is one table, `NOT NULL DEFAULT 'global'`) but nothing reads it there.
   */
  residency: OpenAIDataResidency;
  createdAt: Date;
  updatedAt: Date;
}

export interface WorkspaceProviderCredentialSummary {
  workspaceId: string;
  provider: WorkspaceCredentialProvider;
  /** See {@link WorkspaceProviderCredentialRecord.residency}. */
  residency: OpenAIDataResidency;
  updatedAt: Date;
}

interface CredentialRow {
  workspace_id: string;
  provider: WorkspaceCredentialProvider;
  ciphertext: string;
  residency: OpenAIDataResidency;
  created_at: Date;
  updated_at: Date;
}

interface CredentialSummaryRow {
  workspace_id: string;
  provider: WorkspaceCredentialProvider;
  residency: OpenAIDataResidency;
  updated_at: Date;
}

const credentialColumns = ["workspace_id", "provider", "ciphertext", "residency", "created_at", "updated_at"] as const;
const credentialSummaryColumns = ["workspace_id", "provider", "residency", "updated_at"] as const;

const mapRecord = (row: CredentialRow): WorkspaceProviderCredentialRecord => ({
  workspaceId: row.workspace_id,
  provider: row.provider,
  ciphertext: row.ciphertext,
  residency: row.residency,
  createdAt: new Date(row.created_at),
  updatedAt: new Date(row.updated_at),
});

const mapSummary = (row: CredentialSummaryRow): WorkspaceProviderCredentialSummary => ({
  workspaceId: row.workspace_id,
  provider: row.provider,
  residency: row.residency,
  updatedAt: new Date(row.updated_at),
});

export interface WorkspaceProviderCredentialsRepositoryPort {
  findByWorkspaceAndProvider(
    workspaceId: string,
    provider: WorkspaceCredentialProvider,
  ): Promise<WorkspaceProviderCredentialRecord | null>;
  listByWorkspace(workspaceId: string): Promise<WorkspaceProviderCredentialSummary[]>;
  upsert(input: {
    workspaceId: string;
    provider: WorkspaceCredentialProvider;
    ciphertext: string;
    /** Omitted keeps the row's existing residency (or the column default, `global`, on insert). */
    residency?: OpenAIDataResidency;
  }): Promise<WorkspaceProviderCredentialRecord>;
  /** Changes residency alone, without touching the stored key. Null when no row exists yet. */
  updateResidency(
    workspaceId: string,
    provider: WorkspaceCredentialProvider,
    residency: OpenAIDataResidency,
  ): Promise<WorkspaceProviderCredentialRecord | null>;
  remove(workspaceId: string, provider: WorkspaceCredentialProvider): Promise<boolean>;
}

export class WorkspaceProviderCredentialsRepository
  implements WorkspaceProviderCredentialsRepositoryPort
{
  constructor(private readonly db: Db) {}

  async findByWorkspaceAndProvider(
    workspaceId: string,
    provider: WorkspaceCredentialProvider,
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
    provider: WorkspaceCredentialProvider;
    ciphertext: string;
    residency?: OpenAIDataResidency;
  }): Promise<WorkspaceProviderCredentialRecord> {
    const row = await this.db
      .insertInto("workspace_provider_credentials")
      .values({
        workspace_id: input.workspaceId,
        provider: input.provider,
        ciphertext: input.ciphertext,
        ...(input.residency ? { residency: input.residency } : {}),
      })
      .onConflict((oc) =>
        oc.columns(["workspace_id", "provider"]).doUpdateSet((eb) => ({
          ciphertext: eb.ref("excluded.ciphertext"),
          updated_at: currentTimestamp(),
          ...(input.residency ? { residency: eb.ref("excluded.residency") } : {}),
        })),
      )
      .returning(credentialColumns)
      .executeTakeFirstOrThrow();

    return mapRecord(row as CredentialRow);
  }

  async updateResidency(
    workspaceId: string,
    provider: WorkspaceCredentialProvider,
    residency: OpenAIDataResidency,
  ): Promise<WorkspaceProviderCredentialRecord | null> {
    const row = await this.db
      .updateTable("workspace_provider_credentials")
      .set({ residency, updated_at: currentTimestamp() })
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", provider)
      .returning(credentialColumns)
      .executeTakeFirst();

    return row ? mapRecord(row as CredentialRow) : null;
  }

  async remove(workspaceId: string, provider: WorkspaceCredentialProvider): Promise<boolean> {
    const result = await this.db
      .deleteFrom("workspace_provider_credentials")
      .where("workspace_id", "=", workspaceId)
      .where("provider", "=", provider)
      .executeTakeFirst();

    return Number(result.numDeletedRows) > 0;
  }
}
