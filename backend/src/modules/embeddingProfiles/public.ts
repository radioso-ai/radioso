export type {
  EmbeddingGenerationGateway,
  EmbeddingInferencePort,
} from "./contracts/embeddingGeneration.js";
export type {
  ClusteringEmbeddingPort,
  DocumentEmbeddingPort,
  EmbeddingConsumerResult,
  QueryEmbeddingPort,
} from "./contracts/embeddingConsumers.js";
export type {
  EmbeddingProviderImplementation,
} from "./contracts/embeddingProvider.js";
export type {
  EmbeddingProfileRepositoryPort,
  EmbeddingSpaceRecord,
} from "./contracts/repositories.js";
export {
  EmbeddingGenerationService,
  ModelEmbeddingGenerationGateway,
} from "./services/embeddingGenerationService.js";
export {
  ProfileBoundEmbeddingPorts,
  type EmbeddingBindingResolverPort,
} from "./services/profileBoundEmbeddingPorts.js";
export {
  createEmbeddingSpaceIdentity,
} from "./domain/embeddingSpace.js";
export {
  EmbeddingProfileLifecycleError,
  type WorkspaceEmbeddingProfileState,
} from "./domain/profileLifecycle.js";
export {
  EmbeddingVectorContractError,
} from "./services/embeddingVectorValidator.js";
export {
  EmbeddingTransitionCoordinator,
  EmbeddingTransitionCoordinatorError,
  FixedInputEmbeddingValidationError,
  type FixedInputEmbeddingValidationPort,
} from "./services/embeddingTransitionCoordinator.js";
export {
  EmbeddingCoverageReconciler,
} from "./services/embeddingCoverageReconciler.js";
export type {
  EmbeddingCoverageReadPort,
  WorkspaceCanonicalEmbeddingCoverage,
} from "./contracts/embeddingCoverage.js";
export {
  EmbeddingProfileCleanupService,
  type EmbeddingProfileProjectionCleanupPort,
} from "./services/embeddingProfileCleanupService.js";
export * from "./copilotPrimitiveRegistry.js";
