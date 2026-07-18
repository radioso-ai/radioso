import { describe, expect, it } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import { buildAgenticActivityTrace } from "../../src/modules/retrieval/services/agenticActivityTraceBuilder.js";
import { capabilitySubTrace, RETRIEVAL_TRACE_LEAF } from "../../src/modules/chat/services/chatTraceLeaves.js";
import {
  attachCapabilitySubTrace,
  buildTurnTraceEnvelope,
} from "../../src/modules/chat/services/turnTraceEnvelope.js";
import {
  createModelCallTraceCollector,
  recordModelCallTrace,
  runWithModelCallTrace,
} from "../../src/shared/observability/tracing/modelCallTraceContext.js";
import {
  buildTurnTraceSummary,
  type TurnTraceSummary,
} from "../../src/modules/chat/services/turnTraceSummary.js";

const at = (offsetMs: number): string => new Date(Date.parse("2026-07-18T10:00:00.000Z") + offsetMs).toISOString();

describe("buildTurnTraceSummary", () => {
  it("uses the canonical call collection exactly once with a production-built retrieval leaf", () => {
    const retrievalTrace = buildAgenticActivityTrace({
      events: [],
      runResult: {
        terminatedReason: "completed",
        finalMessage: null,
        stepsTaken: 0,
        toolResultTokensUsed: 0,
        wallTimeMs: 120,
      },
      selectedChunkIds: [],
      finalRationale: null,
      traceStartedAtMs: Date.parse(at(60)),
      fallbackBudgets: { maxSteps: 6, maxToolResultTokens: 12_000, maxWallTimeMs: 30_000 },
    });
    const spine: ConversationTrace = attachCapabilitySubTrace({
      traceId: "turn-1",
      startedAt: at(0),
      completedAt: at(500),
      stages: [
        {
          id: "turn_interpretation",
          kind: "turn_interpretation",
          status: "applied",
          startedAt: at(10),
          completedAt: at(60),
        },
        {
          id: "retrieval_fanout",
          kind: "retrieval_fanout",
          status: "applied",
          startedAt: at(60),
          completedAt: at(180),
        },
        {
          id: "dispatch:retrieval.answer",
          kind: "skill_dispatch",
          status: "applied",
          startedAt: at(180),
          completedAt: at(190),
        },
        {
          id: "compose",
          kind: "compose",
          status: "applied",
          startedAt: at(200),
          completedAt: at(450),
        },
      ],
    }, {
      skillName: "retrieval.answer",
      subTrace: capabilitySubTrace(RETRIEVAL_TRACE_LEAF, retrievalTrace),
    });
    const collector = createModelCallTraceCollector({ startedAtMs: Date.parse(at(0)) });
    const addCall = (operation: string, model: string, startedAt: string, completedAt: string, durationMs: number) =>
      recordModelCallTrace({
        operation,
        attemptKey: `private-${operation}`,
        provider: "openai",
        model,
        startedAt,
        completedAt,
        durationMs,
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
        status: "succeeded",
      });
    runWithModelCallTrace(collector, () => {
      addCall("turn_interpretation", "gpt-route", at(10), at(60), 50);
      addCall("query_rewrite", "gpt-rewrite", at(70), at(110), 40);
      addCall("trigger_analysis", "gpt-rewrite", at(70), at(130), 60);
      addCall("grounded", "gpt-answer", at(210), at(410), 200);
    });

    const envelope = buildTurnTraceEnvelope({
      spine,
      modelCallTrace: collector,
      completedAtMs: Date.parse(at(500)),
    });

    expect(envelope.summary).toEqual<TurnTraceSummary>({
      totalLlmCalls: 4,
      serialLlmDepth: 3,
      longestStage: { name: "compose", durationMs: 250 },
      totalModelTimeMs: 350,
      totalTurnWallClockMs: 500,
      droppedCallCount: 0,
    });
    const canonicalCalls = envelope.spine.stages.find((stage) => stage.kind === "model_calls")?.outputs?.modelCalls;
    expect(canonicalCalls).toEqual([
      expect.objectContaining({ operation: "turn_interpretation", stageId: "turn_interpretation" }),
      expect.objectContaining({ operation: "query_rewrite", stageId: "retrieval_fanout" }),
      expect.objectContaining({ operation: "trigger_analysis", stageId: "retrieval_fanout" }),
      expect.objectContaining({ operation: "grounded", stageId: "compose" }),
    ]);
    expect(JSON.stringify(canonicalCalls)).not.toContain("private-");
    expect(JSON.stringify(retrievalTrace.stages)).not.toContain("modelCalls");
  });

  it("attributes calls outside spine stages to the pre-engine turn bucket", () => {
    const spine: ConversationTrace = {
      traceId: "turn-pre-engine",
      startedAt: at(100),
      completedAt: at(300),
      stages: [{
        id: "compose",
        kind: "compose",
        status: "applied",
        startedAt: at(200),
        completedAt: at(300),
      }],
    };
    const collector = createModelCallTraceCollector({ startedAtMs: Date.parse(at(0)) });
    runWithModelCallTrace(collector, () => recordModelCallTrace({
      operation: "response_language_detection",
      attemptKey: "private-language",
      provider: "openai",
      model: "gpt-language",
      startedAt: at(10),
      completedAt: at(50),
      durationMs: 40,
      inputTokens: 4,
      outputTokens: 1,
      totalTokens: 5,
      status: "succeeded",
    }));

    const envelope = buildTurnTraceEnvelope({
      spine,
      modelCallTrace: collector,
      completedAtMs: Date.parse(at(300)),
    });

    expect(envelope.summary).toMatchObject({ totalLlmCalls: 1, totalModelTimeMs: 40 });
    expect(envelope.spine.stages.find((stage) => stage.kind === "model_calls")?.outputs?.modelCalls)
      .toEqual([expect.objectContaining({ operation: "response_language_detection", stageId: "pre_engine" })]);
  });

  it("returns zeroed model totals while retaining turn and longest-stage timing", () => {
    const spine: ConversationTrace = {
      traceId: "turn-2",
      startedAt: at(0),
      completedAt: at(80),
      stages: [{
        id: "selection",
        kind: "skill_selection",
        status: "applied",
        startedAt: at(10),
        completedAt: at(50),
      }],
    };

    expect(buildTurnTraceSummary(spine)).toEqual<TurnTraceSummary>({
      totalLlmCalls: 0,
      serialLlmDepth: 0,
      longestStage: { name: "selection", durationMs: 40 },
      totalModelTimeMs: 0,
      totalTurnWallClockMs: 80,
      droppedCallCount: 0,
    });
  });
});
