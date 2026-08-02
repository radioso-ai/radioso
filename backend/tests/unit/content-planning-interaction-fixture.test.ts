import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { resolveConversationInteraction } from "../../src/modules/chat/services/conversationInteraction.js";
import type {
  ContentPlanObservationIntakePort,
  ContentPlanObservationRecord,
  ContentPlanProjectionGenerationRecord,
} from "../../src/modules/contentPlanning/contracts/persistence.js";
import {
  decideObservationEligibility,
  type ObservationEligibilityDecision,
} from "../../src/modules/contentPlanning/domain/observationEligibility.js";
import { ObservationIntakeService } from "../../src/modules/contentPlanning/services/observationIntakeService.js";
import { isOperatorTestSourceChannel } from "../../src/shared/domain/conversationSource.js";
import { contentPlanningInteractionFixture } from "../fixtures/content-planning/interactions.js";

const semanticHash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

const expectedDecisionKind = (
  registration: "ready" | "pending_context" | "none",
  role: string,
): ObservationEligibilityDecision["kind"] => {
  if (registration === "none") return "skip";
  if (role === "clarification_value") return "finalize_pending";
  return "register";
};

describe("Content Planning multilingual interaction intake fixture", () => {
  it.each(contentPlanningInteractionFixture)(
    "$name ($language)",
    (fixture) => {
      const resolved = resolveConversationInteraction({
        inferred: fixture.inferred,
        currentUserMessageId: fixture.currentUserMessageId,
        history: fixture.history.map((message) => ({
          ...message,
          conversationId: "00000000-0000-4000-8000-000000000001",
          workspaceId: "00000000-0000-4000-8000-000000000002",
          content: "not supplied to eligibility",
          createdAt: new Date("2026-08-01T12:00:00.000Z"),
        })),
        lifecycle: fixture.lifecycle,
        priorUnresolvedSourceUserMessageId: fixture.priorUnresolvedSourceUserMessageId,
      });

      expect(resolved.interaction.role).toBe(fixture.expected.role);
      expect(resolved.sourceUserMessageId).toBe(fixture.expected.sourceUserMessageId);
      expect(resolved.interaction.semanticIntents.map(({ id }) => id)).toEqual(
        fixture.expected.semanticIntentIds,
      );

      const decision = decideObservationEligibility({
        interaction: resolved.interaction,
        sourceUserMessageId: resolved.sourceUserMessageId,
        sourceAssistantMessageId: "00000000-0000-4000-8000-000000000201",
        populationEligible: !isOperatorTestSourceChannel(fixture.sourceChannel),
        resolutionDeadline: new Date("2026-08-02T12:00:00.000Z"),
      });

      expect(decision.kind).toBe(expectedDecisionKind(
        fixture.expected.registration,
        resolved.interaction.role,
      ));

      if (decision.kind === "register" || decision.kind === "finalize_pending") {
        expect(decision.contributions.map(({ semanticIntentId }) => semanticIntentId)).toEqual(
          fixture.expected.registration === "pending_context"
            ? ["unresolved"]
            : fixture.expected.semanticIntentIds,
        );
        expect(decision.contributions.map(({ observationState }) => observationState)).toEqual(
          fixture.expected.registration === "pending_context"
            ? ["pending_context"]
            : fixture.expected.semanticIntentIds.map(() => "ready"),
        );
        for (const contribution of decision.contributions) {
          if (contribution.observationState === "ready") {
            const source = resolved.interaction.semanticIntents.find(
              ({ id }) => id === contribution.semanticIntentId,
            );
            expect(contribution.semanticTextHash).toBe(semanticHash(source!.text));
          } else {
            expect(contribution.semanticTextHash).toBeNull();
          }
        }
      }

      const serialized = JSON.stringify(decision);
      expect(serialized).not.toContain(fixture.visitorMessage);
      for (const intent of resolved.interaction.semanticIntents) {
        expect(serialized).not.toContain(intent.text);
      }
    },
  );

  it("bounds and de-duplicates semantic contributions without text rules", () => {
    const decision = decideObservationEligibility({
      interaction: {
        role: "substantive_new",
        semanticIntents: [
          { id: "subquery_1", text: "first intent" },
          { id: "subquery_1", text: "duplicate slot must not create demand" },
          { id: "subquery_alias", text: "first intent" },
          { id: "subquery_2", text: "second intent" },
          { id: "subquery_3", text: "third intent" },
          { id: "subquery_4", text: "fourth intent" },
          { id: "subquery_5", text: "outside the retrieval branch cap" },
        ],
      },
      sourceUserMessageId: "00000000-0000-4000-8000-000000000301",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000302",
      populationEligible: true,
      resolutionDeadline: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(decision).toMatchObject({
      kind: "register",
      contributions: [
        { semanticIntentId: "subquery_1" },
        { semanticIntentId: "subquery_2" },
        { semanticIntentId: "subquery_3" },
        { semanticIntentId: "subquery_4" },
      ],
      truncatedCount: 1,
    });
  });

  it("keeps a substantive role pending when no trustworthy semantic intent exists", () => {
    const decision = decideObservationEligibility({
      interaction: {
        role: "substantive_followup",
        semanticIntents: [{ id: "unsafe id with spaces", text: "fragment" }],
      },
      sourceUserMessageId: "00000000-0000-4000-8000-000000000401",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000402",
      populationEligible: true,
      resolutionDeadline: new Date("2026-08-02T12:00:00.000Z"),
    });

    expect(decision).toEqual({
      kind: "register",
      role: "unresolved",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000401",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000402",
      contributions: [{
        semanticIntentId: "unresolved",
        semanticTextHash: null,
        observationState: "pending_context",
        resolutionDeadline: new Date("2026-08-02T12:00:00.000Z"),
      }],
      truncatedCount: 0,
    });
  });
});

const pendingObservation = (sourceUserMessageId: string): ContentPlanObservationRecord => ({
  id: "00000000-0000-4000-8000-000000000701",
  workspaceId: "00000000-0000-4000-8000-000000000702",
  conversationId: "00000000-0000-4000-8000-000000000703",
  sourceUserMessageId,
  sourceAssistantMessageId: "00000000-0000-4000-8000-000000000704",
  semanticIntentId: "unresolved",
  semanticTextHash: null,
  interactionRole: "unresolved",
  grounding: null,
  resolutionDeadline: new Date("2026-08-02T12:00:00.000Z"),
  observationState: "pending_context",
  excludedReason: null,
  observedAt: new Date("2026-08-01T12:00:00.000Z"),
  createdAt: new Date("2026-08-01T12:00:00.000Z"),
  updatedAt: new Date("2026-08-01T12:00:00.000Z"),
});

const writableGeneration: ContentPlanProjectionGenerationRecord = {
  id: "00000000-0000-4000-8000-000000000711",
  workspaceId: "00000000-0000-4000-8000-000000000702",
  embeddingSpaceId: "00000000-0000-4000-8000-000000000712",
  kind: "active",
  state: "coherent",
  policyVersion: 1,
  horizonFrom: new Date("2026-06-01T00:00:00.000Z"),
  horizonTo: new Date("2026-08-01T00:00:00.000Z"),
  coherentAt: new Date("2026-08-01T00:00:00.000Z"),
  createdAt: new Date("2026-08-01T00:00:00.000Z"),
  updatedAt: new Date("2026-08-01T00:00:00.000Z"),
};

describe("ObservationIntakeService fixture boundary", () => {
  it.each(contentPlanningInteractionFixture)(
    "persists only the content-free decision for $name",
    async (fixture) => {
      const resolved = resolveConversationInteraction({
        inferred: fixture.inferred,
        currentUserMessageId: fixture.currentUserMessageId,
        history: fixture.history.map((message) => ({
          ...message,
          conversationId: "00000000-0000-4000-8000-000000000703",
          workspaceId: "00000000-0000-4000-8000-000000000702",
          content: "not supplied to intake",
          createdAt: new Date("2026-08-01T12:00:00.000Z"),
        })),
        lifecycle: fixture.lifecycle,
        priorUnresolvedSourceUserMessageId: fixture.priorUnresolvedSourceUserMessageId,
      });
      const pending = pendingObservation(resolved.sourceUserMessageId);
      const registerTurn = vi.fn<ContentPlanObservationIntakePort["registerTurn"]>(
        async (registration) => ({
          observations: [],
          acceptedCount: registration.contributions.length,
          duplicateCount: 0,
          truncatedCount: 0,
        }),
      );
      const findPendingContext = vi.fn<ContentPlanObservationIntakePort["findPendingContext"]>(
        async () => resolved.interaction.role === "clarification_value" ? pending : null,
      );
      const finalizePendingContext = vi.fn<ContentPlanObservationIntakePort["finalizePendingContext"]>(
        async () => pending,
      );
      const excludePendingContext = vi.fn<ContentPlanObservationIntakePort["excludePendingContext"]>(
        async () => pending,
      );
      const service = new ObservationIntakeService(
        { registerTurn, findPendingContext, finalizePendingContext, excludePendingContext },
        { resolveWritableGeneration: vi.fn(async () => writableGeneration) },
        {
          clock: () => new Date("2026-08-01T12:00:00.000Z"),
          pendingContextTtlMs: 60_000,
        },
      );
      const semanticVectors = resolved.interaction.semanticIntents.slice(0, 1).map((intent) => ({
        intentId: intent.id,
        semanticTextHash: semanticHash(intent.text),
        vector: [0.2, 0.8],
        space: {
          id: writableGeneration.embeddingSpaceId,
          dimensions: 2,
          distanceMetric: "cosine" as const,
        },
      }));

      await service.registerCommittedTurn({
        workspaceId: writableGeneration.workspaceId,
        conversationId: pending.conversationId,
        sourceChannel: fixture.sourceChannel,
        sourceUserMessageId: resolved.sourceUserMessageId,
        sourceAssistantMessageId: "00000000-0000-4000-8000-000000000714",
        interaction: resolved.interaction,
        semanticVectors,
        expiresUnresolvedSourceUserMessageId: resolved.expiresUnresolvedSourceUserMessageId,
      });

      if (fixture.expected.registration === "none") {
        expect(registerTurn).not.toHaveBeenCalled();
        expect(finalizePendingContext).not.toHaveBeenCalled();
      } else if (resolved.interaction.role === "clarification_value") {
        expect(finalizePendingContext).toHaveBeenCalledOnce();
        expect(registerTurn).not.toHaveBeenCalled();
        expect(finalizePendingContext.mock.calls[0]![0]).toMatchObject({
          observationId: pending.id,
          sourceAssistantMessageId: "00000000-0000-4000-8000-000000000714",
          semanticIntentId: fixture.expected.semanticIntentIds[0],
          interactionRole: "clarification_value",
        });
      } else {
        expect(registerTurn).toHaveBeenCalledOnce();
        const registration = registerTurn.mock.calls[0]![0];
        expect(registration).toMatchObject({
          workspaceId: writableGeneration.workspaceId,
          conversationId: pending.conversationId,
          sourceUserMessageId: fixture.expected.sourceUserMessageId,
          sourceAssistantMessageId: "00000000-0000-4000-8000-000000000714",
        });
        expect(registration.contributions.map(({ semanticIntentId }) => semanticIntentId)).toEqual(
          fixture.expected.registration === "pending_context"
            ? ["unresolved"]
            : fixture.expected.semanticIntentIds,
        );
      }

      const durableCalls = JSON.stringify({
        registrations: registerTurn.mock.calls,
        finalized: finalizePendingContext.mock.calls,
        excluded: excludePendingContext.mock.calls,
      });
      expect(durableCalls).not.toContain(fixture.visitorMessage);
      for (const intent of resolved.interaction.semanticIntents) {
        expect(durableCalls).not.toContain(intent.text);
      }
    },
  );

  it("expires an earlier unresolved source when the next resolving turn changes topic", async () => {
    const pending = pendingObservation("00000000-0000-4000-8000-000000000721");
    const excludePendingContext = vi.fn<ContentPlanObservationIntakePort["excludePendingContext"]>(
      async () => pending,
    );
    const observations: ContentPlanObservationIntakePort = {
      registerTurn: async () => ({
        observations: [],
        acceptedCount: 1,
        duplicateCount: 0,
        truncatedCount: 0,
      }),
      findPendingContext: async () => pending,
      finalizePendingContext: async () => null,
      excludePendingContext,
    };
    const service = new ObservationIntakeService(
      observations,
      { resolveWritableGeneration: async () => writableGeneration },
    );

    const summary = await service.registerCommittedTurn({
      workspaceId: pending.workspaceId,
      conversationId: pending.conversationId,
      sourceUserMessageId: "00000000-0000-4000-8000-000000000723",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000724",
      interaction: {
        role: "substantive_new",
        semanticIntents: [{ id: "primary", text: "new unrelated topic" }],
      },
      semanticVectors: [],
    });

    expect(excludePendingContext).toHaveBeenCalledWith({
      workspaceId: pending.workspaceId,
      observationId: pending.id,
      excludedReason: "superseded_by_next_turn",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000724",
    });
    expect(summary.excludedCount).toBe(1);
    expect(summary.acceptedCount).toBe(1);
  });

  it("reuses only an exact hash-and-space vector and leaves other intents for fallback embedding", async () => {
    const registerTurn = vi.fn<ContentPlanObservationIntakePort["registerTurn"]>(async (input) => ({
      observations: [],
      acceptedCount: input.contributions.length,
      duplicateCount: 0,
      truncatedCount: 0,
    }));
    const service = new ObservationIntakeService(
      {
        registerTurn,
        findPendingContext: async () => null,
        finalizePendingContext: async () => null,
        excludePendingContext: async () => null,
      },
      { resolveWritableGeneration: async () => writableGeneration },
    );
    const firstText = "SSO configuration";
    const secondText = "SCIM configuration";

    await service.registerCommittedTurn({
      workspaceId: writableGeneration.workspaceId,
      conversationId: "00000000-0000-4000-8000-000000000731",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000733",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000734",
      interaction: {
        role: "substantive_new",
        semanticIntents: [
          { id: "subquery_1", text: firstText },
          { id: "subquery_2", text: secondText },
        ],
      },
      semanticVectors: [
        {
          intentId: "subquery_1",
          semanticTextHash: semanticHash(firstText),
          vector: [0.25, 0.75],
          space: {
            id: writableGeneration.embeddingSpaceId,
            dimensions: 2,
            distanceMetric: "cosine",
          },
        },
        {
          intentId: "subquery_2",
          semanticTextHash: semanticHash("different text"),
          vector: [0.5, 0.5],
          space: {
            id: writableGeneration.embeddingSpaceId,
            dimensions: 2,
            distanceMetric: "cosine",
          },
        },
      ],
    });

    const contributions = registerTurn.mock.calls[0]![0].contributions;
    expect(contributions[0]).toMatchObject({
      semanticIntentId: "subquery_1",
      vectorWork: {
        generationId: writableGeneration.id,
        embeddingSpaceId: writableGeneration.embeddingSpaceId,
        dimensions: 2,
        embedding: [0.25, 0.75],
        vectorSource: "reused",
      },
    });
    expect(contributions[1]).toEqual({
      semanticIntentId: "subquery_2",
      semanticTextHash: semanticHash(secondText),
      observationState: "ready",
      vectorWork: {
        generationId: writableGeneration.id,
        embeddingSpaceId: writableGeneration.embeddingSpaceId,
      },
    });
  });

  it("creates a provisional target from the pinned reusable vector instead of losing the turn", async () => {
    const registerTurn = vi.fn<ContentPlanObservationIntakePort["registerTurn"]>(async (input) => ({
      observations: [],
      acceptedCount: input.contributions.length,
      duplicateCount: 0,
      truncatedCount: 0,
    }));
    const ensureTargetGenerationForIntake = vi.fn(async () => writableGeneration);
    const service = new ObservationIntakeService(
      {
        registerTurn,
        findPendingContext: async () => null,
        finalizePendingContext: async () => null,
        excludePendingContext: async () => null,
      },
      {
        resolveWritableGeneration: async () => null,
        ensureTargetGenerationForIntake,
      },
      { generationIdFactory: () => writableGeneration.id },
    );

    const semanticText = "content plan generation readiness";

    const summary = await service.registerCommittedTurn({
      workspaceId: writableGeneration.workspaceId,
      conversationId: "00000000-0000-4000-8000-000000000741",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000743",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000744",
      interaction: {
        role: "substantive_new",
        semanticIntents: [{ id: "primary", text: semanticText }],
      },
      semanticVectors: [{
        intentId: "primary",
        semanticTextHash: semanticHash(semanticText),
        vector: [0.2, 0.8],
        space: {
          id: writableGeneration.embeddingSpaceId,
          dimensions: 2,
          distanceMetric: "cosine",
        },
      }],
    });

    expect(summary.status).toBe("processed");
    expect(ensureTargetGenerationForIntake).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: writableGeneration.workspaceId,
      preferredEmbeddingSpaceId: writableGeneration.embeddingSpaceId,
      generationId: writableGeneration.id,
    }));
    expect(registerTurn).toHaveBeenCalledWith(expect.objectContaining({
      contributions: [expect.objectContaining({
        vectorWork: expect.objectContaining({
          generationId: writableGeneration.id,
          embeddingSpaceId: writableGeneration.embeddingSpaceId,
          embedding: [0.2, 0.8],
          vectorSource: "reused",
        }),
      })],
    }));
  });

  it("durably registers missing embedding work when target initialization resolves the active profile", async () => {
    const registerTurn = vi.fn<ContentPlanObservationIntakePort["registerTurn"]>(async (input) => ({
      observations: [],
      acceptedCount: input.contributions.length,
      duplicateCount: 0,
      truncatedCount: 0,
    }));
    const ensureTargetGenerationForIntake = vi.fn(async () => writableGeneration);
    const service = new ObservationIntakeService(
      {
        registerTurn,
        findPendingContext: async () => null,
        finalizePendingContext: async () => null,
        excludePendingContext: async () => null,
      },
      {
        resolveWritableGeneration: async () => null,
        ensureTargetGenerationForIntake,
      },
      { generationIdFactory: () => writableGeneration.id },
    );

    const summary = await service.registerCommittedTurn({
      workspaceId: writableGeneration.workspaceId,
      conversationId: "00000000-0000-4000-8000-000000000751",
      sourceUserMessageId: "00000000-0000-4000-8000-000000000753",
      sourceAssistantMessageId: "00000000-0000-4000-8000-000000000754",
      interaction: {
        role: "substantive_new",
        semanticIntents: [{ id: "primary", text: "missing vector still persists" }],
      },
      semanticVectors: [],
    });

    expect(summary.status).toBe("processed");
    expect(ensureTargetGenerationForIntake).toHaveBeenCalledWith(expect.objectContaining({
      preferredEmbeddingSpaceId: undefined,
    }));
    expect(registerTurn).toHaveBeenCalledWith(expect.objectContaining({
      contributions: [expect.objectContaining({
        vectorWork: {
          generationId: writableGeneration.id,
          embeddingSpaceId: writableGeneration.embeddingSpaceId,
        },
      })],
    }));
  });
});
