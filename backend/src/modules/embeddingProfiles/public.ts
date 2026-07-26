export type {
  EmbeddingGenerationBatchResult,
  EmbeddingGenerationGateway,
  EmbeddingGenerationOptions,
  EmbeddingInferencePort,
  EmbeddingInferenceRequest,
} from "./contracts/embeddingGeneration.js";
export type {
  ClusteringEmbeddingPort,
  ClusteringEmbeddingRequest,
  ClusteringEmbeddingResult,
  DocumentEmbeddingPort,
  DocumentEmbeddingRequest,
  EmbeddingConsumerResult,
  EmbeddingSpaceRef,
  EmbeddingUsageItem,
  EmbeddingUsageSummary,
  PinnedDocumentEmbeddingPort,
  PinnedDocumentEmbeddingRequest,
  QueryEmbeddingPort,
  QueryEmbeddingRequest,
} from "./contracts/embeddingConsumers.js";
export type {
  EmbeddingGenerationRequest,
  EmbeddingNormalization,
  EmbeddingProviderFamily,
  EmbeddingProviderImplementation,
  EmbeddingProviderPort,
  EmbeddingProviderResult,
  EmbeddingProviderUsage,
  EmbeddingPurpose,
  SupportedEmbeddingModelDescriptor,
  ValidatedEmbeddingBatch,
} from "./contracts/embeddingProvider.js";
export type {
  CanonicalVersion,
  ChunkEmbeddingRecord,
  ChunkEmbeddingRepositoryPort,
  ChunkEmbeddingWriteInput,
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceCreateInput,
  EmbeddingSpaceRecord,
  VectorIndexCheckpointRecord,
  VectorIndexOperation,
  VectorIndexReadiness,
  VectorIndexWorkRecord,
  VectorIndexWorkRepositoryPort,
  VectorIndexWorkStatus,
} from "./contracts/repositories.js";
export {
  EmbeddingGenerationService,
  ModelEmbeddingGenerationGateway,
  OpenAIEmbeddingGenerationGateway,
} from "./services/embeddingGenerationService.js";
export {
  ProfileBoundEmbeddingPorts,
  type EmbeddingBinding,
  type EmbeddingBindingResolverPort,
} from "./services/profileBoundEmbeddingPorts.js";
export {
  createEmbeddingSpaceIdentity,
  isEmbeddingSpaceCompatible,
  MAX_EMBEDDING_DIMENSIONS,
  MAX_EMBEDDING_MODEL_BYTES,
  MIN_EMBEDDING_DIMENSIONS,
  type EmbeddingSpaceIdentity,
  type EmbeddingSpaceIdentityInput,
  type EmbeddingVectorOption,
} from "./domain/embeddingSpace.js";
export {
  beginEmbeddingTransition,
  blockEmbeddingTransition,
  cancelEmbeddingTransition,
  canCleanupEmbeddingSpace,
  canCommitEmbeddingTransitionWork,
  canPromoteEmbeddingTransition,
  EmbeddingProfileLifecycleError,
  failEmbeddingTransition,
  promoteEmbeddingTransition,
  quarantineEmbeddingTransition,
  type EmbeddingTransitionFailureReason,
  type EmbeddingTransitionFailureStatus,
  type EmbeddingPromotionReadiness,
  type EmbeddingTransitionFence,
  type EmbeddingTransitionState,
  type EmbeddingTransitionStatus,
  type WorkspaceEmbeddingProfileState,
} from "./domain/profileLifecycle.js";
export {
  EMBEDDING_PROBE_TEXT,
  EmbeddingModelProbeService,
  EmbeddingVectorContractError,
  splitEmbeddingInputs,
  validateEmbeddingBatch,
  type EmbeddingValidationOptions,
} from "./services/embeddingVectorValidator.js";
export {
  EmbeddingTransitionCoordinator,
  EmbeddingTransitionCoordinatorError,
  FixedInputEmbeddingValidationError,
  type EmbeddingTransitionBackfillPort,
  type EmbeddingTransitionCoordinatorRepository,
  type EmbeddingTransitionPromotionResult,
  type EmbeddingTransitionStartResult,
  type EmbeddingTransitionWorkFence,
  type FixedInputEmbeddingValidationPort,
} from "./services/embeddingTransitionCoordinator.js";
export {
  EmbeddingCoverageReconciler,
  type EmbeddingCoverageJobPort,
} from "./services/embeddingCoverageReconciler.js";
export {
  EmbeddingProfileCleanupService,
  type EmbeddingProfileCleanupCandidate,
  type EmbeddingProfileCleanupRepositoryPort,
} from "./services/embeddingProfileCleanupService.js";
export {
  EmbeddingProfileReadinessError,
  EmbeddingProfileReadinessService,
  type EmbeddingIndexQualificationManifest,
  type EmbeddingProfileActivationBlockReason,
  type EmbeddingProfileIndexReadiness,
  type EmbeddingProfileReadiness,
  type EmbeddingProfileReadinessState,
  type EmbeddingProfileReadinessStatePort,
  type EmbeddingProfileVectorCapabilities,
  type EmbeddingProfileVectorCapabilitiesPort,
} from "./services/embeddingProfileReadinessService.js";
