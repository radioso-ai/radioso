import { describe, expect, it, vi } from "vitest";

import { EvalReplayService } from "../../src/modules/evals/services/evalReplayService.js";

describe("EvalReplayService", () => {
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

    const service = new EvalReplayService(retrievalPipeline, chatGateway);
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

    const service = new EvalReplayService(retrievalPipeline, chatGateway);

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
            brevityOverrideRequested: false,
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

    expect(replay.answer).toContain("Focused next:");
    expect(replay.answer).toContain("Adjacent Notes:");
    expect(replay.answer).toContain("FAQ:");
  });
});
