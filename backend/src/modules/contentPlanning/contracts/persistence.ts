import type { ConversationInteractionRole } from "@radioso/conversation-contract";

import type { GroundingDiagnosticSnapshot } from "../../../shared/domain/groundingDiagnostic.js";
import type {
  QualityContentPlanningPopulationCursor,
  QualityContentPlanningPopulationPage,
  QualityContentPlanningWindow,
} from "../../quality/contracts/contentPlanningEvidence.js";

export const MAX_CONTENT_PLAN_TURN_CONTRIBUTIONS = 4;
export const MAX_CONTENT_PLAN_SOURCE_HYDRATION = 8;
export const MAX_CONTENT_PLAN_RELATED_DOCUMENTS = 5;
export const MAX_CONTENT_PLAN_REDIRECT_HOPS = 8;
export const MAX_CONTENT_PLAN_CLAIM_BATCH = 100;

export type ContentPlanObservationState = "pending_context" | "ready" | "excluded" | "deleted";
export type ContentPlanObservationVectorState =
  | "pending_embedding"
  | "ready"
  | "processing"
  | "assigned"
  | "retryable"
  | "failed";
export type ContentPlanVectorSource = "reused" | "fallback";
export type ContentPlanGenerationKind = "bootstrap" | "active" | "reprojection";
export type ContentPlanGenerationState = "building" | "coherent" | "superseded" | "failed";
export type ContentPlanTopicLifecycle = "provisional" | "mature" | "merged" | "retired";
export type ContentPlanStoredEnrichmentState =
  | "pending"
  | "ready"
  | "stale"
  | "unavailable"
  | "outside_analysis_cap";
export type ContentPlanStoredCorpusState = "pending" | "ready" | "unavailable" | "stale";
export type ContentPlanStoredEvidenceStrength = "none" | "low" | "medium" | "high";
export type ContentPlanEnrichmentAnalysisMode = "label_and_brief" | "label_only";
export type ContentPlanEnrichmentPublishState = "ready" | "outside_analysis_cap";
export type ContentPlanStoredProjectionState =
  | "bootstrapping"
  | "ready"
  | "updating"
  | "delayed"
  | "reprojecting"
  | "degraded"
  | "budget_paused";
export type ContentPlanProjectionReason =
  | "daily_budget_exhausted"
  | "projection_work_pending"
  | "projection_backlog_delayed"
  | "projection_terminal_failure";
export type ContentPlanStoredRecommendationAction =
  | "add_content"
  | "review_existing_content"
  | "investigate_retrieval"
  | "monitor";
export type ContentPlanSuggestedShape = "guide" | "faq" | "reference" | "policy" | "troubleshooting";

export interface ContentPlanObservationRecord {
  id: string;
  workspaceId: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  conversationId: string;
  semanticIntentId: string;
  semanticTextHash: string | null;
  interactionRole: ConversationInteractionRole;
  grounding: GroundingDiagnosticSnapshot | null;
  resolutionDeadline: Date | null;
  observationState: ContentPlanObservationState;
  excludedReason: string | null;
  observedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPlanObservationVectorRecord {
  workspaceId: string;
  observationId: string;
  generationId: string;
  embeddingSpaceId: string;
  dimensions: number | null;
  embedding: number[] | null;
  vectorSource: ContentPlanVectorSource | null;
  state: ContentPlanObservationVectorState;
  attemptCount: number;
  availableAt: Date;
  claimToken: string | null;
  claimedAt: Date | null;
  claimExpiresAt: Date | null;
  failureStage: string | null;
  failureReason: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPlanVectorWorkInput {
  generationId: string;
  embeddingSpaceId: string;
  dimensions?: number;
  embedding?: readonly number[];
  vectorSource?: ContentPlanVectorSource;
}

export type ContentPlanTurnContribution =
  | {
      semanticIntentId: string;
      semanticTextHash: string;
      observationState: "ready";
      vectorWork: ContentPlanVectorWorkInput;
    }
  | {
      semanticIntentId: "unresolved";
      semanticTextHash: string | null;
      observationState: "pending_context";
      resolutionDeadline: Date;
      vectorWork?: never;
    }
  | {
      semanticIntentId: string;
      semanticTextHash: string | null;
      observationState: "excluded";
      excludedReason: string;
      vectorWork?: never;
    };

export interface ContentPlanTurnRegistration {
  workspaceId: string;
  conversationId: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  interactionRole: ConversationInteractionRole;
  contributions: readonly ContentPlanTurnContribution[];
}

export interface ContentPlanTurnRegistrationResult {
  observations: ContentPlanObservationRecord[];
  acceptedCount: number;
  duplicateCount: number;
  truncatedCount: number;
}

export interface ContentPlanFinalizePendingContextInput {
  workspaceId: string;
  observationId: string;
  sourceAssistantMessageId: string;
  semanticIntentId: string;
  semanticTextHash: string;
  interactionRole: Extract<
    ConversationInteractionRole,
    "substantive_new" | "substantive_followup" | "clarification_value"
  >;
  vectorWork: ContentPlanVectorWorkInput;
  resolvedAt: Date;
}

export interface ContentPlanObservationSourceRecord {
  observationId: string;
  conversationId: string;
  semanticIntentId: string;
  semanticTextHash: string | null;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  sourceUserContent: string;
  sourceUserMetadata: Record<string, unknown> | null;
  sourceAssistantMetadata: Record<string, unknown> | null;
  auditMetadata: Record<string, unknown> | null;
  observedAt: Date;
  grounding: GroundingDiagnosticSnapshot | null;
}

export interface ContentPlanObservationIntakePort {
  registerTurn(input: ContentPlanTurnRegistration): Promise<ContentPlanTurnRegistrationResult>;
  findPendingContext(input: {
    workspaceId: string;
    conversationId: string;
    sourceUserMessageId?: string;
    asOf: Date;
  }): Promise<ContentPlanObservationRecord | null>;
  finalizePendingContext(
    input: ContentPlanFinalizePendingContextInput,
  ): Promise<ContentPlanObservationRecord | null>;
  excludePendingContext(input: {
    workspaceId: string;
    observationId: string;
    excludedReason: string;
    sourceAssistantMessageId?: string;
  }): Promise<ContentPlanObservationRecord | null>;
}

export interface ContentPlanObservationWorkPort {
  claimVectorBatch(input: {
    workspaceId?: string;
    generationId?: string;
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanObservationVectorRecord[]>;
  storeClaimedEmbedding(input: {
    workspaceId: string;
    observationId: string;
    generationId: string;
    claimToken: string;
    dimensions: number;
    embedding: readonly number[];
    vectorSource: ContentPlanVectorSource;
  }): Promise<boolean>;
  failVectorClaim(input: {
    workspaceId: string;
    observationId: string;
    generationId: string;
    claimToken: string;
    terminal: boolean;
    failureStage: string;
    failureReason: string;
    availableAt: Date;
  }): Promise<boolean>;
}

export interface ContentPlanObservationSourcePort {
  loadSources(input: {
    workspaceId: string;
    observationIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanObservationSourceRecord[]>;
}

export interface ContentPlanObservationRetentionPort {
  expirePendingContexts(input: {
    workspaceId: string;
    now: Date;
    limit: number;
  }): Promise<number>;
  pruneExpiredObservations(input: {
    workspaceId: string;
    observedBefore: Date;
    limit: number;
  }): Promise<{
    deletedCount: number;
    affectedTopics: ContentPlanAffectedTopic[];
  }>;
}

export interface ContentPlanProjectionGenerationRecord {
  id: string;
  workspaceId: string;
  embeddingSpaceId: string;
  kind: ContentPlanGenerationKind;
  state: ContentPlanGenerationState;
  policyVersion: number;
  horizonFrom: Date;
  horizonTo: Date;
  coherentAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPlanProjectionStateRecord {
  workspaceId: string;
  coherentGenerationId: string | null;
  targetGenerationId: string | null;
  projectionState: ContentPlanStoredProjectionState;
  reason: ContentPlanProjectionReason | null;
  discoveryCreatedAt: Date | null;
  discoveryMessageId: string | null;
  processedThrough: Date | null;
  bootstrapProcessed: string | null;
  bootstrapTotal: string | null;
  budgetVersion: number;
  budgetWindowStartedAt: Date;
  embeddingRequestsUsed: number;
  estimatedSpendMicros: string;
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export type ContentPlanProjectionTargetResolution =
  | {
      kind: "coherent";
      generation: ContentPlanProjectionGenerationRecord;
    }
  | {
      kind: "target";
      generation: ContentPlanProjectionGenerationRecord;
    };

export type ContentPlanProjectionBudgetReservation =
  | { kind: "granted" }
  | { kind: "budget_paused"; reason: "daily_budget_exhausted" };

export interface ContentPlanProjectionBudgetPort {
  reserve(input: {
    workspaceId: string;
    generationId: string;
    requests: number;
    estimatedSpendMicros: number;
    now: Date;
  }): Promise<ContentPlanProjectionBudgetReservation>;
}

export interface ContentPlanHistoricalTurnRegistration {
  conversationId: string;
  sourceChannel?: string;
  sourceUserMessageId: string;
  sourceAssistantMessageId: string;
  interaction: {
    role: ConversationInteractionRole;
    semanticIntents: ReadonlyArray<{ id: string; text: string }>;
  };
}

export interface ContentPlanProjectionDiscoveryPort {
  capturePopulationSnapshot(input: {
    workspaceId: string;
    generationId: string;
    leaseToken: string;
    window: QualityContentPlanningWindow;
  }): Promise<{ total: number } | null>;
  listPopulationSnapshotPage(input: {
    workspaceId: string;
    generationId: string;
    window: QualityContentPlanningWindow;
    cursor?: QualityContentPlanningPopulationCursor;
    limit: number;
  }): Promise<QualityContentPlanningPopulationPage>;
  reconcilePopulationSnapshotProgress(input: {
    workspaceId: string;
    generationId: string;
    leaseToken: string;
    cursor?: { createdAt: Date; assistantMessageId: string };
    processed: number;
  }): Promise<{ processed: number; total: number } | null>;
  commitPage(input: {
    workspaceId: string;
    generationId: string;
    leaseToken: string;
    turns: readonly ContentPlanHistoricalTurnRegistration[];
    cursor: {
      createdAt: Date;
      assistantMessageId: string;
    };
    processed: number;
    total: number;
  }): Promise<{
    acceptedCount: number;
    duplicateCount: number;
    excludedCount: number;
  }>;
}

export interface ContentPlanProjectionRepositoryPort {
  createGeneration(input: Omit<ContentPlanProjectionGenerationRecord, "createdAt" | "updatedAt">):
    Promise<ContentPlanProjectionGenerationRecord>;
  findGeneration(id: string, workspaceId: string): Promise<ContentPlanProjectionGenerationRecord | null>;
  ensureTargetGeneration(input: {
    workspaceId: string;
    embeddingSpaceId: string;
    generationId: string;
    policyVersion: number;
    horizonFrom: Date;
    horizonTo: Date;
    total: string | null;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionTargetResolution>;
  ensureTargetGenerationForIntake(input: {
    workspaceId: string;
    preferredEmbeddingSpaceId: string | undefined;
    generationId: string;
    policyVersion: number;
    horizonFrom: Date;
    horizonTo: Date;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionGenerationRecord | null>;
  upsertProjectionState(input: {
    workspaceId: string;
    coherentGenerationId: string | null;
    targetGenerationId: string | null;
    projectionState: ContentPlanStoredProjectionState;
    reason: ContentPlanProjectionReason | null;
    processedThrough: Date | null;
    bootstrapProcessed: string | null;
    bootstrapTotal: string | null;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
  }): Promise<ContentPlanProjectionStateRecord>;
  markProjectionWorkPending(input: {
    workspaceId: string;
    generationId: string;
    observedAt: Date;
  }): Promise<boolean>;
  refreshProjectionFreshness(input: {
    workspaceId: string;
    generationId: string;
    now: Date;
    delayedAfterMs: number;
    scanLimit: number;
  }): Promise<ContentPlanProjectionStateRecord | null>;
  findProjectionState(workspaceId: string): Promise<ContentPlanProjectionStateRecord | null>;
  resolveWritableGeneration(input: {
    workspaceId: string;
    embeddingSpaceId?: string;
  }): Promise<ContentPlanProjectionGenerationRecord | null>;
  claimProjectionLease(input: {
    workspaceId: string;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanProjectionStateRecord | null>;
  releaseProjectionLease(input: {
    workspaceId: string;
    leaseToken: string;
  }): Promise<boolean>;
  initializeTargetProgress(input: {
    workspaceId: string;
    targetGenerationId: string;
    leaseToken: string;
    total: string;
  }): Promise<ContentPlanProjectionStateRecord | null>;
  advanceDiscoveryCursor(input: {
    workspaceId: string;
    leaseToken: string;
    discoveryCreatedAt: Date;
    discoveryMessageId: string;
    bootstrapProcessed: string;
    bootstrapTotal: string;
  }): Promise<boolean>;
  reserveProjectionBudget(input: {
    workspaceId: string;
    generationId: string;
    budgetVersion: number;
    budgetWindowStartedAt: Date;
    requests: number;
    estimatedSpendMicros: number;
    maxRequests: number;
    maxEstimatedSpendMicros: number;
  }): Promise<ContentPlanProjectionBudgetReservation>;
  promoteGeneration(input: {
    workspaceId: string;
    targetGenerationId: string;
    expectedCoherentGenerationId: string | null;
    leaseToken: string;
    coherentAt: Date;
    processedThrough: Date;
  }): Promise<ContentPlanProjectionStateRecord | null>;
  pruneExpiredGenerations(input: {
    workspaceId: string;
    failedBefore: Date;
    supersededBefore: Date;
    limit: number;
  }): Promise<{
    failedCount: number;
    supersededCount: number;
  }>;
}

export interface ContentPlanTopicRecord {
  workspaceId: string;
  generationId: string;
  id: string;
  embeddingSpaceId: string;
  lifecycle: ContentPlanTopicLifecycle;
  centroid: number[] | null;
  dimensions: number;
  centroidWeight: number;
  representativeObservationIds: string[];
  revision: number;
  mergedIntoTopicId: string | null;
  redirectExpiresAt: Date | null;
  enrichmentDirtyAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContentPlanTopicMembershipRecord {
  workspaceId: string;
  generationId: string;
  observationId: string;
  topicId: string;
  assignmentVersion: number;
  similarity: number;
  cohesion: number;
  assignedAt: Date;
}

export interface ContentPlanNewTopicInput {
  id: string;
  embeddingSpaceId: string;
  lifecycle: "provisional" | "mature";
  centroid: readonly number[];
  dimensions: number;
  centroidWeight: number;
  representativeObservationIds: readonly string[];
  revision: number;
  enrichmentDirtyAt: Date | null;
}

export interface ContentPlanTopicAggregateUpdate {
  lifecycle: "provisional" | "mature" | "retired";
  centroid: readonly number[] | null;
  dimensions: number;
  centroidWeight: number;
  representativeObservationIds: readonly string[];
  revision: number;
  enrichmentDirtyAt: Date | null;
}

export interface ContentPlanAffectedTopic {
  workspaceId: string;
  generationId: string;
  topicId: string;
}

export interface ContentPlanNearestTopic extends Omit<ContentPlanTopicRecord, "centroid"> {
  centroid: number[];
  cosineSimilarity: number;
}

export interface ContentPlanRepresentativeVector {
  observationId: string;
  embedding: number[];
}

export interface ContentPlanTopicAssignmentEvidence {
  topicId: string;
  liveObservationCount: number;
  liveConversationCount: number;
  incomingConversationAlreadyPresent: boolean;
  representativeVectors: ContentPlanRepresentativeVector[];
}

export interface ContentPlanTopicReconciliationEvidence {
  topicId: string;
  liveCentroid: number[] | null;
  liveObservationCount: number;
  liveConversationCount: number;
  representativeObservationIds: string[];
}

export type ContentPlanTopicRedirectResult =
  | {
      kind: "active";
      topic: ContentPlanTopicRecord;
      redirectedFromTopicId: string | null;
      hops: number;
    }
  | { kind: "not_found" }
  | { kind: "cycle" };

export interface ContentPlanTopicRepositoryPort {
  findNearestTopics(input: {
    workspaceId: string;
    generationId: string;
    embeddingSpaceId: string;
    dimensions: number;
    embedding: readonly number[];
    limit: number;
  }): Promise<ContentPlanNearestTopic[]>;
  loadAssignmentEvidence(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    topicIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanTopicAssignmentEvidence[]>;
  loadReconciliationEvidence(input: {
    workspaceId: string;
    generationId: string;
    topicIds: readonly string[];
    limit: number;
  }): Promise<ContentPlanTopicReconciliationEvidence[]>;
  findTopicsNeedingReconciliation(input: {
    workspaceId: string;
    generationId?: string;
    limit: number;
  }): Promise<ContentPlanAffectedTopic[]>;
  createTopicAndAssign(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    claimToken: string;
    topic: ContentPlanNewTopicInput;
    assignmentVersion: number;
    similarity: number;
    cohesion: number;
    assignedAt: Date;
  }): Promise<{
    applied: boolean;
    topic: ContentPlanTopicRecord | null;
    membership: ContentPlanTopicMembershipRecord | null;
  }>;
  assignToExistingTopic(input: {
    workspaceId: string;
    generationId: string;
    observationId: string;
    claimToken: string;
    topicId: string;
    expectedTopicRevision: number;
    topic: ContentPlanTopicAggregateUpdate;
    assignmentVersion: number;
    similarity: number;
    cohesion: number;
    assignedAt: Date;
  }): Promise<{
    applied: boolean;
    topic: ContentPlanTopicRecord | null;
    membership: ContentPlanTopicMembershipRecord | null;
  }>;
  reconcileTopic(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    expectedRevision: number;
    topic: ContentPlanTopicAggregateUpdate;
  }): Promise<ContentPlanTopicRecord | null>;
  mergeTopics(input: {
    workspaceId: string;
    generationId: string;
    sourceTopicId: string;
    sourceExpectedRevision: number;
    survivorTopicId: string;
    survivorExpectedRevision: number;
    survivor: ContentPlanTopicAggregateUpdate;
    mergedAt: Date;
    redirectExpiresAt: Date;
  }): Promise<ContentPlanTopicRecord | null>;
  pruneExpiredRedirects(input: {
    workspaceId: string;
    generationId?: string;
    now: Date;
    limit: number;
  }): Promise<number>;
  invalidateTopic(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    expectedRevision: number;
    dirtyAt: Date;
  }): Promise<ContentPlanTopicRecord | null>;
  resolveTopicRedirect(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    now: Date;
    maxHops?: number;
  }): Promise<ContentPlanTopicRedirectResult>;
}

export interface ContentPlanTopicEnrichmentRecord {
  workspaceId: string;
  generationId: string;
  topicId: string;
  sourceTopicRevision: number;
  sourceEvidence: ContentPlanEnrichmentSourceEvidence;
  publishedSourceEvidence: ContentPlanEnrichmentSourceEvidence | null;
  sourceEvidenceStrength: ContentPlanStoredEvidenceStrength;
  publishedSourceEvidenceStrength: ContentPlanStoredEvidenceStrength | null;
  sourceCorpusEvidenceFingerprint: string | null;
  publishedSourceCorpusEvidenceFingerprint: string | null;
  analysisMode: ContentPlanEnrichmentAnalysisMode;
  publishState: ContentPlanEnrichmentPublishState;
  state: ContentPlanStoredEnrichmentState;
  label: string | null;
  description: string | null;
  suggestedTitle: string | null;
  rationale: string | null;
  questionsToAnswer: string[] | null;
  suggestedShape: ContentPlanSuggestedShape | null;
  evidenceStatement: string | null;
  action: ContentPlanStoredRecommendationAction | null;
  actionRuleVersion: number;
  corpusState: ContentPlanStoredCorpusState;
  corpusCheckedAt: Date | null;
  availableAt: Date;
  attemptCount: number;
  claimToken: string | null;
  claimExpiresAt: Date | null;
  failureStage: string | null;
  failureReason: string | null;
  enrichedAt: Date | null;
  updatedAt: Date;
}

export interface ContentPlanEnrichmentSourceEvidence {
  memberCount: number;
  groundedCount: number;
  degradedCount: number;
  noSupportCount: number;
  notEvaluatedCount: number;
  credibleOpportunity: boolean;
}

export interface ContentPlanTopicDocumentInput {
  documentId: string;
  similarity: number;
  existedBeforeGap: boolean;
  retrievedByGapAnswers: boolean;
  citedByGapAnswers: boolean;
  changedAfterGap: boolean;
}

export interface ContentPlanEnrichmentRepositoryPort {
  queueEnrichment(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    sourceEvidenceStrength: ContentPlanStoredEvidenceStrength;
    sourceCorpusEvidenceFingerprint: string | null;
    analysisMode: ContentPlanEnrichmentAnalysisMode;
    publishState: ContentPlanEnrichmentPublishState;
    actionRuleVersion: number;
    availableAt: Date;
  }): Promise<ContentPlanTopicEnrichmentRecord | null>;
  rebasePublishedEnrichment(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    sourceEvidenceStrength: ContentPlanStoredEvidenceStrength;
    sourceCorpusEvidenceFingerprint: string | null;
    analysisMode: ContentPlanEnrichmentAnalysisMode;
    publishState: ContentPlanEnrichmentPublishState;
  }): Promise<ContentPlanTopicEnrichmentRecord | null>;
  claimEnrichmentBatch(input: {
    workspaceId?: string;
    generationId?: string;
    limit: number;
    now: Date;
    leaseMs: number;
  }): Promise<ContentPlanTopicEnrichmentRecord[]>;
  markOutsideAnalysisCap(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    sourceEvidenceStrength: ContentPlanStoredEvidenceStrength;
    sourceCorpusEvidenceFingerprint: string | null;
    actionRuleVersion: number;
    availableAt: Date;
  }): Promise<boolean>;
  failEnrichmentClaim(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    claimToken: string;
    terminal: boolean;
    failureStage: string;
    failureReason: string;
    availableAt: Date;
  }): Promise<boolean>;
  publishEnrichment(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    sourceEvidence: ContentPlanEnrichmentSourceEvidence;
    sourceCorpusEvidenceFingerprint: string | null;
    claimToken: string;
    publishState: ContentPlanEnrichmentPublishState;
    label: string;
    description: string;
    suggestedTitle: string | null;
    rationale: string | null;
    questionsToAnswer: readonly string[] | null;
    suggestedShape: ContentPlanSuggestedShape | null;
    evidenceStatement: string | null;
    action: ContentPlanStoredRecommendationAction | null;
    actionRuleVersion: number;
    corpusState: ContentPlanStoredCorpusState;
    corpusCheckedAt: Date | null;
    enrichedAt: Date;
  }): Promise<boolean>;
  replaceTopicDocuments(input: {
    workspaceId: string;
    generationId: string;
    topicId: string;
    sourceTopicRevision: number;
    documents: readonly ContentPlanTopicDocumentInput[];
  }): Promise<{ applied: boolean; storedCount: number; truncatedCount: number }>;
}
