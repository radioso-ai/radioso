import type { IngestionSettingsInput, IngestionSettingsRecord, ValidatedIngestionSettingsInput } from "./ingestion.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
  WorkspaceLlmCapabilityPreferenceInput,
} from "./llmCapability.js";
import type { MetadataFieldSuggestion } from "./retrieval.js";

export interface IngestionSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  upsert(workspaceId: string, input: ValidatedIngestionSettingsInput): Promise<IngestionSettingsRecord>;
  clearPendingEmbeddingModel?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  promotePendingEmbeddingModelIfReady?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
}

export interface WorkspaceReprocessPort {
  reprocessWorkspace(workspaceId: string): Promise<unknown>;
}

/**
 * Narrow port for reading/writing the per-workspace LLM capability preferences
 * (chat / rewrite / rerank provider+model). Backed by the same row as retrieval
 * settings, but consumed by a different service so model-selection concerns do
 * not leak into retrieval-pipeline configuration.
 */
export interface WorkspaceLlmCapabilityPreferencesRepositoryPort {
  ensureRow(workspaceId: string): Promise<void>;
  findByWorkspace(workspaceId: string): Promise<WorkspaceLlmCapabilityPreference[]>;
  setPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
    value: WorkspaceLlmCapabilityPreferenceInput | null,
  ): Promise<void>;
}

export interface RetrievalMetadataFieldSourcePort {
  listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]>;
}

export interface IngestionSettingsPort {
  getForWorkspace(workspaceId: string): Promise<IngestionSettingsRecord>;
  cancelPendingEmbeddingModel?(workspaceId: string): Promise<IngestionSettingsRecord>;
  listSupportedEmbeddingModels?(): readonly IngestionSettingsRecord["embeddingModel"][];
  updateForWorkspace(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord>;
  promotePendingEmbeddingModelIfReady?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
}

export type IngestionSettingsService = IngestionSettingsPort;
