import type { ContentPlanEnrichmentRepositoryPort } from "../contracts/persistence.js";
import type { ContentPlanEnrichmentPublicationPort } from "../services/enrichmentProcessor.js";
import type { ContentPlanEnrichmentQueuePort } from "../services/enrichmentScheduler.js";
import type { ContentPlanEnrichmentClaimSourcePort } from "../services/enrichmentJobRunner.js";

export class RepositoryContentPlanEnrichmentQueue implements ContentPlanEnrichmentQueuePort {
  constructor(private readonly repository: ContentPlanEnrichmentRepositoryPort) {}

  async queue(input: Parameters<ContentPlanEnrichmentQueuePort["queue"]>[0]): Promise<boolean> {
    const queued = await this.repository.queueEnrichment({
      workspaceId: input.workspaceId,
      generationId: input.generationId,
      topicId: input.topicId,
      sourceTopicRevision: input.sourceTopicRevision,
      sourceEvidence: input.sourceEvidence,
      sourceEvidenceStrength: input.evidenceStrength,
      sourceCorpusEvidenceFingerprint: input.sourceCorpusEvidenceFingerprint,
      analysisMode: input.analysisMode,
      publishState: input.recommendationState,
      actionRuleVersion: 1,
      availableAt: input.availableAt,
    });
    return queued !== null;
  }
}

export class RepositoryContentPlanEnrichmentClaimSource
implements ContentPlanEnrichmentClaimSourcePort {
  constructor(private readonly repository: ContentPlanEnrichmentRepositoryPort) {}

  async claimBatch(input: Parameters<ContentPlanEnrichmentClaimSourcePort["claimBatch"]>[0]) {
    const records = await this.repository.claimEnrichmentBatch(input);
    return records.flatMap((record) => record.claimToken
      ? [{
          workspaceId: record.workspaceId,
          generationId: record.generationId,
          topicId: record.topicId,
          sourceTopicRevision: record.sourceTopicRevision,
          attemptCount: record.attemptCount,
          claimToken: record.claimToken,
          analysisMode: record.analysisMode,
          recommendationState: record.publishState,
          sourceEvidence: record.sourceEvidence,
          evidenceStrength: record.sourceEvidenceStrength,
        }]
      : []);
  }
}

export class RepositoryContentPlanEnrichmentPublication
implements ContentPlanEnrichmentPublicationPort {
  constructor(private readonly repository: ContentPlanEnrichmentRepositoryPort) {}

  publish(input: Parameters<ContentPlanEnrichmentPublicationPort["publish"]>[0]): Promise<boolean> {
    return this.repository.publishEnrichment({
      ...input,
      sourceCorpusEvidenceFingerprint: input.corpusEvidenceFingerprint,
    });
  }

  fail(input: Parameters<ContentPlanEnrichmentPublicationPort["fail"]>[0]): Promise<boolean> {
    return this.repository.failEnrichmentClaim(input);
  }
}
