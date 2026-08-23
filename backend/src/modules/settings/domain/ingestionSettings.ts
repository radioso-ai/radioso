import { badRequest } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { chunkingStrategyIds, type ChunkingStrategyId } from "../../retrieval/public.js";

export const FIXED_WINDOW_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeDefault;
export const FIXED_WINDOW_CHUNK_OVERLAP_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapDefault;
export const STRUCTURED_MIN_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeDefault;
export const STRUCTURED_MAX_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeDefault;
export const embeddingModelIds = [
  "text-embedding-3-small",
  "text-embedding-3-large",
  "text-embedding-ada-002",
  "gemini-embedding-001",
] as const;
export type EmbeddingModelId = (typeof embeddingModelIds)[number];
export const EMBEDDING_MODEL_DEFAULT: EmbeddingModelId = "text-embedding-3-small";

export const isEmbeddingModelId = (value: string): value is EmbeddingModelId =>
  embeddingModelIds.includes(value as EmbeddingModelId);

declare const legacyEmbeddingModelBrand: unique symbol;
export type LegacyEmbeddingModel = string & {
  readonly [legacyEmbeddingModelBrand]: "legacy_embedding_model";
};
export type ActiveEmbeddingModel =
  | EmbeddingModelId
  | LegacyEmbeddingModel;

export const activeEmbeddingModelFromPersisted = (
  value: string,
): ActiveEmbeddingModel =>
  isEmbeddingModelId(value) ? value : value as LegacyEmbeddingModel;

/**
 * Documents added by hand have no document_sources row, so the source-level
 * enrichment override has nowhere to live. This workspace setting is their
 * source-override slot. The documents module owns the enablement rule and
 * parses this value; settings must not depend on the documents module, so the
 * three-value enum is declared here rather than imported across that boundary.
 */
export const manualDocumentEnrichmentOverrides = ["inherit", "on", "off"] as const;
export type ManualDocumentEnrichmentOverride = (typeof manualDocumentEnrichmentOverrides)[number];
export const MANUAL_DOCUMENT_ENRICHMENT_OVERRIDE_DEFAULT: ManualDocumentEnrichmentOverride = "inherit";

export const isManualDocumentEnrichmentOverride = (
  value: unknown,
): value is ManualDocumentEnrichmentOverride =>
  manualDocumentEnrichmentOverrides.includes(value as ManualDocumentEnrichmentOverride);

export interface IngestionSettingsRecord {
  workspaceId: string;
  chunkingStrategy: ChunkingStrategyId;
  fixedWindowChunkSize: number;
  fixedWindowChunkOverlap: number;
  structuredMinChunkSize: number;
  structuredMaxChunkSize: number;
  embeddingModel: ActiveEmbeddingModel;
  pendingEmbeddingModel: EmbeddingModelId | null;
  documentEnrichmentEnabled?: boolean;
  manualDocumentEnrichmentOverride?: ManualDocumentEnrichmentOverride;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionSettingsInput {
  chunkingStrategy: ChunkingStrategyId;
  fixedWindowChunkSize: number;
  fixedWindowChunkOverlap: number;
  structuredMinChunkSize: number;
  structuredMaxChunkSize: number;
  embeddingModel?: EmbeddingModelId;
  pendingEmbeddingModel?: EmbeddingModelId | null;
  documentEnrichmentEnabled?: boolean;
  manualDocumentEnrichmentOverride?: ManualDocumentEnrichmentOverride;
}

/**
 * The runtime write boundary accepts a string only to support an older client
 * echoing an already-active legacy value while saving unrelated settings.
 * New selections are still narrowed to EmbeddingModelId by the service.
 */
export type IngestionSettingsWriteInput = Omit<
  IngestionSettingsInput,
  "embeddingModel"
> & {
  embeddingModel?: string;
};

export interface ValidatedIngestionSettingsInput extends Omit<
  IngestionSettingsInput,
  "embeddingModel"
> {
  embeddingModel: ActiveEmbeddingModel;
  pendingEmbeddingModel: EmbeddingModelId | null;
}

export const defaultIngestionSettings = (workspaceId: string): IngestionSettingsRecord => ({
  workspaceId,
  chunkingStrategy: "fixed_window",
  fixedWindowChunkSize: FIXED_WINDOW_CHUNK_SIZE_DEFAULT,
  fixedWindowChunkOverlap: FIXED_WINDOW_CHUNK_OVERLAP_DEFAULT,
  structuredMinChunkSize: STRUCTURED_MIN_CHUNK_SIZE_DEFAULT,
  structuredMaxChunkSize: STRUCTURED_MAX_CHUNK_SIZE_DEFAULT,
  embeddingModel: EMBEDDING_MODEL_DEFAULT,
  pendingEmbeddingModel: null,
  documentEnrichmentEnabled: false,
  manualDocumentEnrichmentOverride: MANUAL_DOCUMENT_ENRICHMENT_OVERRIDE_DEFAULT,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const validateIngestionSettings = (input: IngestionSettingsInput): ValidatedIngestionSettingsInput => {
  if (!chunkingStrategyIds.includes(input.chunkingStrategy)) {
    throw badRequest("chunkingStrategy must be a supported strategy");
  }
  const embeddingModel = input.embeddingModel ?? EMBEDDING_MODEL_DEFAULT;
  if (!isEmbeddingModelId(embeddingModel)) {
    throw badRequest("embeddingModel must be a supported embedding model");
  }
  const pendingEmbeddingModel = input.pendingEmbeddingModel ?? null;
  if (pendingEmbeddingModel && !isEmbeddingModelId(pendingEmbeddingModel)) {
    throw badRequest("pendingEmbeddingModel must be a supported embedding model");
  }
  if (
    !Number.isInteger(input.fixedWindowChunkSize) ||
    input.fixedWindowChunkSize < RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMin ||
    input.fixedWindowChunkSize > RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax
  ) {
    throw badRequest(
      `fixedWindowChunkSize must be between ${RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMin} and ${RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax}`,
    );
  }
  if (
    !Number.isInteger(input.fixedWindowChunkOverlap) ||
    input.fixedWindowChunkOverlap < RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMin ||
    input.fixedWindowChunkOverlap > RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMax
  ) {
    throw badRequest(
      `fixedWindowChunkOverlap must be between ${RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMin} and ${RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMax}`,
    );
  }
  if (input.fixedWindowChunkOverlap >= input.fixedWindowChunkSize) {
    throw badRequest("fixedWindowChunkOverlap must be smaller than fixedWindowChunkSize");
  }
  if (
    !Number.isInteger(input.structuredMinChunkSize) ||
    input.structuredMinChunkSize < RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMin ||
    input.structuredMinChunkSize > RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMax
  ) {
    throw badRequest(
      `structuredMinChunkSize must be between ${RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMin} and ${RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMax}`,
    );
  }
  if (
    !Number.isInteger(input.structuredMaxChunkSize) ||
    input.structuredMaxChunkSize < RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMin ||
    input.structuredMaxChunkSize > RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMax
  ) {
    throw badRequest(
      `structuredMaxChunkSize must be between ${RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMin} and ${RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMax}`,
    );
  }
  if (input.structuredMinChunkSize > input.structuredMaxChunkSize) {
    throw badRequest("structuredMinChunkSize must be less than or equal to structuredMaxChunkSize");
  }
  const manualDocumentEnrichmentOverride =
    input.manualDocumentEnrichmentOverride ?? MANUAL_DOCUMENT_ENRICHMENT_OVERRIDE_DEFAULT;
  if (!isManualDocumentEnrichmentOverride(manualDocumentEnrichmentOverride)) {
    throw badRequest(
      `manualDocumentEnrichmentOverride must be one of ${manualDocumentEnrichmentOverrides.join(", ")}`,
    );
  }

  return {
    ...input,
    embeddingModel,
    pendingEmbeddingModel,
    documentEnrichmentEnabled: input.documentEnrichmentEnabled ?? false,
    manualDocumentEnrichmentOverride,
  };
};
