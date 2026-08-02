import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import type {
  ContentPlanObservationSourcePort,
  ContentPlanObservationSourceRecord,
} from "../../src/modules/contentPlanning/contracts/persistence.js";
import {
  ObservationSemanticSourceLoader,
  type HistoricalConversationSourcePort,
} from "../../src/modules/contentPlanning/services/observationSourceLoader.js";
import {
  inspectHistoricalTurnInteraction,
  MAX_HISTORICAL_CONTEXT_MESSAGES,
  resolvePendingStructuredObservationSource,
  resolveHistoricalObservationSource,
  resolveStructuredObservationSource,
  type HistoricalInteractionInterpreterPort,
  type ObservationSourceMessage,
} from "../../src/modules/contentPlanning/services/observationSourceResolver.js";
import { ContentPlanHistoricalTurnProjectionService } from "../../src/modules/contentPlanning/services/historicalTurnProjectionService.js";

const hash = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");

describe("Content Planning observation semantic source resolution", () => {
  it("loads the matching intent from canonical versioned message metadata", () => {
    const semanticText = "Enterprise SSO configuration";
    const result = resolveStructuredObservationSource({
      semanticIntentId: "primary",
      semanticTextHash: hash(semanticText),
      messageMetadata: {
        conversationInteraction: {
          version: 1,
          role: "substantive_followup",
          semanticIntents: [{ id: "primary", text: semanticText }],
        },
      },
      legacyAuditMetadata: {
        retrieval: {
          parsedQuery: { semanticQuery: "malicious fallback must not win" },
        },
      },
    });

    expect(result).toEqual({
      status: "resolved",
      source: "message_metadata",
      semanticIntentId: "primary",
      semanticText,
      semanticTextHash: hash(semanticText),
    });
  });

  it("falls back to bounded legacy audit retrieval metadata", () => {
    const semanticText = "account recovery with a replacement MFA device";
    const result = resolveStructuredObservationSource({
      semanticIntentId: "subquery_2",
      semanticTextHash: hash(semanticText),
      messageMetadata: {},
      legacyAuditMetadata: {
        retrieval: {
          retrievalSubqueries: [
            { id: "subquery_1", semanticQuery: "account password recovery" },
            { id: "subquery_2", semanticQuery: semanticText },
            { id: "subquery_3", semanticQuery: "account recovery codes" },
            { id: "subquery_4", semanticQuery: "account lockout duration" },
            { id: "subquery_5", semanticQuery: "must be outside the cap" },
          ],
          parsedQuery: { semanticQuery: "combined account recovery query" },
        },
      },
    });

    expect(result).toEqual({
      status: "resolved",
      source: "legacy_audit",
      semanticIntentId: "subquery_2",
      semanticText,
      semanticTextHash: hash(semanticText),
    });
  });

  it("rejects a hash mismatch and never papers over canonical corruption with audit data", () => {
    const canonicalText = "canonical text was changed";
    const expectedText = "original canonical text";
    const result = resolveStructuredObservationSource({
      semanticIntentId: "primary",
      semanticTextHash: hash(expectedText),
      messageMetadata: {
        conversationInteraction: {
          version: 1,
          role: "substantive_new",
          semanticIntents: [{ id: "primary", text: canonicalText }],
        },
      },
      legacyAuditMetadata: {
        retrieval: { parsedQuery: { semanticQuery: expectedText } },
      },
    });

    expect(result).toEqual({ status: "unavailable", reason: "hash_mismatch" });
    expect(result).not.toHaveProperty("semanticText");
  });

  it("never promotes the raw source fragment to an embedding input", () => {
    const rawFragment = "yes";
    const result = resolveStructuredObservationSource({
      semanticIntentId: "unresolved",
      semanticTextHash: null,
      messageMetadata: {},
      legacyAuditMetadata: {},
      rawSourceContent: rawFragment,
    });

    expect(result).toEqual({ status: "unavailable", reason: "semantic_intent_missing" });
    expect(JSON.stringify(result)).not.toContain(rawFragment);
  });

  it("uses next-turn canonical metadata to finalize one pending source identity", () => {
    const semanticText = "Does the product support Okta?";
    const result = resolvePendingStructuredObservationSource({
      messageMetadata: {
        conversationInteractionResolution: {
          version: 1,
          role: "clarification_value",
          valueUserMessageId: "00000000-0000-4000-8000-000000000777",
          semanticIntents: [{ id: "primary", text: semanticText }],
        },
      },
      legacyAuditMetadata: {},
    });

    expect(result).toEqual({
      status: "resolved",
      source: "message_metadata",
      semanticIntentId: "primary",
      semanticText,
      semanticTextHash: hash(semanticText),
    });
  });

  it("resolves an opaque clarification value pointer through its source-owned backlink", () => {
    const sourceUserMessageId = "00000000-0000-4000-8000-000000000701";
    const valueUserMessageId = "00000000-0000-4000-8000-000000000702";
    const semanticText = "Does the product support Okta?";
    const messages: ObservationSourceMessage[] = [
      {
        id: sourceUserMessageId,
        role: "user",
        content: "Does the product support it?",
        metadata: {
          conversationInteraction: {
            version: 1,
            role: "unresolved",
            semanticIntents: [],
          },
          conversationInteractionResolution: {
            version: 1,
            role: "clarification_value",
            valueUserMessageId,
            semanticIntents: [{ id: "primary", text: semanticText }],
          },
        },
      },
      {
        id: valueUserMessageId,
        role: "user",
        content: "Okta",
        metadata: {
          conversationInteraction: {
            version: 1,
            role: "clarification_value",
            sourceUserMessageId,
          },
        },
      },
    ];

    expect(inspectHistoricalTurnInteraction({
      sourceUserMessageId: valueUserMessageId,
      messages,
    })).toEqual({
      status: "resolved",
      source: "message_metadata",
      sourceUserMessageId,
      role: "clarification_value",
      semanticIntents: [{ id: "primary", text: semanticText }],
    });
    expect(inspectHistoricalTurnInteraction({
      sourceUserMessageId,
      messages,
    })).toEqual({ status: "skip", reason: "superseded_by_clarification" });
  });

  it("terminally skips a clarification pointer when its source or backlink is unavailable", () => {
    const valueUserMessageId = "00000000-0000-4000-8000-000000000712";
    const pointer: ObservationSourceMessage = {
      id: valueUserMessageId,
      role: "user",
      content: "Okta",
      metadata: {
        conversationInteraction: {
          version: 1,
          role: "clarification_value",
          sourceUserMessageId: "00000000-0000-4000-8000-000000000711",
        },
      },
    };

    expect(inspectHistoricalTurnInteraction({
      sourceUserMessageId: valueUserMessageId,
      messages: [pointer],
    })).toEqual({ status: "skip", reason: "referenced_source_unavailable" });
  });

  it("replays a resolved clarification once under the earlier source and final assistant", async () => {
    const sourceUserMessageId = "00000000-0000-4000-8000-000000000721";
    const clarificationAssistantId = "00000000-0000-4000-8000-000000000722";
    const valueUserMessageId = "00000000-0000-4000-8000-000000000723";
    const finalAssistantId = "00000000-0000-4000-8000-000000000724";
    const semanticText = "Does the product support Okta?";
    const messages: ObservationSourceMessage[] = [
      {
        id: sourceUserMessageId,
        role: "user",
        content: "Does the product support it?",
        metadata: {
          conversationInteraction: { version: 1, role: "unresolved", semanticIntents: [] },
          conversationInteractionResolution: {
            version: 1,
            role: "clarification_value",
            valueUserMessageId,
            semanticIntents: [{ id: "primary", text: semanticText }],
          },
        },
      },
      { id: clarificationAssistantId, role: "assistant", content: "Which provider?" },
      {
        id: valueUserMessageId,
        role: "user",
        content: "Okta",
        metadata: {
          conversationInteraction: {
            version: 1,
            role: "clarification_value",
            sourceUserMessageId,
          },
        },
      },
      { id: finalAssistantId, role: "assistant", content: "Yes." },
    ];
    const source = { load: vi.fn(async () => ({ messages, legacyAuditMetadata: null })) };
    const budget = { reserve: vi.fn() };
    const interpreter = { interpret: vi.fn() };
    const service = new ContentPlanHistoricalTurnProjectionService(
      source,
      budget as never,
      interpreter as never,
    );

    const result = await service.preparePage({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      now: new Date("2026-08-02T12:00:00.000Z"),
      turns: [
        {
          assistantMessageId: clarificationAssistantId,
          userMessageId: sourceUserMessageId,
          conversationId: "conversation_1",
          createdAt: "2026-08-02T11:58:00.000Z",
          channel: "web",
        },
        {
          assistantMessageId: finalAssistantId,
          userMessageId: valueUserMessageId,
          conversationId: "conversation_1",
          createdAt: "2026-08-02T11:59:00.000Z",
          channel: "web",
        },
      ] as never,
    });

    expect(result).toEqual({
      kind: "ready",
      turns: [{
        conversationId: "conversation_1",
        sourceChannel: "web",
        sourceUserMessageId,
        sourceAssistantMessageId: finalAssistantId,
        interaction: {
          role: "clarification_value",
          semanticIntents: [{ id: "primary", text: semanticText }],
        },
      }],
    });
    expect(budget.reserve).not.toHaveBeenCalled();
    expect(interpreter.interpret).not.toHaveBeenCalled();
  });

  it("counts actual historical interpretation provider attempts with content-free outcomes", async () => {
    const record = vi.fn();
    const turns = [1, 2].map((index) => ({
      assistantMessageId: `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`,
      userMessageId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
      conversationId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      createdAt: `2026-08-02T11:5${index}:00.000Z`,
      channel: "web",
    }));
    const source = {
      load: vi.fn(async ({ turn }: { turn: { userMessageId: string } }) => ({
        messages: [{
          id: turn.userMessageId,
          role: "user" as const,
          content: "private unresolved fragment",
          metadata: {},
        }],
        legacyAuditMetadata: null,
      })),
    };
    const budget = { reserve: vi.fn(async () => ({ kind: "granted" as const })) };
    const interpret = vi.fn()
      .mockResolvedValueOnce({
        role: "substantive_followup",
        semanticIntents: [{ id: "primary", text: "Standalone resolved intent" }],
      })
      .mockRejectedValueOnce(new Error("private provider body"));
    const service = new ContentPlanHistoricalTurnProjectionService(
      source as never,
      budget,
      { interpret } as never,
      { record },
    );

    await expect(service.preparePage({
      workspaceId: "workspace_1",
      generationId: "generation_1",
      now: new Date("2026-08-02T12:00:00.000Z"),
      turns: turns as never,
    })).resolves.toMatchObject({ kind: "ready", turns: [{}, {}] });
    expect(budget.reserve).toHaveBeenCalledWith(expect.objectContaining({ requests: 2 }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "discovery",
      outcome: "completed",
      workspaceId: "workspace_1",
      generationId: "generation_1",
      providerOperation: "historical_interpretation",
      providerCallCount: 1,
      durationMs: expect.any(Number),
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      stage: "discovery",
      outcome: "terminal_failure",
      reason: "historical_interpretation_failed",
      providerOperation: "historical_interpretation",
      providerCallCount: 1,
    }));
    expect(JSON.stringify(record.mock.calls)).not.toContain("private unresolved fragment");
    expect(JSON.stringify(record.mock.calls)).not.toContain("private provider body");
  });

  it("resolves a pending fragment only through bounded next-turn interpretation", async () => {
    const sourceUserMessageId = "00000000-0000-4000-8000-000000000501";
    const messages: ObservationSourceMessage[] = Array.from(
      { length: MAX_HISTORICAL_CONTEXT_MESSAGES + 7 },
      (_, index) => ({
        id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
        role: index % 2 === 0 ? "user" : "assistant",
        content: index === 8 ? "what about that?" : `bounded context ${index}`,
        metadata: {},
      }),
    );
    messages[8] = {
      id: sourceUserMessageId,
      role: "user",
      content: "what about that?",
      metadata: {},
    };
    messages[9] = {
      id: "00000000-0000-4000-8000-000000000509",
      role: "assistant",
      content: "Do you mean Enterprise pricing?",
      metadata: {},
    };
    messages[10] = {
      id: "00000000-0000-4000-8000-000000000510",
      role: "user",
      content: "Enterprise",
      metadata: {},
    };

    const interpret = vi.fn<HistoricalInteractionInterpreterPort["interpret"]>(async () => ({
      role: "substantive_followup",
      semanticIntents: [{ id: "primary", text: "Enterprise plan pricing" }],
    }));
    const result = await resolveHistoricalObservationSource({
      sourceUserMessageId,
      semanticIntentId: "unresolved",
      semanticTextHash: null,
      messages,
      interpreter: { interpret },
    });

    expect(interpret).toHaveBeenCalledOnce();
    const interpretationInput = interpret.mock.calls[0]![0];
    expect(interpretationInput.messages).toHaveLength(MAX_HISTORICAL_CONTEXT_MESSAGES);
    expect(interpretationInput.messages.some(({ id }) => id === sourceUserMessageId)).toBe(true);
    expect(interpretationInput.messages.some(({ id }) => id === messages[10]!.id)).toBe(true);
    expect(result).toEqual({
      status: "resolved",
      source: "historical_interpretation",
      semanticIntentId: "primary",
      semanticText: "Enterprise plan pricing",
      semanticTextHash: hash("Enterprise plan pricing"),
    });
  });

  it("keeps ambiguous historical fragments unavailable without exposing their text", async () => {
    const fragment = "go ahead";
    const result = await resolveHistoricalObservationSource({
      sourceUserMessageId: "00000000-0000-4000-8000-000000000601",
      semanticIntentId: "unresolved",
      semanticTextHash: null,
      messages: [{
        id: "00000000-0000-4000-8000-000000000601",
        role: "user",
        content: fragment,
        metadata: {},
      }],
      interpreter: {
        interpret: async () => ({ role: "unresolved", semanticIntents: [] }),
      },
    });

    expect(result).toEqual({ status: "unavailable", reason: "ambiguous" });
    expect(JSON.stringify(result)).not.toContain(fragment);
  });
});

const sourceRecord = (index: number, overrides: Partial<ContentPlanObservationSourceRecord> = {}): ContentPlanObservationSourceRecord => {
  const semanticText = `bounded semantic intent ${index}`;
  return {
    observationId: `00000000-0000-4000-8001-${String(index).padStart(12, "0")}`,
    conversationId: `00000000-0000-4000-8002-${String(index).padStart(12, "0")}`,
    semanticIntentId: "primary",
    semanticTextHash: hash(semanticText),
    sourceUserMessageId: `00000000-0000-4000-8003-${String(index).padStart(12, "0")}`,
    sourceAssistantMessageId: `00000000-0000-4000-8004-${String(index).padStart(12, "0")}`,
    sourceUserContent: `raw visitor evidence ${index}`,
    sourceUserMetadata: {
      conversationInteraction: {
        version: 1,
        role: "substantive_new",
        semanticIntents: [{ id: "primary", text: semanticText }],
      },
    },
    sourceAssistantMetadata: null,
    auditMetadata: null,
    observedAt: new Date("2026-08-01T12:00:00.000Z"),
    grounding: null,
    ...overrides,
  };
};

describe("ObservationSemanticSourceLoader", () => {
  it("performs one workspace-scoped capped message-owned hydration", async () => {
    const records = Array.from({ length: 10 }, (_, index) => sourceRecord(index + 1));
    const loadSources = vi.fn<ContentPlanObservationSourcePort["loadSources"]>(async (input) =>
      records.filter(({ observationId }) => input.observationIds.includes(observationId)),
    );
    const context = {
      loadContext: vi.fn<HistoricalConversationSourcePort["loadContext"]>(async () => []),
    };
    const interpreter = {
      interpret: vi.fn<HistoricalInteractionInterpreterPort["interpret"]>(async () => ({
        role: "unresolved",
        semanticIntents: [],
      })),
    };
    const loader = new ObservationSemanticSourceLoader({ loadSources }, context, interpreter);
    const requestedIds = [...records.map(({ observationId }) => observationId), records[0]!.observationId];

    const batch = await loader.load({
      workspaceId: "00000000-0000-4000-8000-000000000801",
      observationIds: requestedIds,
    });

    expect(loadSources).toHaveBeenCalledOnce();
    expect(loadSources).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000801",
      observationIds: records.slice(0, 8).map(({ observationId }) => observationId),
      limit: 8,
    });
    expect(batch.items).toHaveLength(8);
    expect(batch.truncatedCount).toBe(2);
    expect(batch.items.every(({ resolution }) => resolution.status === "resolved")).toBe(true);
    expect(context.loadContext).not.toHaveBeenCalled();
    expect(interpreter.interpret).not.toHaveBeenCalled();
  });

  it("loads bounded conversation context only when structured sources cannot resolve a pending row", async () => {
    const pending = sourceRecord(21, {
      semanticIntentId: "unresolved",
      semanticTextHash: null,
      sourceUserContent: "and that one?",
      sourceUserMetadata: {},
      auditMetadata: null,
    });
    const loadContext = vi.fn<HistoricalConversationSourcePort["loadContext"]>(async () => [
      {
        id: pending.sourceUserMessageId,
        role: "user",
        content: pending.sourceUserContent,
        metadata: {},
      },
      {
        id: "00000000-0000-4000-8000-000000000822",
        role: "assistant",
        content: "Do you mean Enterprise pricing?",
        metadata: {},
      },
      {
        id: "00000000-0000-4000-8000-000000000823",
        role: "user",
        content: "Enterprise",
        metadata: {},
      },
    ]);
    const interpreter = {
      interpret: vi.fn<HistoricalInteractionInterpreterPort["interpret"]>(async () => ({
        role: "substantive_followup",
        semanticIntents: [{ id: "primary", text: "Enterprise plan pricing" }],
      })),
    };
    const loader = new ObservationSemanticSourceLoader(
      { loadSources: async () => [pending] },
      { loadContext },
      interpreter,
    );

    const batch = await loader.load({
      workspaceId: "00000000-0000-4000-8000-000000000821",
      observationIds: [pending.observationId],
    });

    expect(loadContext).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000821",
      conversationId: pending.conversationId,
      sourceUserMessageId: pending.sourceUserMessageId,
      limit: MAX_HISTORICAL_CONTEXT_MESSAGES,
    });
    expect(batch.items[0]).toEqual({
      observationId: pending.observationId,
      resolution: {
        status: "resolved",
        source: "historical_interpretation",
        semanticIntentId: "primary",
        semanticText: "Enterprise plan pricing",
        semanticTextHash: hash("Enterprise plan pricing"),
      },
    });
  });

  it("returns content-free unavailability when the message-owned row was deleted", async () => {
    const rawFragment = "yes";
    const context = {
      loadContext: vi.fn<HistoricalConversationSourcePort["loadContext"]>(async () => [{
        id: "missing-source",
        role: "user",
        content: rawFragment,
      }]),
    };
    const loader = new ObservationSemanticSourceLoader(
      { loadSources: async () => [] },
      context,
      { interpret: async () => ({ role: "unresolved", semanticIntents: [] }) },
    );

    const batch = await loader.load({ workspaceId: "workspace", observationIds: ["missing"] });

    expect(batch.items).toEqual([{
      observationId: "missing",
      resolution: { status: "unavailable", reason: "source_unavailable" },
    }]);
    expect(context.loadContext).not.toHaveBeenCalled();
    expect(JSON.stringify(batch)).not.toContain(rawFragment);
  });
});
