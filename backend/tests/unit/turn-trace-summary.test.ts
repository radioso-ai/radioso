import { describe, expect, it } from "vitest";

import type { ConversationTrace } from "@radioso/conversation-contract";

import {
  buildTurnTraceSummary,
  type TurnTraceSummary,
} from "../../src/modules/chat/services/turnTraceSummary.js";

const at = (offsetMs: number): string => new Date(Date.parse("2026-07-18T10:00:00.000Z") + offsetMs).toISOString();

describe("buildTurnTraceSummary", () => {
  it("rolls up spine and capability-leaf model calls without serializing concurrent fan-out", () => {
    const spine: ConversationTrace = {
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
          outputs: {
            modelCalls: [{
              operation: "turn_interpretation",
              model: "gpt-route",
              startedAt: at(10),
              completedAt: at(60),
              durationMs: 50,
              inputTokens: 20,
              outputTokens: 5,
              totalTokens: 25,
              status: "succeeded",
            }],
          },
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
          subTrace: {
            namespace: "retrieval",
            version: 1,
            payload: {
              traceId: "leaf-1",
              startedAt: at(60),
              completedAt: at(180),
              stages: [
                {
                  stageId: "rewrite-a",
                  kind: "query_rewrite",
                  label: "Rewrite A",
                  status: "applied",
                  startedAt: at(70),
                  durationMs: 40,
                  inputs: { model: "gpt-rewrite", operation: "query_rewrite" },
                  metrics: { inputTokens: 10, outputTokens: 4, totalTokens: 14, latencyMs: 40 },
                },
                {
                  stageId: "rewrite-b",
                  kind: "query_rewrite",
                  label: "Rewrite B",
                  status: "applied",
                  startedAt: at(70),
                  durationMs: 60,
                  inputs: { model: "gpt-rewrite", operation: "query_rewrite" },
                  metrics: { inputTokens: 12, outputTokens: 4, totalTokens: 16, latencyMs: 60 },
                },
              ],
              links: [{ fromStageId: "rewrite-a", toStageId: "rewrite-b", kind: "branch" }],
            },
          },
        },
        {
          id: "compose",
          kind: "compose",
          status: "applied",
          startedAt: at(200),
          completedAt: at(450),
          outputs: {
            modelCalls: [{
              operation: "grounded",
              model: "gpt-answer",
              startedAt: at(210),
              completedAt: at(410),
              durationMs: 200,
              inputTokens: 100,
              outputTokens: 40,
              totalTokens: 140,
              status: "succeeded",
            }],
          },
        },
      ],
    };

    expect(buildTurnTraceSummary(spine)).toEqual<TurnTraceSummary>({
      totalLlmCalls: 4,
      serialLlmDepth: 3,
      longestStage: { name: "compose", durationMs: 250 },
      totalModelTimeMs: 350,
      totalTurnWallClockMs: 500,
    });
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
    });
  });
});
