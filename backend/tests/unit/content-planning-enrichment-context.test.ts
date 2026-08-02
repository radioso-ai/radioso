import { describe, expect, it, vi } from "vitest";

import {
  ContentPlanningEnrichmentContextService,
  contentPlanCorpusEvidenceFingerprint,
  type ContentPlanEnrichmentTopicContext,
} from "../../src/modules/contentPlanning/services/enrichmentContextService.js";
import type { ContentPlanEnrichmentClaim } from "../../src/modules/contentPlanning/services/enrichmentProcessor.js";
import type { QualityContentPlanningTurnEvidence } from "../../src/modules/quality/contentPlanningEvidence.js";

const claim = (): ContentPlanEnrichmentClaim => ({
  workspaceId: "workspace_1",
  generationId: "generation_1",
  topicId: "topic_1",
  sourceTopicRevision: 4,
  attemptCount: 1,
  claimToken: "claim_1",
  analysisMode: "label_and_brief",
  recommendationState: "ready",
  sourceEvidence: {
    memberCount: 4,
    groundedCount: 1,
    degradedCount: 1,
    noSupportCount: 2,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  },
  evidenceStrength: "low",
});

const topicContext = (): ContentPlanEnrichmentTopicContext => ({
  workspaceId: "workspace_1",
  generationId: "generation_1",
  topicId: "topic_1",
  topicRevision: 4,
  lifecycle: "mature",
  embeddingSpaceId: "space_1",
  centroid: [1, 0],
  representativeObservationIds: ["observation_1", "observation_2", "observation_deleted"],
  members: [
    {
      observationId: "observation_1",
      assistantMessageId: "assistant_1",
      conversationId: "conversation_1",
      observedAt: "2026-07-20T10:00:00.000Z",
      assistantMetadata: {
        retrievedChunks: [{ documentId: "document_1" }, { documentId: "document_2" }],
        citations: [{ documentId: "document_1" }],
      },
    },
    {
      observationId: "observation_2",
      assistantMessageId: "assistant_2",
      conversationId: "conversation_2",
      observedAt: "2026-07-21T10:00:00.000Z",
      assistantMetadata: {
        retrievedChunks: [{ documentId: "document_2" }, { documentId: "document_3" }],
        citations: [{ documentId: "document_3" }],
      },
    },
    {
      observationId: "observation_3",
      assistantMessageId: "assistant_3",
      conversationId: "conversation_3",
      observedAt: "2026-07-22T10:00:00.000Z",
      assistantMetadata: { retrievedChunks: [{ documentId: "document_ignored" }] },
    },
  ],
});

describe("Content Planning enrichment context", () => {
  it("hydrates bounded semantic samples and derives corpus action from active gap answers", async () => {
    const refresh = vi.fn(async () => ({
      state: "ready" as const,
      documents: [{
        id: "document_1",
        title: "Deployments",
        updatedAt: "2026-07-01T00:00:00.000Z",
        possibleRelevance: 0.91,
        evidence: {
          existedBeforeGap: true,
          retrievedByGapAnswers: true,
          citedByGapAnswers: true,
          changedAfterGap: false,
        },
      }],
    }));
    const service = new ContentPlanningEnrichmentContextService({
      source: { load: vi.fn(async () => topicContext()) },
      qualityEvidence: {
        getEvidenceByAssistantMessageIds: vi.fn(async () => new Map([
          ["assistant_1", evidence("assistant_1", "no_support", true)],
          ["assistant_2", evidence("assistant_2", "degraded", true)],
          ["assistant_3", evidence("assistant_3", "grounded", false)],
        ])),
      },
      samples: {
        load: vi.fn(async () => ({
          items: [
            {
              observationId: "observation_1",
              resolution: {
                status: "resolved" as const,
                source: "message_metadata" as const,
                semanticIntentId: "primary",
                semanticText: "How do deployments work?",
                semanticTextHash: "a".repeat(64),
              },
            },
            {
              observationId: "observation_2",
              resolution: {
                status: "resolved" as const,
                source: "message_metadata" as const,
                semanticIntentId: "primary",
                semanticText: "Who can change deployment controls?",
                semanticTextHash: "b".repeat(64),
              },
            },
            {
              observationId: "observation_deleted",
              resolution: { status: "unavailable" as const, reason: "source_unavailable" as const },
            },
          ],
          requestedCount: 3,
          loadedCount: 2,
          truncatedCount: 0,
        })),
      },
      corpus: { refresh },
    });

    const result = await service.load(claim());

    expect(refresh).toHaveBeenCalledWith(expect.objectContaining({
      earliestActiveGapAt: "2026-07-20T10:00:00.000Z",
      retrievedDocumentIds: ["document_1", "document_2", "document_3"],
      citedDocumentIds: ["document_1", "document_3"],
    }));
    expect(result).toMatchObject({
      analysisMode: "label_and_brief",
      recommendationState: "ready",
      action: "review_existing_content",
      corpusState: "ready",
      sourceEvidence: { memberCount: 4, credibleOpportunity: true },
      evidenceStrength: "low",
      samples: [
        { observationId: "observation_1", question: "How do deployments work?" },
        { observationId: "observation_2", question: "Who can change deployment controls?" },
      ],
    });
    expect(result?.corpusEvidenceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(result)).not.toContain("document_ignored");
  });

  it("returns null before provider work when the topic revision is stale or no source sample survives", async () => {
    const qualityEvidence = { getEvidenceByAssistantMessageIds: vi.fn() };
    const corpus = { refresh: vi.fn() };
    const stale = new ContentPlanningEnrichmentContextService({
      source: { load: vi.fn(async () => ({ ...topicContext(), topicRevision: 5 })) },
      qualityEvidence,
      samples: { load: vi.fn() },
      corpus,
    });
    await expect(stale.load(claim())).resolves.toBeNull();
    expect(qualityEvidence.getEvidenceByAssistantMessageIds).not.toHaveBeenCalled();

    const missing = new ContentPlanningEnrichmentContextService({
      source: { load: vi.fn(async () => topicContext()) },
      qualityEvidence: {
        getEvidenceByAssistantMessageIds: vi.fn(async () => new Map([
          ["assistant_1", evidence("assistant_1", "no_support", true)],
          ["assistant_2", evidence("assistant_2", "degraded", true)],
          ["assistant_3", evidence("assistant_3", "grounded", false)],
        ])),
      },
      samples: {
        load: vi.fn(async () => ({
          items: [], requestedCount: 3, loadedCount: 0, truncatedCount: 0,
        })),
      },
      corpus,
    });
    await expect(missing.load(claim())).resolves.toBeNull();
    expect(corpus.refresh).not.toHaveBeenCalled();
  });

  it("keeps corpus-unavailable actions unavailable and fingerprints typed state without text", async () => {
    const first = contentPlanCorpusEvidenceFingerprint({ state: "unavailable", documents: [] });
    const second = contentPlanCorpusEvidenceFingerprint({ state: "unavailable", documents: [] });
    expect(first).toBe(second);
    expect(first).toMatch(/^[0-9a-f]{64}$/);

    const service = new ContentPlanningEnrichmentContextService({
      source: { load: vi.fn(async () => topicContext()) },
      qualityEvidence: {
        getEvidenceByAssistantMessageIds: vi.fn(async () => new Map([
          ["assistant_1", evidence("assistant_1", "no_support", true)],
          ["assistant_2", evidence("assistant_2", "degraded", true)],
          ["assistant_3", evidence("assistant_3", "grounded", false)],
        ])),
      },
      samples: {
        load: vi.fn(async () => ({
          items: [{
            observationId: "observation_1",
            resolution: {
              status: "resolved" as const,
              source: "message_metadata" as const,
              semanticIntentId: "primary",
              semanticText: "A bounded question",
              semanticTextHash: "c".repeat(64),
            },
          }],
          requestedCount: 3,
          loadedCount: 1,
          truncatedCount: 0,
        })),
      },
      corpus: { refresh: vi.fn(async () => ({ state: "unavailable" as const, documents: [] as [] })) },
    });

    await expect(service.load(claim())).resolves.toMatchObject({
      action: null,
      corpusState: "unavailable",
      corpusEvidenceFingerprint: first,
    });
  });
});

const evidence = (
  assistantMessageId: string,
  verdict: "grounded" | "degraded" | "no_support",
  active: boolean,
): QualityContentPlanningTurnEvidence => ({
  assistantMessageId,
  conversationId: `conversation_${assistantMessageId}`,
  agentId: null,
  channel: null,
  createdAt: "2026-07-20T10:00:00.000Z",
  grounding: {
    verdict,
    claimCount: 1,
    sourcedClaimCount: verdict === "grounded" ? 1 : 0,
    unsourcedClaimCount: verdict === "grounded" ? 0 : 1,
    invalidSourceCount: 0,
  },
  triage: { state: "open", resolutionReason: null, reopenedByNewerNegativeFeedback: false },
  verification: null,
  remediation: { active, inactiveReasons: [] },
});
