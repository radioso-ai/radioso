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
      expect(jobs.claimBatch).toHaveBeenCalledWith(1, expect.any(Date));
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
    const claim: BackgroundJobClaim = {
      id: "job-1",
      kind: "facets.extraction",
      payload: { messageId: "message-1", workspaceId: "workspace-1" },
      attempt: 2,
      idempotencyKey: "message-1",
      token: NOW.toISOString(),
      availableAt: NOW,
    };

    it("marks the row completed once the handler recorded an extracted outcome", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);
      store.recordOutcome(claim.id, { status: "extracted" });

      await expect(store.complete(claim)).resolves.toBe("deleted");

      expect(jobs.markCompleted).toHaveBeenCalledWith({ id: "job-1", attemptCount: 2, claimedAt: NOW });
      expect(jobs.markSkipped).not.toHaveBeenCalled();
    });

    it("marks the row skipped with the recorded reason", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);
      store.recordOutcome(claim.id, { status: "skipped", reason: "empty_message" });

      await expect(store.complete(claim)).resolves.toBe("deleted");

      expect(jobs.markSkipped).toHaveBeenCalledWith({ id: "job-1", attemptCount: 2, claimedAt: NOW }, "empty_message");
      expect(jobs.markCompleted).not.toHaveBeenCalled();
    });

    it("reports a superseded claim instead of deleted when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markCompleted: vi.fn(async () => false) });
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);
      store.recordOutcome(claim.id, { status: "extracted" });

      await expect(store.complete(claim)).resolves.toBe("superseded");
    });

    it("refuses to complete a job whose outcome was never recorded", async () => {
      const store = new FacetExtractionBackgroundJobStore(buildJobsStub(), MAX_ATTEMPTS);

      await expect(store.complete(claim)).rejects.toThrow(/resolved without recording its outcome/);
    });

    it("clears a recorded outcome once read, so a second complete() call cannot reuse it", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);
      store.recordOutcome(claim.id, { status: "extracted" });

      await store.complete(claim);

      await expect(store.complete(claim)).rejects.toThrow(/resolved without recording its outcome/);
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

    it("schedules the retry at the delay the runtime computed and stores the sanitized error", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      const availableAt = await store.retry(claim, { error: "Error [provider_unavailable]", delaySeconds: 30 });

      expect(availableAt).toBeInstanceOf(Date);
      const [identity, error, scheduledAt] = jobs.markFailed.mock.calls[0];
      expect(identity).toEqual({ id: "job-1", attemptCount: 1, claimedAt: NOW });
      expect(error).toBe("Error [provider_unavailable]");
      expect(scheduledAt).toEqual(availableAt);
    });

    it("returns null without scheduling when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markFailed: vi.fn(async () => false) });
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      await expect(store.retry(claim, { error: "Error", delaySeconds: 30 })).resolves.toBeNull();
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

    it("parks the job terminally, with no further schedule", async () => {
      const jobs = buildJobsStub();
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      await expect(store.deadLetter(claim, { error: "NonRetryableBackgroundJobError" })).resolves.toBe(true);

      expect(jobs.markFailed).toHaveBeenCalledWith(
        { id: "job-1", attemptCount: 3, claimedAt: NOW },
        "NonRetryableBackgroundJobError",
        null,
      );
    });

    it("reports false when the fenced write finds a newer claim", async () => {
      const jobs = buildJobsStub({ markFailed: vi.fn(async () => false) });
      const store = new FacetExtractionBackgroundJobStore(jobs, MAX_ATTEMPTS);

      await expect(store.deadLetter(claim, { error: "Error" })).resolves.toBe(false);
    });
  });
});
