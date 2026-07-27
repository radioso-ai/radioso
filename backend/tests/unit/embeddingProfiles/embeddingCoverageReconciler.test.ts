import { describe, expect, it, vi } from "vitest";

import { EmbeddingCoverageReconciler } from "../../../src/modules/embeddingProfiles/services/embeddingCoverageReconciler.js";

describe("EmbeddingCoverageReconciler", () => {
  it("durably ensures and cancels generation-pinned transition work", async () => {
    const queuedJobs = [
      {
        id: "job-1",
        documentId: "document-1",
        workspaceId: "workspace-1",
        documentRevision: 3,
      },
      {
        id: "job-2",
        documentId: "document-2",
        workspaceId: "workspace-1",
        documentRevision: 4,
      },
    ];
    const jobs = {
      ensureEmbeddingProfileJobsForTransition: vi.fn().mockResolvedValue(4),
      cancelEmbeddingProfileJobsForTransition: vi.fn().mockResolvedValue(3),
      reconcileEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue({
        enqueued: 0,
        skipped: 0,
      }),
      listQueuedEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue(queuedJobs),
    };
    const dispatcher = {
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const service = new EmbeddingCoverageReconciler(jobs, dispatcher);
    const fence = {
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-2",
      generation: "2",
    };

    await service.ensureTransitionWork(fence);
    await service.cancelTransitionWork(fence);

    expect(jobs.ensureEmbeddingProfileJobsForTransition).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-2",
      generation: "2",
    });
    expect(jobs.cancelEmbeddingProfileJobsForTransition).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-2",
      generation: "2",
    });
    expect(jobs.reconcileEmbeddingProfileJobsForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(jobs.listQueuedEmbeddingProfileJobsForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      embeddingSpaceId: "space-2",
      generation: "2",
    });
    expect(dispatcher.dispatchMany).toHaveBeenCalledWith([
      {
        jobId: "job-1",
        documentId: "document-1",
        workspaceId: "workspace-1",
        revision: 3,
      },
      {
        jobId: "job-2",
        documentId: "document-2",
        workspaceId: "workspace-1",
        revision: 4,
      },
    ]);
  });

  it("reconciles document mutations, eligibility changes, and missing work", async () => {
    const queuedJobs = [
      {
        id: "job-3",
        documentId: "document-3",
        workspaceId: "workspace-1",
        documentRevision: 5,
      },
    ];
    const jobs = {
      ensureEmbeddingProfileJobsForTransition: vi.fn(),
      cancelEmbeddingProfileJobsForTransition: vi.fn(),
      reconcileEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue({
        enqueued: 2,
        skipped: 5,
      }),
      listQueuedEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue(queuedJobs),
    };
    const dispatcher = {
      dispatchMany: vi.fn().mockResolvedValue(undefined),
    };
    const service = new EmbeddingCoverageReconciler(jobs, dispatcher);

    await expect(service.reconcileWorkspace("workspace-1")).resolves.toEqual({
      enqueued: 2,
      skipped: 5,
    });
    expect(jobs.listQueuedEmbeddingProfileJobsForWorkspace).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
    });
    expect(dispatcher.dispatchMany).toHaveBeenCalledWith([
      {
        jobId: "job-3",
        documentId: "document-3",
        workspaceId: "workspace-1",
        revision: 5,
      },
    ]);
  });

  it("keeps durable coverage reconciliation successful when dispatch fails", async () => {
    const jobs = {
      ensureEmbeddingProfileJobsForTransition: vi.fn(),
      cancelEmbeddingProfileJobsForTransition: vi.fn(),
      reconcileEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue({
        enqueued: 1,
        skipped: 0,
      }),
      listQueuedEmbeddingProfileJobsForWorkspace: vi.fn().mockResolvedValue([
        {
          id: "job-4",
          documentId: "document-4",
          workspaceId: "workspace-1",
          documentRevision: 6,
        },
      ]),
    };
    const dispatcher = {
      dispatchMany: vi.fn().mockRejectedValue(new Error("dispatch unavailable")),
    };
    const service = new EmbeddingCoverageReconciler(jobs, dispatcher);

    await expect(service.reconcileWorkspace("workspace-1")).resolves.toEqual({
      enqueued: 1,
      skipped: 0,
    });
  });
});
