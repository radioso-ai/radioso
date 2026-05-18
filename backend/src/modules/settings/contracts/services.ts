import type { IngestionSettingsInput, IngestionSettingsRecord, ValidatedIngestionSettingsInput } from "./ingestion.js";
import type { MetadataFieldSuggestion, RetrievalSettingsInput, RetrievalSettingsRecord } from "./retrieval.js";

export interface IngestionSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  upsert(workspaceId: string, input: ValidatedIngestionSettingsInput): Promise<IngestionSettingsRecord>;
  clearPendingEmbeddingModel?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  promotePendingEmbeddingModelIfReady?(workspaceId: string): Promise<IngestionSettingsRecord | null>;
}

export interface WorkspaceReprocessPort {
  reprocessWorkspace(workspaceId: string): Promise<unknown>;
}

export interface RetrievalSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<RetrievalSettingsRecord | null>;
  upsert(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
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

export interface RetrievalSettingsPort {
  getForWorkspace(workspaceId: string): Promise<RetrievalSettingsRecord>;
  listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]>;
  updateForWorkspace(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
}

export type IngestionSettingsService = IngestionSettingsPort;
export type RetrievalSettingsService = RetrievalSettingsPort;
