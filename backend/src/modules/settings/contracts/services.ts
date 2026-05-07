import type { IngestionSettingsInput, IngestionSettingsRecord } from "./ingestion.js";
import type { MetadataFieldSuggestion, RetrievalSettingsInput, RetrievalSettingsRecord } from "./retrieval.js";

export interface IngestionSettingsRepositoryPort {
  findByWorkspaceId(workspaceId: string): Promise<IngestionSettingsRecord | null>;
  upsert(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord>;
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
  updateForWorkspace(workspaceId: string, input: IngestionSettingsInput): Promise<IngestionSettingsRecord>;
}

export interface RetrievalSettingsPort {
  getForWorkspace(workspaceId: string): Promise<RetrievalSettingsRecord>;
  listMetadataFieldSuggestions(workspaceId: string): Promise<MetadataFieldSuggestion[]>;
  updateForWorkspace(workspaceId: string, input: RetrievalSettingsInput): Promise<RetrievalSettingsRecord>;
}

export type IngestionSettingsService = IngestionSettingsPort;
export type RetrievalSettingsService = RetrievalSettingsPort;
