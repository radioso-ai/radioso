import { describe, expect, it, vi, type Mock } from "vitest";

import type { FacetExtractionJob, FacetExtractionJobStore } from "../../../src/modules/facets/contracts.js";
import { FacetExtractionBackgroundJobStore } from "../../../src/modules/facets/infra/facetExtractionBackgroundJobStore.js";
import type { BackgroundJobClaim } from "../../../src/shared/background-jobs/index.js";

const NOW = new Date("2026-08-04T12:00:00.000Z");
const MAX_ATTEMPTS = 3;

type StoreStub = {
  [K in keyof FacetExtractionJobStore]: Mock<FacetExtractionJobStore[K]>;
};

const buildJobsStub = (overrides: Partial<StoreStub> = {}): StoreStub => ({
  enqueue: vi.fn<FacetExtractionJobStore["enqueue"]>(async () => ({ id: "job-1", created: true })),
  enqueueMany: vi.fn<FacetExtractionJobStore["enqueueMany"]>(async () => undefined),
  claimBatch: vi.fn<FacetExtractionJobStore["claimBatch"]>(async () => []),
  markCompleted: vi.fn<FacetExtractionJobStore["markCompleted"]>(async () => true),
  markSkipped: vi.fn<FacetExtractionJobStore["markSkipped"]>(async () => true),
  markFailed: vi.fn<FacetExtractionJobStore["markFailed"]>(async () => true),
  releaseExpiredClaims: vi.fn<FacetExtractionJobStore["releaseExpiredClaims"]>(async () => 0),
  nextWorkspaceScheduledAt: vi.fn<FacetExtractionJobStore["nextWorkspaceScheduledAt"]>(async () => null),
  hasPendingWorkspaceWork: vi.fn<FacetExtractionJobStore["hasPendingWorkspaceWork"]>(async () => false),
  ...overrides,
});

const buildJob = (overrides: Partial<FacetExtractionJob> = {}): FacetExtractionJob => ({
  id: "job-1",
  messageId: "message-1",
  workspaceId: "workspace-1",
  status: "processing",
  attemptCount: 1,
  claimedAt: NOW,
  scheduledAt: NOW,
  lastError: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("FacetExtractionBackgroundJobStore", () => {
  describe("claimNext", () => {
    it("maps the claimed row into a generic claim, with the fencing token carrying claimed_at", async () => {
      const jobs = buildJobsStub({ claimBatch: vi.fn(async () => [buildJob()]) });
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      const claim = await store.claimNext({ kinds: [{ kind: "facets.extraction", leaseSeconds: 300 }] });

      expect(claim).toEqual({
        id: "job-1",
        kind: "facets.extraction",
        payload: { messageId: "message-1", workspaceId: "workspace-1" },
        attempt: 1,
        idempotencyKey: "message-1",
        token: NOW.toISOString(),
        availableAt: NOW,
      });
      expect(jobs.releaseExpiredClaims).toHaveBeenCalledWith({
        claimedAtOrBefore: expect.any(Date),
        maxAttempts: MAX_ATTEMPTS,
      });
      // `now` is omitted (the repository's own clock decides what's due); `excludeIds`
      // passes through whatever this drain has already claimed.
      expect(jobs.claimBatch).toHaveBeenCalledWith(1, undefined, undefined, undefined, undefined);
    });

    it("passes excludeIds through so this drain cannot reclaim a job it already claimed", async () => {
      const jobs = buildJobsStub({ claimBatch: vi.fn(async () => [buildJob()]) });
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      await store.claimNext({ kinds: [{ kind: "facets.extraction", leaseSeconds: 300 }], excludeIds: ["job-0"] });

      expect(jobs.claimBatch).toHaveBeenCalledWith(1, undefined, undefined, undefined, ["job-0"]);
    });

    it("returns null when there are no kinds or nothing is claimable", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      expect(await store.claimNext({ kinds: [] })).toBeNull();
      expect(await store.claimNext({ kinds: [{ kind: "facets.extraction", leaseSeconds: 300 }] })).toBeNull();
    });
  });

  it("renewLease always reports the lease as held: this table has no heartbeat to extend", async () => {
    const store = new FacetExtractionBackgroundJobStore(buildJobsStub(), MAX_ATTEMPTS);
    await expect(store.renewLease()).resolves.toBe(true);
  });

  describe("complete", () => {
    // `claimedAt` well in the past makes the telemetry duration assertions non-trivial (>0).
    const CLAIMED_AT = new Date(Date.now() - 5_000);
    const claim: BackgroundJobClaim = {
      id: "job-1",
      kind: "facets.extraction",
      payload: { messageId: "message-1", workspaceId: "workspace-1" },
      attempt: 2,
      idempotencyKey: "message-1",
      token: CLAIMED_AT.toISOString(),
      availableAt: NOW,
    };

    it("marks the row completed and emits telemetry only after that write lands", async () => {
      const jobs = buildJobsStub();
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.complete(claim)).resolves.toBe("deleted");

      expect(jobs.markCompleted).toHaveBeenCalledWith({ id: "job-1", attemptCount: 2, claimedAt: CLAIMED_AT });
      expect(jobs.markSkipped).not.toHaveBeenCalled();
      expect(emit).toHaveBeenCalledOnce();
      const [event] = emit.mock.calls[0];
      expect(event.eventType).toBe("facet.extraction.job_completed");
      expect(event.tags).toEqual({ outcome: "completed" });
      expect(event.metrics.durationMs).toBeGreaterThan(0);
    });

    it("marks the row skipped with the handler-returned reason", async () => {
      const jobs = buildJobsStub();
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.complete(claim, { skipped: "empty_message" })).resolves.toBe("deleted");

      expect(jobs.markSkipped).toHaveBeenCalledWith({ id: "job-1", attemptCount: 2, claimedAt: CLAIMED_AT }, "empty_message");
      expect(jobs.markCompleted).not.toHaveBeenCalled();
      const [event] = emit.mock.calls[0];
      expect(event.eventType).toBe("facet.extraction.job_skipped");
      expect(event.tags).toEqual({ outcome: "skipped" });
      expect(event.metadata).toEqual({ reason: "empty_message" });
    });

    it("reports a superseded claim, with no telemetry, when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markCompleted: vi.fn(async () => false) });
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.complete(claim)).resolves.toBe("superseded");

      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe("retry", () => {
    const claim: BackgroundJobClaim = {
      id: "job-1",
      kind: "facets.extraction",
      payload: { messageId: "message-1", workspaceId: "workspace-1" },
      attempt: 1,
      idempotencyKey: "message-1",
      token: NOW.toISOString(),
      availableAt: NOW,
    };

    it("schedules the retry at the delay the runtime computed, stores the sanitized error, and emits telemetry only after the write lands", async () => {
      const jobs = buildJobsStub();
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      const availableAt = await store.retry(claim, { error: "Error [provider_unavailable]", delaySeconds: 30 });

      expect(availableAt).toBeInstanceOf(Date);
      const [identity, error, scheduledAt] = jobs.markFailed.mock.calls[0];
      expect(identity).toEqual({ id: "job-1", attemptCount: 1, claimedAt: NOW });
      expect(error).toBe("Error [provider_unavailable]");
      expect(scheduledAt).toEqual(availableAt);
      expect(emit).toHaveBeenCalledOnce();
      const [event] = emit.mock.calls[0];
      expect(event.eventType).toBe("facet.extraction.job_failed");
      expect(event.tags).toEqual({ outcome: "retry_scheduled" });
      expect(event.metadata).toEqual({ reason: "Error [provider_unavailable]" });
    });

    it("returns null without scheduling or telemetry when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markFailed: vi.fn(async () => false) });
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.retry(claim, { error: "Error", delaySeconds: 30 })).resolves.toBeNull();
      expect(emit).not.toHaveBeenCalled();
    });
  });

  describe("deadLetter", () => {
    const claim: BackgroundJobClaim = {
      id: "job-1",
      kind: "facets.extraction",
      payload: { messageId: "message-1", workspaceId: "workspace-1" },
      attempt: 3,
      idempotencyKey: "message-1",
      token: NOW.toISOString(),
      availableAt: NOW,
    };

    it("parks the job terminally and tags a permanent failure distinctly from an exhausted one", async () => {
      const jobs = buildJobsStub();
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.deadLetter(claim, { error: "NonRetryableBackgroundJobError" })).resolves.toBe(true);

      expect(jobs.markFailed).toHaveBeenCalledWith(
        { id: "job-1", attemptCount: 3, claimedAt: NOW },
        "NonRetryableBackgroundJobError",
        null,
      );
      const [event] = emit.mock.calls[0];
      expect(event.tags).toEqual({ outcome: "failed_permanent" });
    });

    it("tags an attempt-budget dead letter as failed, not failed_permanent", async () => {
      const jobs = buildJobsStub();
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await store.deadLetter(claim, { error: "Error" });

      const [event] = emit.mock.calls[0];
      expect(event.tags).toEqual({ outcome: "failed" });
    });

    it("reports false, with no telemetry, when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markFailed: vi.fn(async () => false) });
      const emit = vi.fn().mockResolvedValue(undefined);
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS, { emit });

      await expect(store.deadLetter(claim, { error: "Error" })).resolves.toBe(false);
      expect(emit).not.toHaveBeenCalled();
    });
  });
});
