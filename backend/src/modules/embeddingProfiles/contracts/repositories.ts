import type {
  EmbeddingTransitionFailureReason,
  EmbeddingTransitionFailureStatus,
  EmbeddingTransitionState,
  WorkspaceEmbeddingProfileState,
} from "../domain/profileLifecycle.js";

export type CanonicalVersion = string;

export interface EmbeddingSpaceRecord {
  id: string;
  identityFingerprint: string;
  provider: string;
  endpointScopeFingerprint: string;
  model: string;
  dimensions: number;
  distanceMetric: "cosine";
  normalization: string;
  documentTask: string | null;
  queryTask: string | null;
  vectorOptions: Record<string, unknown>;
  modelVersion: string | null;
  status: "active" | "quarantined";
  quarantineReason: EmbeddingTransitionFailureReason | null;
  createdAt: Date;
  updatedAt: Date;
}

export type EmbeddingSpaceCreateInput = Omit<
  EmbeddingSpaceRecord,
  "id" | "status" | "quarantineReason" | "createdAt" | "updatedAt"
>;

export interface EmbeddingProfileRepositoryPort {
  createEmbeddingSpace(input: EmbeddingSpaceCreateInput): Promise<EmbeddingSpaceRecord>;
  findEmbeddingSpaceById(id: string): Promise<EmbeddingSpaceRecord | null>;
  initializeWorkspaceProfile(input: {
    workspaceId: string;
    activeEmbeddingSpaceId: string;
  }): Promise<WorkspaceEmbeddingProfileState>;
  findWorkspaceProfile(workspaceId: string): Promise<WorkspaceEmbeddingProfileState | null>;
  listBuildingTransitions(input: {
    limit: number;
  }): Promise<Array<{
    profile: WorkspaceEmbeddingProfileState;
    transition: EmbeddingTransitionState;
  }>>;
  startTransition(input: {
    workspaceId: string;
    targetEmbeddingSpaceId: string;
    expectedGeneration: string;
  }): Promise<{ profile: WorkspaceEmbeddingProfileState; transition: EmbeddingTransitionState }>;
  cancelTransition(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
  }): Promise<WorkspaceEmbeddingProfileState>;
  promoteTransitionIfEligible(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
    backendKey: string;
  }): Promise<WorkspaceEmbeddingProfileState>;
  failTransition(input: {
    workspaceId: string;
    transitionId: string;
    expectedGeneration: string;
    status: EmbeddingTransitionFailureStatus;
    reason: EmbeddingTransitionFailureReason;
  }): Promise<WorkspaceEmbeddingProfileState>;
  quarantineEmbeddingSpace(input: {
    embeddingSpaceId: string;
    reason: EmbeddingTransitionFailureReason;
  }): Promise<EmbeddingSpaceRecord>;
  hasLiveReferences(embeddingSpaceId: string): Promise<boolean>;
}

export interface ChunkEmbeddingRecord {
  workspaceId: string;
  chunkId: string;
  embeddingSpaceId: string;
  documentRevision: number;
  canonicalVersion: CanonicalVersion;
  dimensions: number;
  embedding: number[];
  contentHash: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ChunkEmbeddingWriteInput {
  workspaceId: string;
  chunkId: string;
  documentId: string;
  embeddingSpaceId: string;
  documentRevision: number;
  canonicalVersion: CanonicalVersion;
  dimensions: number;
  embedding: number[];
  contentHash: string;
}

export interface ChunkEmbeddingRepositoryPort {
  upsert(input: ChunkEmbeddingWriteInput): Promise<{
    record: ChunkEmbeddingRecord;
    applied: boolean;
  }>;
  find(input: {
    workspaceId: string;
    chunkId: string;
    embeddingSpaceId: string;
  }): Promise<ChunkEmbeddingRecord | null>;
}

export type VectorIndexOperation = "upsert" | "delete" | "filter_update";
export type VectorIndexWorkStatus =
  | "queued"
  | "processing"
  | "completed"
  | "failed"
  | "dead_letter";
export type VectorIndexFailureCode =
  | "adapter_unavailable"
  | "mutation_rejected"
  | "invalid_work_payload"
  | "checkpoint_failed";
export type VectorIndexReadiness = "building" | "ready" | "stale" | "unavailable" | "exact_fallback";

export interface VectorIndexWorkRecord {
  id: string;
  sequence: string;
  workspaceId: string;
  embeddingSpaceId: string;
  chunkId: string;
  documentId: string | null;
  operation: VectorIndexOperation;
  canonicalVersion: CanonicalVersion;
  payload: Record<string, unknown>;
  status: VectorIndexWorkStatus;
  attemptCount: number;
  availableAt: Date;
  claimedAt: Date | null;
  completedAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface VectorIndexCheckpointRecord {
  backendKey: string;
  workspaceId: string;
  embeddingSpaceId: string;
  acknowledgedSequence: string;
  readiness: VectorIndexReadiness;
  updatedAt: Date;
}

export interface VectorIndexLagRecord {
  backendKey: string;
  workspaceId: string;
  embeddingSpaceId: string;
  requiredSequence: string;
  acknowledgedSequence: string;
  pendingCount: number;
  deadLetterCount: number;
  readiness: VectorIndexReadiness;
}

export interface VectorIndexWorkRepositoryPort {
  append(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    documentId?: string | null;
    operation: VectorIndexOperation;
    canonicalVersion: CanonicalVersion;
    payload: Record<string, unknown>;
  }): Promise<{ work: VectorIndexWorkRecord; accepted: boolean }>;
  claimBatch(input: {
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<VectorIndexWorkRecord[]>;
  markFailed(input: {
    id: string;
    errorCode: VectorIndexFailureCode;
    retryAt: Date;
    maxAttempts: number;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<
    | {
        disposition: "retry_scheduled" | "dead_lettered";
        checkpoint: null;
      }
    | {
        disposition: "superseded";
        checkpoint: VectorIndexCheckpointRecord;
      }
  >;
  markCompleted(id: string): Promise<void>;
  markCompletedAndAdvanceCheckpoint(input: {
    id: string;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord>;
  completeSupersededAndAdvanceCheckpoint(input: {
    id: string;
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    chunkId: string;
    caughtUpReadiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord | null>;
  ensureCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    readiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord>;
  advanceCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
    acknowledgedSequence: string;
    expectedAcknowledgedSequence: string;
    readiness: VectorIndexReadiness;
  }): Promise<VectorIndexCheckpointRecord>;
  findCheckpoint(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<VectorIndexCheckpointRecord | null>;
  getLag(input: {
    backendKey: string;
    workspaceId: string;
    embeddingSpaceId: string;
  }): Promise<VectorIndexLagRecord>;
}
