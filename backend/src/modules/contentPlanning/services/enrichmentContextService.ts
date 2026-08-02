import { createHash } from "node:crypto";

import type { QualityContentPlanningEvidenceSourcePort } from "../../quality/contracts/contentPlanningEvidence.js";
import type { ContentPlanCorpusState } from "../contracts/index.js";
import { selectRecommendationAction } from "../domain/opportunityPolicy.js";
import type { ObservationSemanticSourceLoader } from "./observationSourceLoader.js";
import type { ContentPlanningCorpusEvidenceService } from "./corpusEvidenceService.js";
import type {
  ContentPlanEnrichmentClaim,
  ContentPlanEnrichmentContextPort,
  ContentPlanEnrichmentProcessingContext,
} from "./enrichmentProcessor.js";

const QUALITY_EVIDENCE_BATCH_SIZE = 500;
const MAX_DOCUMENT_IDS_PER_ANSWER = 100;

export interface ContentPlanEnrichmentTopicMember {
  observationId: string;
  assistantMessageId: string;
  conversationId: string;
  observedAt: string;
  assistantMetadata: Record<string, unknown> | null;
}

export interface ContentPlanEnrichmentTopicContext {
  workspaceId: string;
  generationId: string;
  topicId: string;
  topicRevision: number;
  lifecycle: "provisional" | "mature" | "merged" | "retired";
  embeddingSpaceId: string;
  centroid: number[];
  representativeObservationIds: string[];
  members: ContentPlanEnrichmentTopicMember[];
}

export interface ContentPlanEnrichmentTopicContextSourcePort {
  load(claim: ContentPlanEnrichmentClaim): Promise<ContentPlanEnrichmentTopicContext | null>;
}

type QualityEvidencePort = Pick<
  QualityContentPlanningEvidenceSourcePort,
  "getEvidenceByAssistantMessageIds"
>;

type SampleLoader = Pick<ObservationSemanticSourceLoader, "load">;
type CorpusService = Pick<ContentPlanningCorpusEvidenceService, "refresh">;

export class ContentPlanningEnrichmentContextService implements ContentPlanEnrichmentContextPort {
  private readonly clock: () => Date;

  constructor(private readonly dependencies: {
    source: ContentPlanEnrichmentTopicContextSourcePort;
    qualityEvidence: QualityEvidencePort;
    samples: SampleLoader;
    corpus: CorpusService;
    clock?: () => Date;
  }) {
    this.clock = dependencies.clock ?? (() => new Date());
  }

  async load(claim: ContentPlanEnrichmentClaim): Promise<ContentPlanEnrichmentProcessingContext | null> {
    const topic = await this.dependencies.source.load(claim);
    if (!isCurrentClaimTopic(topic, claim)) return null;

    const sampleBatch = await this.dependencies.samples.load({
      workspaceId: claim.workspaceId,
      observationIds: topic.representativeObservationIds,
    });
    const samples = sampleBatch.items.flatMap((item) => item.resolution.status === "resolved"
      ? [{ observationId: item.observationId, question: item.resolution.semanticText }]
      : []);
    if (samples.length === 0) return null;

    const evidenceByAssistantMessageId = await this.loadQualityEvidence(
      claim.workspaceId,
      topic.members.map((member) => member.assistantMessageId),
    );
    const activeGapMembers = topic.members.filter((member) => {
      const evidence = evidenceByAssistantMessageId.get(member.assistantMessageId);
      return evidence?.remediation.active === true
        && (evidence.grounding?.verdict === "degraded" || evidence.grounding?.verdict === "no_support");
    });
    const retrievedDocumentIds = new Set<string>();
    const citedDocumentIds = new Set<string>();
    for (const member of activeGapMembers) {
      const documents = extractAnswerDocumentIds(member.assistantMetadata);
      documents.retrieved.forEach((documentId) => retrievedDocumentIds.add(documentId));
      documents.cited.forEach((documentId) => citedDocumentIds.add(documentId));
    }

    const corpus = await this.dependencies.corpus.refresh({
      workspaceId: claim.workspaceId,
      generationId: claim.generationId,
      topicId: claim.topicId,
      sourceTopicRevision: claim.sourceTopicRevision,
      embeddingSpaceId: topic.embeddingSpaceId,
      centroid: topic.centroid,
      earliestActiveGapAt: earliestTimestamp(activeGapMembers.map((member) => member.observedAt)),
      retrievedDocumentIds: [...retrievedDocumentIds].sort(),
      citedDocumentIds: [...citedDocumentIds].sort(),
    });
    const corpusState = corpus.state;
    const action = selectRecommendationAction({
      credibleGap: claim.sourceEvidence.credibleOpportunity,
      corpus: {
        state: corpusState,
        documents: corpus.documents.map((document) => ({
          possibleRelevance: document.possibleRelevance,
          existedBeforeGap: document.evidence.existedBeforeGap,
          retrievedByGapAnswers: document.evidence.retrievedByGapAnswers,
          citedByGapAnswers: document.evidence.citedByGapAnswers,
          changedAfterGap: document.evidence.changedAfterGap,
        })),
      },
    });
    return {
      analysisMode: claim.analysisMode,
      recommendationState: claim.recommendationState,
      samples,
      action,
      corpusState,
      corpusCheckedAt: this.clock(),
      sourceEvidence: claim.sourceEvidence,
      evidenceStrength: claim.evidenceStrength,
      corpusEvidenceFingerprint: contentPlanCorpusEvidenceFingerprint(corpus),
    };
  }

  private async loadQualityEvidence(
    workspaceId: string,
    assistantMessageIds: string[],
  ) {
    const unique = [...new Set(assistantMessageIds)];
    const combined = new Map<
      string,
      Awaited<ReturnType<QualityEvidencePort["getEvidenceByAssistantMessageIds"]>> extends ReadonlyMap<string, infer V>
        ? V
        : never
    >();
    for (let offset = 0; offset < unique.length; offset += QUALITY_EVIDENCE_BATCH_SIZE) {
      const batch = unique.slice(offset, offset + QUALITY_EVIDENCE_BATCH_SIZE);
      const result = await this.dependencies.qualityEvidence.getEvidenceByAssistantMessageIds(workspaceId, batch);
      for (const [assistantMessageId, evidence] of result) {
        combined.set(assistantMessageId, evidence);
      }
    }
    return combined;
  }
}

export const contentPlanCorpusEvidenceFingerprint = (
  corpus: {
    state: ContentPlanCorpusState;
    documents: ReadonlyArray<{
      id: string;
      updatedAt: string;
      possibleRelevance: number;
      evidence: {
        existedBeforeGap: boolean;
        retrievedByGapAnswers: boolean;
        citedByGapAnswers: boolean;
        changedAfterGap: boolean;
      };
    }>;
  },
): string => createHash("sha256")
  .update(JSON.stringify({
    state: corpus.state,
    documents: [...corpus.documents]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((document) => ({
        id: document.id,
        updatedAt: document.updatedAt,
        possibleRelevance: document.possibleRelevance,
        existedBeforeGap: document.evidence.existedBeforeGap,
        retrievedByGapAnswers: document.evidence.retrievedByGapAnswers,
        citedByGapAnswers: document.evidence.citedByGapAnswers,
        changedAfterGap: document.evidence.changedAfterGap,
      })),
  }))
  .digest("hex");

const isCurrentClaimTopic = (
  topic: ContentPlanEnrichmentTopicContext | null,
  claim: ContentPlanEnrichmentClaim,
): topic is ContentPlanEnrichmentTopicContext => topic !== null
  && topic.workspaceId === claim.workspaceId
  && topic.generationId === claim.generationId
  && topic.topicId === claim.topicId
  && topic.topicRevision === claim.sourceTopicRevision
  && topic.lifecycle === "mature"
  && topic.centroid.length > 0
  && topic.centroid.every(Number.isFinite);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const documentIds = (value: unknown): string[] => {
  if (!Array.isArray(value)) return [];
  const ids: string[] = [];
  for (const candidate of value.slice(0, MAX_DOCUMENT_IDS_PER_ANSWER)) {
    if (!isRecord(candidate) || typeof candidate.documentId !== "string") continue;
    const documentId = candidate.documentId.trim();
    if (documentId.length > 0 && documentId.length <= 128) ids.push(documentId);
  }
  return [...new Set(ids)];
};

const extractAnswerDocumentIds = (
  metadata: Record<string, unknown> | null,
): { retrieved: string[]; cited: string[] } => ({
  retrieved: documentIds(metadata?.retrievedChunks),
  cited: documentIds(metadata?.citations),
});

const earliestTimestamp = (values: string[]): string | null => {
  let earliest: { value: string; timestamp: number } | null = null;
  for (const value of values) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp) && (earliest === null || timestamp < earliest.timestamp)) {
      earliest = { value: new Date(timestamp).toISOString(), timestamp };
    }
  }
  return earliest?.value ?? null;
};
