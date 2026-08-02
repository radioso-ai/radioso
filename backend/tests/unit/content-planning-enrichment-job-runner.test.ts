import { describe, expect, it, vi } from "vitest";

import {
  CONTENT_PLAN_ENRICHMENT_JOB_POLICY_V1,
  ContentPlanningEnrichmentJobRunner,
} from "../../src/modules/contentPlanning/services/enrichmentJobRunner.js";
import type { ContentPlanEnrichmentClaim } from "../../src/modules/contentPlanning/services/enrichmentProcessor.js";

describe("Content Planning enrichment job runner", () => {
  it("claims a small batch and processes it sequentially without aborting on typed outcomes", async () => {
    const calls: string[] = [];
    const claims = [claim("topic_1"), claim("topic_2")];
    const process = vi.fn(async (item: ContentPlanEnrichmentClaim) => {
      calls.push(item.topicId);
      return item.topicId === "topic_1"
        ? { status: "published" as const }
        : { status: "retry_scheduled" as const };
    });
    const claimBatch = vi.fn(async () => claims);
    const record = vi.fn();
    const runner = new ContentPlanningEnrichmentJobRunner({
      claims: { claimBatch },
      processor: { process },
      observability: { record },
      clock: () => new Date("2026-08-02T12:00:00.000Z"),
    });

    await expect(runner.runOnce({ workspaceId: "workspace_1" })).resolves.toEqual({
      claimedCount: 2,
      outcomes: { published: 1, stale: 0, retry_scheduled: 1, terminal_failure: 0 },
    });
    expect(claimBatch).toHaveBeenCalledWith({
      workspaceId: "workspace_1",
      limit: 2,
      now: new Date("2026-08-02T12:00:00.000Z"),
      leaseMs: 600_000,
    });
    expect(calls).toEqual(["topic_1", "topic_2"]);
    expect(CONTENT_PLAN_ENRICHMENT_JOB_POLICY_V1.batchSize).toBe(2);
    expect(record).toHaveBeenCalledWith({
      stage: "enrichment",
      outcome: "claimed",
      workspaceId: "workspace_1",
      itemCount: 2,
    });
  });

  it("records a typed claim failure without logging the repository error", async () => {
    const record = vi.fn();
    const runner = new ContentPlanningEnrichmentJobRunner({
      claims: { claimBatch: vi.fn(async () => { throw new Error("secret provider body"); }) },
      processor: { process: vi.fn() },
      observability: { record },
    });

    await expect(runner.runOnce({ workspaceId: "workspace_1", generationId: "generation_1" }))
      .rejects.toThrow("secret provider body");
    expect(record).toHaveBeenCalledWith({
      stage: "enrichment",
      outcome: "retry_scheduled",
      reason: "enrichment_claim_failed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
    });
    expect(JSON.stringify(record.mock.calls)).not.toContain("secret provider body");
  });
});

const claim = (topicId: string): ContentPlanEnrichmentClaim => ({
  workspaceId: "workspace_1",
  generationId: "generation_1",
  topicId,
  sourceTopicRevision: 4,
  attemptCount: 1,
  claimToken: `claim_${topicId}`,
  analysisMode: "label_only",
  recommendationState: "ready",
  sourceEvidence: {
    memberCount: 2,
    groundedCount: 0,
    degradedCount: 1,
    noSupportCount: 1,
    notEvaluatedCount: 0,
    credibleOpportunity: true,
  },
  evidenceStrength: "low",
});
