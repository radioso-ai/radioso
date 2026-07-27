import type {
  EmbeddingSpaceRef,
} from "../../embeddingProfiles/contracts/embeddingConsumers.js";
import type { RetrievalSourceFilter } from "./retrievalSourceFilter.js";
import type {
  VectorMetadataFilter,
  VectorMetadataFilterValue,
} from "./vectorFilter.js";

export const vectorDistanceMetrics = ["cosine"] as const;
export type VectorDistanceMetric = (typeof vectorDistanceMetrics)[number];

export const vectorFilterOperations = [
  "source",
  "metadata_containment",
  "retrieval_eligibility",
  "expiry",
] as const;
export type VectorFilterOperation = (typeof vectorFilterOperations)[number];

export const vectorSearchModes = ["exact", "accelerated"] as const;
export type VectorSearchMode = (typeof vectorSearchModes)[number];

export type VectorIndexConsistency = "transactional" | "eventual";
export type VectorIndexVersion = string;

export type { EmbeddingSpaceRef } from "../../embeddingProfiles/contracts/embeddingConsumers.js";

export interface VectorDimensionRange {
  min: number;
  max: number;
}

export interface VectorIndexCapabilities {
  backend: string;
  dimensionRanges: readonly VectorDimensionRange[];
  distanceMetrics: readonly VectorDistanceMetric[];
  filterOperations: readonly VectorFilterOperation[];
  maxBatchSize: number;
  searchModes: readonly VectorSearchMode[];
  consistency: VectorIndexConsistency;
}

export interface VectorIndexPayload {
  sourceId: string | null;
  metadata: VectorMetadataFilter;
  retrievalEnabled: boolean;
  retrievalExpiresAt: string | null;
}

export interface VectorIndexRecord {
  chunkId: string;
  documentId: string;
  vector: number[];
  version: VectorIndexVersion;
  payload: VectorIndexPayload;
}

export type VectorIndexMutation =
  | {
      kind: "upsert";
      record: VectorIndexRecord;
    }
  | {
      kind: "delete";
      chunkId: string;
      version: VectorIndexVersion;
    };

export interface VectorIndexFilter {
  metadataContains?: VectorMetadataFilter;
  source?: RetrievalSourceFilter;
  retrievalEnabled?: boolean;
  notExpiredAt?: string;
}

export interface VectorCandidate {
  chunkId: string;
  documentId: string;
  embeddingSpaceId: string;
  version: VectorIndexVersion;
  score: number;
}

export interface VectorCandidateSearchInput {
  workspaceId: string;
  space: EmbeddingSpaceRef;
  queryVector: number[];
  topK: number;
  minimumScore: number;
  filter: VectorIndexFilter;
}

export interface VectorIndexMutationResult {
  chunkId: string;
  requestedVersion: VectorIndexVersion;
  acknowledgedVersion: VectorIndexVersion;
  outcome: "applied" | "duplicate" | "ignored_stale";
}

export interface VectorIndexWriteResult {
  mutations: VectorIndexMutationResult[];
}

export type VectorBackendStatus = "available" | "unavailable";
export type VectorSpaceReadiness = "ready" | "building" | "unavailable";

export interface VectorIndexHealth {
  backend: string;
  status: VectorBackendStatus;
  readiness: VectorSpaceReadiness;
  errorCode?: string;
}

export interface VectorIndexCapabilityPort {
  getCapabilities(): Promise<VectorIndexCapabilities>;
}

export interface VectorIndexWriterPort {
  applyMutations(input: {
    workspaceId: string;
    space: EmbeddingSpaceRef;
    mutations: VectorIndexMutation[];
  }): Promise<VectorIndexWriteResult>;
}

export interface VectorCandidateSearchPort {
  search(input: VectorCandidateSearchInput): Promise<VectorCandidate[]>;
}

export interface VectorIndexAdministrationPort {
  prepareSpace(input: { space: EmbeddingSpaceRef }): Promise<void>;
  resetSpace(input: { spaceId: string; workspaceId?: string }): Promise<void>;
  getHealth(input: { spaceId?: string }): Promise<VectorIndexHealth>;
}

export interface VectorAdapter {
  capabilities: VectorIndexCapabilityPort;
  writer: VectorIndexWriterPort;
  search: VectorCandidateSearchPort;
  admin: VectorIndexAdministrationPort;
}

const vectorIndexVersionPattern = /^(0|[1-9][0-9]*)$/;

export const compareVectorIndexVersions = (
  left: VectorIndexVersion,
  right: VectorIndexVersion,
): number => {
  assertVectorIndexVersion(left);
  assertVectorIndexVersion(right);

  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  if (leftValue < rightValue) {
    return -1;
  }
  if (leftValue > rightValue) {
    return 1;
  }
  return 0;
};

export const cosineSimilarity = (left: readonly number[], right: readonly number[]): number => {
  if (left.length !== right.length) {
    throw new Error("vector_dimension_mismatch");
  }
  if (left.length === 0) {
    throw new Error("empty_vector");
  }

  let dotProduct = 0;
  let leftSquaredNorm = 0;
  let rightSquaredNorm = 0;

  for (let index = 0; index < left.length; index += 1) {
    const leftValue = left[index]!;
    const rightValue = right[index]!;
    if (!Number.isFinite(leftValue) || !Number.isFinite(rightValue)) {
      throw new Error("non_finite_vector");
    }
    dotProduct += leftValue * rightValue;
    leftSquaredNorm += leftValue * leftValue;
    rightSquaredNorm += rightValue * rightValue;
  }

  if (leftSquaredNorm === 0 || rightSquaredNorm === 0) {
    throw new Error("zero_cosine_vector");
  }

  const score = dotProduct / Math.sqrt(leftSquaredNorm * rightSquaredNorm);
  return Math.max(-1, Math.min(1, score));
};

export const supportsEmbeddingSpace = (
  capabilities: VectorIndexCapabilities,
  space: EmbeddingSpaceRef,
): boolean =>
  Number.isInteger(space.dimensions)
  && space.dimensions > 0
  && capabilities.distanceMetrics.includes(space.distanceMetric)
  && capabilities.dimensionRanges.some(
    (range) => space.dimensions >= range.min && space.dimensions <= range.max,
  );

export const matchesVectorIndexFilter = (
  record: Pick<VectorIndexRecord, "payload">,
  filter: VectorIndexFilter,
): boolean => {
  if (!matchesSourceFilter(record.payload.sourceId, filter.source)) {
    return false;
  }

  if (
    filter.metadataContains
    && !containsMetadata(record.payload.metadata, filter.metadataContains)
  ) {
    return false;
  }

  if (
    filter.retrievalEnabled !== undefined
    && record.payload.retrievalEnabled !== filter.retrievalEnabled
  ) {
    return false;
  }

  if (filter.notExpiredAt !== undefined) {
    const cutoff = parseTimestamp(filter.notExpiredAt);
    if (record.payload.retrievalExpiresAt !== null) {
      const expiresAt = parseTimestamp(record.payload.retrievalExpiresAt);
      if (expiresAt <= cutoff) {
        return false;
      }
    }
  }

  return true;
};

const assertVectorIndexVersion = (version: VectorIndexVersion): void => {
  if (!vectorIndexVersionPattern.test(version)) {
    throw new Error("invalid_vector_index_version");
  }
};

const matchesSourceFilter = (
  sourceId: string | null,
  filter?: RetrievalSourceFilter,
): boolean => {
  if (!filter || !filter.constrained) {
    return true;
  }
  if (sourceId === null) {
    return filter.includeUnassignedDocuments;
  }
  return filter.sourceIds.includes(sourceId);
};

const containsMetadata = (
  actual: Record<string, unknown>,
  expected: VectorMetadataFilter,
): boolean =>
  Object.entries(expected).every(([key, expectedValue]) =>
    Object.hasOwn(actual, key) && containsJsonValue(actual[key], expectedValue));

const containsJsonValue = (
  actual: unknown,
  expected: VectorMetadataFilterValue,
): boolean => {
  if (Array.isArray(expected)) {
    return Array.isArray(actual)
      && expected.every((expectedItem) =>
        actual.some((actualItem) => containsJsonValue(actualItem, expectedItem)));
  }

  if (isFilterObject(expected)) {
    return isPlainObject(actual) && containsMetadata(actual, expected);
  }

  return Object.is(actual, expected);
};

const isFilterObject = (
  value: VectorMetadataFilterValue,
): value is VectorMetadataFilter =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null
  && typeof value === "object"
  && !Array.isArray(value)
  && Object.getPrototypeOf(value) === Object.prototype;

const parseTimestamp = (value: string): number => {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new Error("invalid_vector_index_timestamp");
  }
  return timestamp;
};
