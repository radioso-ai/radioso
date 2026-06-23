import { currentTimestamp } from "../../shared/infra/kysely/sqlHelpers.js";
import type { Db } from "../../shared/infra/kysely/types.js";
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

const capabilityColumns = [
  "workspace_id",
  "chat_provider",
  "chat_model",
  "rewrite_provider",
  "rewrite_model",
  "rerank_provider",
  "rerank_model",
  "updated_at",
] as const;

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
  constructor(private readonly db: Db) {}

  async ensureRow(workspaceId: string): Promise<void> {
    await this.db
      .insertInto("retrieval_settings")
      .values({ workspace_id: workspaceId })
      .onConflict((oc) => oc.column("workspace_id").doNothing())
      .execute();
  }

  async findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]> {
    const row = await this.db
      .selectFrom("retrieval_settings")
      .select(capabilityColumns)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? toCapabilityPreferences(row as CapabilityColumnRow) : [];
  }

  async setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void> {
    const provider = value?.provider ?? null;
    const model = value?.model ?? null;
    const ts = currentTimestamp();
    const base = this.db.updateTable("retrieval_settings").where("workspace_id", "=", workspaceId);
    // Explicit per-capability set keeps the dynamic column pair statically typed.
    const query =
      capability === "chat"
        ? base.set({ chat_provider: provider, chat_model: model, updated_at: ts })
        : capability === "rewrite"
          ? base.set({ rewrite_provider: provider, rewrite_model: model, updated_at: ts })
          : base.set({ rerank_provider: provider, rerank_model: model, updated_at: ts });

    const result = await query.executeTakeFirst();
    if (Number(result.numUpdatedRows) === 0) {
      // No retrieval_settings row exists yet for this workspace; we cannot create one
      // here without forging non-capability defaults. The capability service guards
      // this case by ensuring the row exists before writing.
      throw new Error(`retrieval_settings row missing for workspace ${workspaceId}`);
    }
  }
}
