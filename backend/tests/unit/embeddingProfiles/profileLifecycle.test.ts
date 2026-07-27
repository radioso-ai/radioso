import { describe, expect, it } from "vitest";

import {
  beginEmbeddingTransition,
  blockEmbeddingTransition,
  cancelEmbeddingTransition,
  canCleanupEmbeddingSpace,
  canCommitEmbeddingTransitionWork,
  canPromoteEmbeddingTransition,
  failEmbeddingTransition,
  promoteEmbeddingTransition,
  quarantineEmbeddingTransition,
  type WorkspaceEmbeddingProfileState,
} from "../../../src/modules/embeddingProfiles/domain/profileLifecycle.js";

const activeState = (
  overrides: Partial<WorkspaceEmbeddingProfileState> = {},
): WorkspaceEmbeddingProfileState => ({
  workspaceId: "workspace-1",
  activeEmbeddingSpaceId: "space-active",
  pendingEmbeddingSpaceId: null,
  generation: "9007199254740993",
  transition: null,
  ...overrides,
});

describe("embedding profile lifecycle", () => {
  it("starts one pending transition and advances a decimal-safe generation", () => {
    const started = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    });

    expect(started.profile).toMatchObject({
      activeEmbeddingSpaceId: "space-active",
      pendingEmbeddingSpaceId: "space-pending",
      generation: "9007199254740994",
    });
    expect(started.transition).toMatchObject({
      id: "transition-1",
      sourceEmbeddingSpaceId: "space-active",
      targetEmbeddingSpaceId: "space-pending",
      generation: "9007199254740994",
      status: "building",
    });
  });

  it("rejects stale generations, active targets, and conflicting pending transitions", () => {
    expect(() =>
      beginEmbeddingTransition(activeState(), {
        transitionId: "transition-1",
        targetEmbeddingSpaceId: "space-pending",
        expectedGeneration: "9007199254740992",
      }),
    ).toThrow(/stale workspace embedding profile generation/i);

    expect(() =>
      beginEmbeddingTransition(activeState(), {
        transitionId: "transition-1",
        targetEmbeddingSpaceId: "space-active",
        expectedGeneration: "9007199254740993",
      }),
    ).toThrow(/already active/i);

    const pending = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;
    expect(() =>
      beginEmbeddingTransition(pending, {
        transitionId: "transition-2",
        targetEmbeddingSpaceId: "space-other",
        expectedGeneration: pending.generation,
      }),
    ).toThrow(/already pending/i);
  });

  it("allows work commits only through the current building generation fence", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;

    expect(canCommitEmbeddingTransitionWork(profile, {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: "9007199254740994",
    })).toBe(true);
    expect(canCommitEmbeddingTransitionWork(profile, {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: "9007199254740993",
    })).toBe(false);
    expect(canCommitEmbeddingTransitionWork(profile, {
      transitionId: "transition-stale",
      targetEmbeddingSpaceId: "space-pending",
      generation: "9007199254740994",
    })).toBe(false);

    expect(canCommitEmbeddingTransitionWork(blockEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      reason: "backfill_retry_exhausted",
    }), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: profile.generation,
    })).toBe(false);
  });

  it("promotes only complete, ready, non-quarantined transition coverage", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;

    expect(canPromoteEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      canonicalCoverageComplete: false,
      vectorIndexReady: true,
      hasInFlightWork: false,
    })).toBe(false);
    expect(canPromoteEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      canonicalCoverageComplete: true,
      vectorIndexReady: false,
      hasInFlightWork: false,
    })).toBe(false);
    expect(canPromoteEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      canonicalCoverageComplete: true,
      vectorIndexReady: true,
      hasInFlightWork: true,
    })).toBe(false);

    const promoted = promoteEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      canonicalCoverageComplete: true,
      vectorIndexReady: true,
      hasInFlightWork: false,
    });
    expect(promoted).toMatchObject({
      activeEmbeddingSpaceId: "space-pending",
      pendingEmbeddingSpaceId: null,
      generation: "9007199254740995",
      transition: {
        status: "promoted",
      },
    });
    expect(canCommitEmbeddingTransitionWork(promoted, {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: "9007199254740994",
    })).toBe(false);
  });

  it("blocks promotion after quarantine without changing the active space", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;
    const quarantined = quarantineEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      reason: "embedding_contract_drift",
    });

    expect(quarantined).toMatchObject({
      activeEmbeddingSpaceId: "space-active",
      pendingEmbeddingSpaceId: "space-pending",
      transition: {
        status: "quarantined",
        failureReason: "embedding_contract_drift",
      },
    });
    expect(canPromoteEmbeddingTransition(quarantined, {
      transitionId: "transition-1",
      expectedGeneration: quarantined.generation,
      canonicalCoverageComplete: true,
      vectorIndexReady: true,
      hasInFlightWork: false,
    })).toBe(false);
  });

  it("cancels through the generation fence and makes claimed work stale", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;
    const cancelled = cancelEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
    });

    expect(cancelled).toMatchObject({
      activeEmbeddingSpaceId: "space-active",
      pendingEmbeddingSpaceId: null,
      generation: "9007199254740995",
      transition: {
        status: "cancelled",
      },
    });
    expect(canCommitEmbeddingTransitionWork(cancelled, {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: profile.generation,
    })).toBe(false);
  });

  it("cancels blocked and quarantined transitions through the same generation fence", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;

    for (const liveFailure of [
      blockEmbeddingTransition(profile, {
        transitionId: "transition-1",
        expectedGeneration: profile.generation,
        reason: "backfill_retry_exhausted",
      }),
      quarantineEmbeddingTransition(profile, {
        transitionId: "transition-1",
        expectedGeneration: profile.generation,
        reason: "embedding_contract_drift",
      }),
    ]) {
      expect(cancelEmbeddingTransition(liveFailure, {
        transitionId: "transition-1",
        expectedGeneration: liveFailure.generation,
      })).toMatchObject({
        activeEmbeddingSpaceId: "space-active",
        pendingEmbeddingSpaceId: null,
        generation: "9007199254740995",
        transition: { status: "cancelled" },
      });
    }
  });

  it("terminally fails through the generation fence without changing the active space", () => {
    const profile = beginEmbeddingTransition(activeState(), {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      expectedGeneration: "9007199254740993",
    }).profile;

    const failed = failEmbeddingTransition(profile, {
      transitionId: "transition-1",
      expectedGeneration: profile.generation,
      reason: "terminal_failure",
    });

    expect(failed).toMatchObject({
      activeEmbeddingSpaceId: "space-active",
      pendingEmbeddingSpaceId: null,
      generation: "9007199254740995",
      transition: {
        status: "failed",
        failureReason: "terminal_failure",
      },
    });
    expect(canCommitEmbeddingTransitionWork(failed, {
      transitionId: "transition-1",
      targetEmbeddingSpaceId: "space-pending",
      generation: profile.generation,
    })).toBe(false);
  });

  it("allows cleanup only after grace and after every live reference drains", () => {
    const cleanupInput = {
      now: new Date("2026-08-10T00:00:00.000Z"),
      cleanupAfter: new Date("2026-08-09T00:00:00.000Z"),
      isActive: false,
      isPending: false,
      hasInFlightWork: false,
      hasRebuildReference: false,
    };

    expect(canCleanupEmbeddingSpace(cleanupInput)).toBe(true);
    expect(canCleanupEmbeddingSpace({ ...cleanupInput, isActive: true })).toBe(false);
    expect(canCleanupEmbeddingSpace({ ...cleanupInput, isPending: true })).toBe(false);
    expect(canCleanupEmbeddingSpace({ ...cleanupInput, hasInFlightWork: true })).toBe(false);
    expect(canCleanupEmbeddingSpace({ ...cleanupInput, hasRebuildReference: true })).toBe(false);
    expect(canCleanupEmbeddingSpace({
      ...cleanupInput,
      now: new Date("2026-08-08T00:00:00.000Z"),
    })).toBe(false);
  });
});
