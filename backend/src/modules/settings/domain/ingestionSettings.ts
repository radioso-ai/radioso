import { badRequest } from "../../../shared/domain/errors.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import { chunkingStrategyIds, type ChunkingStrategyId } from "../../retrieval/domain/chunking/chunkingStrategy.js";

export const FIXED_WINDOW_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkSizeDefault;
export const FIXED_WINDOW_CHUNK_OVERLAP_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.fixedWindowChunkOverlapDefault;
export const STRUCTURED_MIN_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMinChunkSizeDefault;
export const STRUCTURED_MAX_CHUNK_SIZE_DEFAULT = RETRIEVAL_BEHAVIOR.chunking.structuredMaxChunkSizeDefault;

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

  return input;
};
