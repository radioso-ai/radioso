import type { Database } from "../../shared/infra/database.js";
import type { WorkspaceLlmCapabilityPreferencesRepositoryPort } from "../../modules/settings/contracts/services.js";
import {
  workspaceLlmCapabilities,
  type WorkspaceLlmCapability,
  type WorkspaceLlmCapabilityPreference,
  type WorkspaceLlmCapabilityPreferenceInput,
} from "../../modules/settings/contracts/llmCapability.js";
import type { LlmProviderName } from "../../shared/infra/llm/providerTypes.js";

interface CapabilityColumnRow {
  workspace_id: string;
  chat_provider: LlmProviderName | null;
  chat_model: string | null;
  rewrite_provider: LlmProviderName | null;
  rewrite_model: string | null;
  rerank_provider: LlmProviderName | null;
  rerank_model: string | null;
  updated_at: Date;
}

const capabilityColumnPairs: Record<WorkspaceLlmCapability, { provider: keyof CapabilityColumnRow; model: keyof CapabilityColumnRow }> = {
  chat: { provider: "chat_provider", model: "chat_model" },
  rewrite: { provider: "rewrite_provider", model: "rewrite_model" },
  rerank: { provider: "rerank_provider", model: "rerank_model" },
};

const toCapabilityPreferences = (
  row: CapabilityColumnRow,
): WorkspaceLlmCapabilityPreference[] =>
  workspaceLlmCapabilities
    .map((capability) => {
      const provider = row[capabilityColumnPairs[capability].provider];
      const model = row[capabilityColumnPairs[capability].model];
      if (typeof provider === "string" && typeof model === "string") {
        return {
          workspaceId: row.workspace_id,
          capability,
          provider: provider as LlmProviderName,
          model,
          updatedAt: new Date(row.updated_at),
        } satisfies WorkspaceLlmCapabilityPreference;
      }
      return null;
    })
    .filter((entry): entry is WorkspaceLlmCapabilityPreference => entry !== null);

export class RetrievalSettingsRepository implements WorkspaceLlmCapabilityPreferencesRepositoryPort {
  constructor(private readonly database: Database) {}

  async ensureRow(workspaceId: string): Promise<void> {
    await this.database.execute(
      `INSERT INTO retrieval_settings (workspace_id)
       VALUES ($1)
       ON CONFLICT (workspace_id) DO NOTHING`,
      [workspaceId],
    );
  }

  async findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]> {
    const row = await this.database.queryOptional<CapabilityColumnRow>(
      `SELECT workspace_id, chat_provider, chat_model, rewrite_provider, rewrite_model, rerank_provider, rerank_model, updated_at
       FROM retrieval_settings
       WHERE workspace_id = $1`,
      [workspaceId],
    );
    return row ? toCapabilityPreferences(row) : [];
  }

  async setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void> {
    const columns = capabilityColumnPairs[capability];
    const provider = value?.provider ?? null;
    const model = value?.model ?? null;
    const affected = await this.database.execute(
      `UPDATE retrieval_settings
       SET ${columns.provider} = $2,
           ${columns.model} = $3,
           updated_at = NOW()
       WHERE workspace_id = $1`,
      [workspaceId, provider, model],
    );
    if (affected === 0) {
      // No retrieval_settings row exists yet for this workspace; we cannot create one
      // here without forging non-capability defaults. The capability service guards
      // this case by ensuring the row exists before writing.
      throw new Error(`retrieval_settings row missing for workspace ${workspaceId}`);
    }
  }

}
