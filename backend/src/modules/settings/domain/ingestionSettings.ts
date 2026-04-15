import { badRequest } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { chunkingStrategyIds, type ChunkingStrategyId } from "../../retrieval/domain/chunking/chunkingStrategy.js";

export const FIXED_WINDOW_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeDefault;
export const FIXED_WINDOW_CHUNK_OVERLAP_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapDefault;
export const STRUCTURED_MIN_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeDefault;
export const STRUCTURED_MAX_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeDefault;

export const FIXED_WINDOW_CHUNK_SIZE_MIN = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMin;
export const FIXED_WINDOW_CHUNK_SIZE_MAX = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeMax;
export const FIXED_WINDOW_CHUNK_OVERLAP_MIN = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMin;
export const FIXED_WINDOW_CHUNK_OVERLAP_MAX = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapMax;
export const STRUCTURED_MIN_CHUNK_SIZE_MIN = RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMin;
export const STRUCTURED_MIN_CHUNK_SIZE_MAX = RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeMax;
export const STRUCTURED_MAX_CHUNK_SIZE_MIN = RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMin;
export const STRUCTURED_MAX_CHUNK_SIZE_MAX = RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeMax;

export interface IngestionSettingsRecord {
  workspaceId: string;
  chunkingStrategy: ChunkingStrategyId;
  fixedWindowChunkSize: number;
  fixedWindowChunkOverlap: number;
  structuredMinChunkSize: number;
  structuredMaxChunkSize: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IngestionSettingsInput {
  chunkingStrategy: ChunkingStrategyId;
  fixedWindowChunkSize: number;
  fixedWindowChunkOverlap: number;
  structuredMinChunkSize: number;
  structuredMaxChunkSize: number;
}

export const defaultIngestionSettings = (workspaceId: string): IngestionSettingsRecord => ({
  workspaceId,
  chunkingStrategy: "fixed_window",
  fixedWindowChunkSize: FIXED_WINDOW_CHUNK_SIZE_DEFAULT,
  fixedWindowChunkOverlap: FIXED_WINDOW_CHUNK_OVERLAP_DEFAULT,
  structuredMinChunkSize: STRUCTURED_MIN_CHUNK_SIZE_DEFAULT,
  structuredMaxChunkSize: STRUCTURED_MAX_CHUNK_SIZE_DEFAULT,
  createdAt: new Date(),
  updatedAt: new Date(),
});

export const validateIngestionSettings = (input: IngestionSettingsInput): IngestionSettingsInput => {
  if (!chunkingStrategyIds.includes(input.chunkingStrategy)) {
    throw badRequest("chunkingStrategy must be a supported strategy");
  }
  if (
    !Number.isInteger(input.fixedWindowChunkSize) ||
    input.fixedWindowChunkSize < FIXED_WINDOW_CHUNK_SIZE_MIN ||
    input.fixedWindowChunkSize > FIXED_WINDOW_CHUNK_SIZE_MAX
  ) {
    throw badRequest(
      `fixedWindowChunkSize must be between ${FIXED_WINDOW_CHUNK_SIZE_MIN} and ${FIXED_WINDOW_CHUNK_SIZE_MAX}`,
    );
  }
  if (
    !Number.isInteger(input.fixedWindowChunkOverlap) ||
    input.fixedWindowChunkOverlap < FIXED_WINDOW_CHUNK_OVERLAP_MIN ||
    input.fixedWindowChunkOverlap > FIXED_WINDOW_CHUNK_OVERLAP_MAX
  ) {
    throw badRequest(
      `fixedWindowChunkOverlap must be between ${FIXED_WINDOW_CHUNK_OVERLAP_MIN} and ${FIXED_WINDOW_CHUNK_OVERLAP_MAX}`,
    );
  }
  if (input.fixedWindowChunkOverlap >= input.fixedWindowChunkSize) {
    throw badRequest("fixedWindowChunkOverlap must be smaller than fixedWindowChunkSize");
  }
  if (
    !Number.isInteger(input.structuredMinChunkSize) ||
    input.structuredMinChunkSize < STRUCTURED_MIN_CHUNK_SIZE_MIN ||
    input.structuredMinChunkSize > STRUCTURED_MIN_CHUNK_SIZE_MAX
  ) {
    throw badRequest(
      `structuredMinChunkSize must be between ${STRUCTURED_MIN_CHUNK_SIZE_MIN} and ${STRUCTURED_MIN_CHUNK_SIZE_MAX}`,
    );
  }
  if (
    !Number.isInteger(input.structuredMaxChunkSize) ||
    input.structuredMaxChunkSize < STRUCTURED_MAX_CHUNK_SIZE_MIN ||
    input.structuredMaxChunkSize > STRUCTURED_MAX_CHUNK_SIZE_MAX
  ) {
    throw badRequest(
      `structuredMaxChunkSize must be between ${STRUCTURED_MAX_CHUNK_SIZE_MIN} and ${STRUCTURED_MAX_CHUNK_SIZE_MAX}`,
    );
  }
  if (input.structuredMinChunkSize > input.structuredMaxChunkSize) {
    throw badRequest("structuredMinChunkSize must be less than or equal to structuredMaxChunkSize");
  }

  return input;
};
