import { describe, expect, it, vi } from "vitest";

import type {
  EmbeddingSpaceRecord,
} from "../../../src/modules/embeddingProfiles/contracts/repositories.js";
import {
  EmbeddingProfileLifecycleError,
  type EmbeddingTransitionState,
  type WorkspaceEmbeddingProfileState,
} from "../../../src/modules/embeddingProfiles/domain/profileLifecycle.js";
import {
  EmbeddingTransitionCoordinator,
  EmbeddingTransitionCoordinatorError,
  FixedInputEmbeddingValidationError,
  type EmbeddingTransitionBackfillPort,
  type EmbeddingTransitionCoordinatorRepository,
  type FixedInputEmbeddingValidationPort,
} from "../../../src/modules/embeddingProfiles/services/embeddingTransitionCoordinator.js";

const activeProfile = (
  overrides: Partial<WorkspaceEmbeddingProfileState> = {},
): WorkspaceEmbeddingProfileState => ({
  workspaceId: "workspace-1",
  activeEmbeddingSpaceId: "space-active",
  pendingEmbeddingSpaceId: null,
  generation: "1",
  transition: null,
  ...overrides,
});

const targetSpace = (
  overrides: Partial<EmbeddingSpaceRecord> = {},
): EmbeddingSpaceRecord => ({
  id: "space-target",
  identityFingerprint: "fingerprint-target",
  provider: "openai",
  endpointScopeFingerprint: "scope-target",
  model: "text-embedding-3-large",
  dimensions: 3072,
  distanceMetric: "cosine",
  normalization: "provider_unit",
  documentTask: null,
  queryTask: null,
  vectorOptions: {},
  modelVersion: null,
  status: "active",
  quarantineReason: null,
  createdAt: new Date("2026-07-26T00:00:00.000Z"),
  updatedAt: new Date("2026-07-26T00:00:00.000Z"),
  ...overrides,
});

const buildingTransition = (
  overrides: Partial<EmbeddingTransitionState> = {},
): EmbeddingTransitionState => ({
  id: "transition-1",
  sourceEmbeddingSpaceId: "space-active",
  targetEmbeddingSpaceId: "space-target",
  generation: "2",
  status: "building",
  failureReason: null,
  ...overrides,
});

const buildingProfile = (
  overrides: Partial<WorkspaceEmbeddingProfileState> = {},
): WorkspaceEmbeddingProfileState =>
  activeProfile({
    pendingEmbeddingSpaceId: "space-target",
    generation: "2",
    transition: buildingTransition(),
    ...overrides,
  });

const promotedProfile = (): WorkspaceEmbeddingProfileState =>
  activeProfile({
    activeEmbeddingSpaceId: "space-target",
    generation: "3",
    transition: buildingTransition({ status: "promoted" }),
  });

const createHarness = () => {
  let profile = activeProfile();
  const repository: EmbeddingTransitionCoordinatorRepository = {
    findEmbeddingSpaceById: vi.fn(async () => targetSpace()),
    findWorkspaceProfile: vi.fn(async () => profile),
    listBuildingTransitions: vi.fn(async () => []),
    startTransition: vi.fn(async (input) => {
      const transition = buildingTransition({
        targetEmbeddingSpaceId: input.targetEmbeddingSpaceId,
      });
      profile = buildingProfile({ transition });
      return { profile, transition };
    }),
    cancelTransition: vi.fn(async () => {
      profile = buildingProfile({
        pendingEmbeddingSpaceId: null,
        generation: "3",
        transition: buildingTransition({ status: "cancelled" }),
      });
      return profile;
    }),
    promoteTransitionIfEligible: vi.fn(async () => {
      profile = promotedProfile();
      return profile;
    }),
    failTransition: vi.fn(async (input) => {
      const terminal = input.status === "failed";
      profile = buildingProfile({
        pendingEmbeddingSpaceId: terminal ? null : "space-target",
        generation: terminal ? "3" : "2",
        transition: buildingTransition({
          status: input.status,
          failureReason: input.reason,
        }),
      });
      return profile;
    }),
    quarantineEmbeddingSpace: vi.fn(async (input) =>
      targetSpace({
        status: "quarantined",
        quarantineReason: input.reason,
      })),
  };
  const validation: FixedInputEmbeddingValidationPort = {
    validateFixedInput: vi.fn(async () => undefined),
  };
  const backfill: EmbeddingTransitionBackfillPort = {
    ensureTransitionWork: vi.fn(async () => undefined),
    cancelTransitionWork: vi.fn(async () => undefined),
  };
  const coordinator = new EmbeddingTransitionCoordinator(
    repository,
    validation,
    backfill,
    { backendKey: "pgvector" },
  );

  return {
    backfill,
    coordinator,
    repository,
    setProfile(next: WorkspaceEmbeddingProfileState) {
      profile = next;
    },
    validation,
  };
};

describe("EmbeddingTransitionCoordinator", () => {
  it("validates with the fixed-input port before atomically starting and handing off backfill", async () => {
    const harness = createHarness();
    const events: string[] = [];
    vi.mocked(harness.validation.validateFixedInput).mockImplementation(async () => {
      events.push("validate");
    });
    vi.mocked(harness.repository.startTransition).mockImplementation(async () => {
      events.push("start");
      const transition = buildingTransition();
      return { profile: buildingProfile(), transition };
    });
    vi.mocked(harness.backfill.ensureTransitionWork).mockImplementation(async () => {
      events.push("backfill");
    });

    const result = await harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    });

    expect(events).toEqual(["validate", "start", "backfill"]);
    expect(harness.validation.validateFixedInput).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
    });
    expect(result).toMatchObject({
      outcome: "started",
      transition: {
        id: "transition-1",
        generation: "2",
      },
    });
    expect(harness.backfill.ensureTransitionWork).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      generation: "2",
    });
  });

  it("quarantines an objectively invalid target before any transition can start", async () => {
    const harness = createHarness();
    vi.mocked(harness.validation.validateFixedInput).mockRejectedValue(
      new FixedInputEmbeddingValidationError("contract_invalid"),
    );

    await expect(harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    })).rejects.toMatchObject({
      code: "validation_failed",
      message: "Embedding target failed fixed-input validation",
    } satisfies Partial<EmbeddingTransitionCoordinatorError>);

    expect(harness.repository.startTransition).not.toHaveBeenCalled();
    expect(harness.repository.quarantineEmbeddingSpace).toHaveBeenCalledWith({
      embeddingSpaceId: "space-target",
      reason: "validation_failed",
    });
  });

  it("leaves the target retryable when fixed-input validation is temporarily blocked", async () => {
    const harness = createHarness();
    vi.mocked(harness.validation.validateFixedInput).mockRejectedValue(
      new FixedInputEmbeddingValidationError("temporarily_unavailable"),
    );

    await expect(harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    })).rejects.toMatchObject({
      code: "validation_blocked",
      message: "Embedding target validation is temporarily unavailable",
    } satisfies Partial<EmbeddingTransitionCoordinatorError>);

    expect(harness.repository.startTransition).not.toHaveBeenCalled();
    expect(harness.repository.quarantineEmbeddingSpace).not.toHaveBeenCalled();
  });

  it("lets repository CAS enforce a single pending target and recovers an idempotent same-target race", async () => {
    const harness = createHarness();
    const existing = buildingProfile();
    vi.mocked(harness.repository.startTransition).mockRejectedValue(
      new EmbeddingProfileLifecycleError(
        "stale_generation",
        "stale generation",
      ),
    );
    vi.mocked(harness.repository.findWorkspaceProfile).mockResolvedValue(existing);

    const result = await harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    });

    expect(result.outcome).toBe("already_pending");
    expect(harness.backfill.ensureTransitionWork).toHaveBeenCalledOnce();

    vi.mocked(harness.repository.findWorkspaceProfile).mockResolvedValue(
      buildingProfile({
        pendingEmbeddingSpaceId: "space-other",
        transition: buildingTransition({
          id: "transition-other",
          targetEmbeddingSpaceId: "space-other",
        }),
      }),
    );
    await expect(harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    })).rejects.toMatchObject({ code: "transition_conflict" });
  });

  it("rejects a target quarantined atomically after validation but before transition start", async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.startTransition).mockRejectedValue(
      new EmbeddingProfileLifecycleError(
        "target_quarantined",
        "target quarantined during transition start",
      ),
    );

    await expect(harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    })).rejects.toMatchObject({ code: "target_quarantined" });
    expect(harness.backfill.ensureTransitionWork).not.toHaveBeenCalled();
  });

  it("retries durable backfill handoff without creating a second transition", async () => {
    const harness = createHarness();
    vi.mocked(harness.backfill.ensureTransitionWork)
      .mockRejectedValueOnce(new Error("durable scheduler unavailable"))
      .mockResolvedValueOnce(undefined);

    await expect(harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    })).rejects.toMatchObject({ code: "backfill_handoff_failed" });

    vi.mocked(harness.repository.startTransition).mockRejectedValueOnce(
      new EmbeddingProfileLifecycleError("stale_generation", "stale generation"),
    );
    const retried = await harness.coordinator.start({
      workspaceId: "workspace-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "1",
    });

    expect(retried.outcome).toBe("already_pending");
    expect(harness.repository.startTransition).toHaveBeenCalledTimes(2);
    expect(harness.backfill.ensureTransitionWork).toHaveBeenCalledTimes(2);
  });

  it("reconciles committed building transitions after a start-to-handoff crash window", async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.listBuildingTransitions).mockResolvedValue([
      {
        profile: buildingProfile(),
        transition: buildingTransition(),
      },
    ]);

    await expect(harness.coordinator.reconcileBackfills({ limit: 25 })).resolves.toEqual({
      discovered: 1,
      handedOff: 1,
      failed: 0,
    });
    expect(harness.repository.listBuildingTransitions).toHaveBeenCalledWith({
      limit: 25,
    });
    expect(harness.backfill.ensureTransitionWork).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      generation: "2",
    });
  });

  it("fences cancellation in the repository before cancelling durable work", async () => {
    const harness = createHarness();
    const events: string[] = [];
    vi.mocked(harness.repository.cancelTransition).mockImplementation(async () => {
      events.push("cancel-state");
      return buildingProfile({
        pendingEmbeddingSpaceId: null,
        generation: "3",
        transition: buildingTransition({ status: "cancelled" }),
      });
    });
    vi.mocked(harness.backfill.cancelTransitionWork).mockImplementation(async () => {
      events.push("cancel-work");
    });

    const result = await harness.coordinator.cancel({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
    });

    expect(events).toEqual(["cancel-state", "cancel-work"]);
    expect(result.transition?.status).toBe("cancelled");
    expect(harness.backfill.cancelTransitionWork).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      generation: "2",
    });
  });

  it("retries durable work cancellation for an already-cancelled transition", async () => {
    const harness = createHarness();
    const cancelled = buildingProfile({
      pendingEmbeddingSpaceId: null,
      generation: "3",
      transition: buildingTransition({ status: "cancelled" }),
    });
    vi.mocked(harness.repository.cancelTransition).mockRejectedValue(
      new EmbeddingProfileLifecycleError(
        "transition_not_building",
        "already cancelled",
      ),
    );
    vi.mocked(harness.repository.findWorkspaceProfile).mockResolvedValue(cancelled);

    await expect(harness.coordinator.cancel({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
    })).resolves.toBe(cancelled);
    expect(harness.backfill.cancelTransitionWork).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      generation: "2",
    });
  });

  it("automatically promotes when eligible and makes repeated reconciliation idempotent", async () => {
    const harness = createHarness();

    const first = await harness.coordinator.reconcilePromotion({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
    });
    expect(first).toMatchObject({
      outcome: "promoted",
      profile: {
        activeEmbeddingSpaceId: "space-target",
      },
    });

    vi.mocked(harness.repository.promoteTransitionIfEligible).mockRejectedValueOnce(
      new EmbeddingProfileLifecycleError(
        "transition_not_building",
        "already promoted",
      ),
    );
    vi.mocked(harness.repository.findWorkspaceProfile).mockResolvedValue(
      promotedProfile(),
    );
    const repeated = await harness.coordinator.reconcilePromotion({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
    });
    expect(repeated.outcome).toBe("promoted");
  });

  it("keeps a not-ready transition pending for a later automatic promotion attempt", async () => {
    const harness = createHarness();
    vi.mocked(harness.repository.promoteTransitionIfEligible).mockRejectedValue(
      new EmbeddingProfileLifecycleError(
        "promotion_not_ready",
        "coverage is incomplete",
      ),
    );
    vi.mocked(harness.repository.findWorkspaceProfile).mockResolvedValue(
      buildingProfile(),
    );

    await expect(harness.coordinator.reconcilePromotion({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
    })).resolves.toMatchObject({
      outcome: "waiting",
      profile: {
        activeEmbeddingSpaceId: "space-active",
        pendingEmbeddingSpaceId: "space-target",
      },
    });
  });

  it("persists bounded blocked, quarantined, and terminal failure semantics", async () => {
    const harness = createHarness();

    await harness.coordinator.recordFailure({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "2",
      kind: "retryable",
    });
    expect(harness.repository.failTransition).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
      status: "blocked",
      reason: "backfill_retry_exhausted",
    });
    expect(harness.repository.quarantineEmbeddingSpace).not.toHaveBeenCalled();

    await harness.coordinator.recordFailure({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "2",
      kind: "contract_drift",
    });
    expect(harness.repository.quarantineEmbeddingSpace).not.toHaveBeenCalled();
    expect(harness.repository.failTransition).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
      status: "quarantined",
      reason: "embedding_contract_drift",
    });

    const failed = await harness.coordinator.recordFailure({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-target",
      expectedGeneration: "2",
      kind: "terminal",
    });
    expect(failed).toMatchObject({
      activeEmbeddingSpaceId: "space-active",
      pendingEmbeddingSpaceId: null,
      transition: {
        status: "failed",
      },
    });
    expect(harness.repository.failTransition).toHaveBeenLastCalledWith({
      workspaceId: "workspace-1",
      transitionId: "transition-1",
      expectedGeneration: "2",
      status: "failed",
      reason: "terminal_failure",
    });
  });
});
