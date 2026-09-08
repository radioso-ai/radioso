import { describe, expect, it } from "vitest";

import { context, dependencies } from "./copilot-tools-test-helpers.js";

describe("copilot chat readers", () => {
  it("reads a message-scoped trace for an unanswered user turn, including its failure reason", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "turn_trace")!;
    const history = (tool.createTool(context(null)) as { invoke: (input: { messageId: string }, options: unknown) => Promise<unknown> });
    const messageId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    // The port result deliberately models the missing assistant message: the diagnostic
    // belongs to the user turn and is the reason this tool is message-scoped.
    ports.getConversationTurn.mockResolvedValue({
      conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ownership: null,
      message: {
        id: messageId,
        role: "user",
        source: "customer",
        content: "Why did this not get an answer?",
        createdAt: "2026-08-18T10:00:00.000Z",
        turnFailure: {
          eventStatus: "failure",
          recordedAt: "2026-08-18T10:00:01.000Z",
          stream: true,
          errorMessage: "Provider request timed out",
        },
      },
    });

    const result = await history.invoke({ messageId }, {});
    expect(result).toMatchObject({
      trace: {
        conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
        message: {
          id: messageId,
          turnFailure: { errorMessage: "Provider request timed out" },
        },
      },
    });
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
    expect(ports.getConversationTurn).toHaveBeenCalledWith("workspace-1", messageId, {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeTurnFailureDebug: true,
      includeLatency: true,
    });
  });

  it("returns a shallow transcript with feedback and ownership enabled", async () => {
    const ports = dependencies();
    const tool = ports.descriptors.find((descriptor) => descriptor.name === "conversation_transcript")!;
    const conversationId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
    ports.getConversation.mockResolvedValue({
      conversationId,
      agentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      agentName: "Support",
      sourceChannel: "website_embed",
      createdAt: "2026-08-18T10:00:00.000Z",
      updatedAt: "2026-08-18T10:00:02.000Z",
      messageCount: 1,
      ownership: {
        conversationId,
        state: "human_owned",
        ownerDisplayName: "Operator One",
        reason: "retrieval_miss",
        takenOverAt: "2026-08-18T10:00:01.000Z",
      },
      messages: [{
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        role: "assistant",
        source: "ai_agent",
        content: "Here is the answer.",
        createdAt: "2026-08-18T10:00:02.000Z",
        answerFeedbackEntries: [{ kind: "thumbs_down" }],
        latencyMs: 125,
        debug: {
          eventStatus: "success",
          recordedAt: "2026-08-18T10:00:02.000Z",
          stream: true,
          citationCount: 2,
          answerOutcome: "retrieval.answer",
          skillName: "retrieval.answer",
          skillOutcome: "answered",
          skillStatus: "completed",
          route: { generator: "assistant", routeType: "retrieval", routeReason: "grounded", retrievalInvoked: true },
          turnTrace: { private: "must not appear in a transcript" },
        },
      }],
    });

    const result = await tool.createTool(context(null)).invoke({ conversationId }, {} as never) as {
      transcript: { messages: Array<Record<string, unknown>> };
    };

    expect(ports.getConversation).toHaveBeenCalledWith("workspace-1", conversationId, { limit: 100 }, {
      includeAnswerFeedback: true,
      includeOwnership: true,
      includeTurnFailureDebug: true,
      includeLatency: true,
    });
    expect(result.transcript.messages[0]).toMatchObject({
      answerOutcome: "retrieval.answer",
      citationCount: 2,
      latencyMs: 125,
      answerFeedback: [{ kind: "thumbs_down" }],
    });
    expect(result.transcript.messages[0]).not.toHaveProperty("debug");
    expect(tool.outputSchema.safeParse(result).success).toBe(true);
  });

  /**
   * The spine carries each capability's own trace as a sub-trace, and `activityTrace` is the
   * pre-spine field for the same retrieval run. Measured on real turns, the two were byte-identical
   * on 24 of 24 and made up 40% of the payload — a diagnostic read paying twice for one trace.
   */
  describe("turn_trace does not pay twice for one retrieval trace", () => {
    const retrievalTrace = { traceId: "trace-abc", stages: [{ stageId: "routing" }], links: [] };
    const turnWith = (debug: Record<string, unknown>) => ({
      conversationId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      ownership: null,
      message: {
        id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
        role: "assistant",
        source: "assistant",
        content: "answer",
        createdAt: "2026-08-18T10:00:00.000Z",
        debug,
      },
    });
    const readTrace = async (debug: Record<string, unknown>) => {
      const ports = dependencies();
      const tool = ports.descriptors.find((descriptor) => descriptor.name === "turn_trace")!;
      ports.getConversationTurn.mockResolvedValue(turnWith(debug));
      const invoked = await (tool.createTool(context(null)) as { invoke: (input: { messageId: string }, options: unknown) => Promise<{ trace: { message: { debug: Record<string, unknown> } } }> })
        .invoke({ messageId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc" }, {});
      return invoked.trace.message.debug;
    };

    it("omits activityTrace when the spine already carries that same trace", async () => {
      const debug = await readTrace({
        activityTrace: retrievalTrace,
        turnTrace: {
          version: 1,
          spine: { traceId: "spine-1", stages: [{ id: "dispatch:retrieval.answer", subTrace: { namespace: "retrieval", version: 1, payload: retrievalTrace } }] },
        },
      });

      expect(debug.activityTrace).toBeNull();
      // Not lost — the operator still reaches it through the stage that produced it.
      expect(debug.turnTrace).toMatchObject({ spine: { stages: [{ subTrace: { payload: { traceId: "trace-abc" } } }] } });
    });

    it("keeps activityTrace when the spine carries a different trace", async () => {
      const debug = await readTrace({
        activityTrace: retrievalTrace,
        turnTrace: {
          version: 1,
          spine: { traceId: "spine-1", stages: [{ id: "dispatch:other", subTrace: { namespace: "other", version: 1, payload: { traceId: "trace-zzz" } } }] },
        },
      });

      expect(debug.activityTrace).toMatchObject({ traceId: "trace-abc" });
    });

    it("keeps activityTrace when there is no spine to carry it", async () => {
      const debug = await readTrace({ activityTrace: retrievalTrace });

      expect(debug.activityTrace).toMatchObject({ traceId: "trace-abc" });
      expect(debug.turnTrace).toBeNull();
    });
  });

});
