import { describe, expect, it, vi } from "vitest";

import { EvalReplayService } from "../../src/modules/evals/services/evalReplayService.js";
import type { GroundedMissResponseComposer } from "../../src/modules/chat/services/groundedMissResponseComposer.js";
import { getAssistantWorkflowPolicy } from "../../src/modules/chat/services/chatExecutionPolicy.js";

const groundedMissResponseComposer: GroundedMissResponseComposer = {
  async composeUnsupportedWithContext() {
    return "I couldn't verify that from the retrieved material.";
  },
  async composeNoContext() {
    return "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.";
  },
};

describe("EvalReplayService", () => {
  it("keeps eval replay classified on the current inline execution path", () => {
    expect(getAssistantWorkflowPolicy("eval.replay")).toMatchObject({
      executionClass: "interactive_synchronous",
      operatorLabel: "Eval replay",
    });
  });

  it("uses the conversational no-context response during replay", async () => {
    const retrievalPipeline = {
      async run() {
        return {
          prompt: "Answer using retrieved context",
          contexts: [],
          diagnostics: {
            parsedQuery: undefined,
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
            appliedConstraints: [],
            fallbackApplied: false,
            rerankStatus: "skipped",
          },
          trace: {
            traceId: "trace-1",
            startedAt: "2026-04-09T00:00:00.000Z",
            stages: [],
            links: [],
          },
          responseSettings: {
            answerSupportPolicy: "warn",
            citationDisplayEnabled: true,
          },
        };
      },
    } as any;

    const chatGateway = {
      async answer() {
        return "unused";
      },
    } as any;

    const service = new EvalReplayService(retrievalPipeline, chatGateway, groundedMissResponseComposer);
    const replay = await service.replay({
      workspaceId: "workspace-1",
      query: "What is the capital of France?",
    });

    expect(replay.answerOutcome).toBe("no_context_refusal");
    expect(replay.answer).toBe(
      "I couldn't find supporting material for that in your workspace documents. If you'd like, try asking about a topic that's covered there.",
    );
  });

  it("measures latency across retrieval and answer generation", async () => {
    const retrievalPipeline = {
      async run() {
        return {
          prompt: "Answer using retrieved context",
          contexts: [],
          diagnostics: {
            parsedQuery: undefined,
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 0 },
            appliedConstraints: [],
            fallbackApplied: false,
            rerankStatus: "skipped",
          },
          trace: {
            traceId: "trace-1",
            startedAt: "2026-04-09T00:00:00.000Z",
            stages: [],
            links: [],
          },
          responseSettings: {
            answerSupportPolicy: "warn",
            citationDisplayEnabled: true,
          },
        };
      },
    } as any;

    const chatGateway = {
      async answer() {
        return "unused";
      },
    } as any;

    const service = new EvalReplayService(retrievalPipeline, chatGateway, groundedMissResponseComposer);

    const nowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(3_000)
      .mockReturnValueOnce(3_500)
      .mockReturnValueOnce(3_500);

    try {
      const replay = await service.replay({
        workspaceId: "workspace-1",
        query: "What is Radioso?",
      });

      expect(replay.latencyMs).toBe(2_500);
      expect(replay.retrievalTrace).toBeDefined();
      expect(replay.retrievalTrace!.stages.at(-1)?.durationMs).toBe(2_500);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("applies guided conversation expansion during replay when grounded alternatives exist", async () => {
    const retrievalPipeline = {
      async run() {
        return {
          prompt: "Answer using retrieved context",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Primary Guide",
              content: "The primary guide explains the direct answer.",
            },
            {
              chunkId: "chunk-2",
              documentId: "doc-2",
              title: "Adjacent Notes",
              content: "Adjacent notes cover a related topic users often ask next.",
            },
            {
              chunkId: "chunk-3",
              documentId: "doc-3",
              title: "FAQ",
              content: "The FAQ lists another nearby area that can be explored.",
            },
          ],
          diagnostics: {
            parsedQuery: undefined,
            candidateCounts: { semantic: 0, lexical: 0, merged: 0, final: 3 },
            appliedConstraints: [],
            fallbackApplied: false,
            rerankStatus: "skipped",
          },
          trace: {
            traceId: "trace-1",
            startedAt: "2026-04-09T00:00:00.000Z",
            stages: [],
            links: [],
          },
          responseSettings: {
            answerSupportPolicy: "strict",
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as any;

    const chatGateway = {
      async answer() {
        return "The primary guide explains the direct answer.[[1]]";
      },
    } as any;

    const service = new EvalReplayService(retrievalPipeline, chatGateway);
    const replay = await service.replay({
      workspaceId: "workspace-1",
      query: "What does the guide say?",
    });

    expect(replay.answer).toBe("The primary guide explains the direct answer.");
  });

  it("preserves trigger diagnostics in replay output", async () => {
    const retrievalPipeline = {
      async run() {
        return {
          prompt: "Answer using retrieved context",
          contexts: [
            {
              chunkId: "chunk-1",
              documentId: "doc-1",
              title: "Conference Schedule",
              content: "The next conference is on 2026-06-20.",
            },
          ],
          diagnostics: {
            rewriteStatus: "skipped",
            rerankStatus: "applied",
            originalCandidateCount: 1,
            rewrittenCandidateCount: 0,
            lexicalCandidateCount: 1,
            normalizedCandidateCount: 1,
            finalContextCount: 1,
            candidateFallbackApplied: true,
            fallbackApplied: true,
            appliedConstraints: [],
            triggerAnalysis: {
              status: "applied",
              consideredRules: [
                {
                  ruleId: "events-only",
                  matched: true,
                  matchStrength: 0.95,
                  reason: "The question is about an upcoming event.",
                  triggerInstructionPreview: "Enact for upcoming events.",
                },
              ],
              matchedRuleIds: ["events-only"],
              unmatchedRuleIds: [],
              matchCount: 1,
              matcherVersion: "test",
            },
            triggerBackoff: {
              applied: true,
              reason: "empty_filtered_candidates",
              relaxedRuleIds: ["events-only"],
              restoredCandidateCount: 1,
            },
          },
          trace: {
            traceId: "trace-1",
            startedAt: "2026-04-09T00:00:00.000Z",
            stages: [
              {
                stageId: "trigger_analysis",
                kind: "trigger_analysis",
                label: "Trigger analysis",
                status: "applied",
              },
            ],
            links: [],
          },
          responseSettings: {
            answerSupportPolicy: "strict",
            citationDisplayEnabled: true,
            conversationMode: "guided",
          },
        };
      },
    } as any;

    const chatGateway = {
      async answer() {
        return "The next conference is on 2026-06-20.[[1]]";
      },
    } as any;

    const service = new EvalReplayService(retrievalPipeline, chatGateway);
    const replay = await service.replay({
      workspaceId: "workspace-1",
      query: "When is the next conference?",
    });

    expect(replay.retrievalInfo.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(replay.retrievalInfo.triggerBackoff).toMatchObject({
      applied: true,
      relaxedRuleIds: ["events-only"],
    });
    expect(replay.retrievalTrace?.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ stageId: "trigger_analysis" })]),
    );
  });
});
