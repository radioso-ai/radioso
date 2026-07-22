import { describe, expect, it } from "vitest";

import {
  buildTurnInterpretationPrompt,
  LlmConversationTurnInterpreter,
  parseTurnInterpretation,
  type TurnInterpretationGateway,
} from "../../src/modules/chat/services/conversationTurnInterpreter.js";

describe("ConversationTurnInterpreter", () => {
  it("parses routing fields and a retrieval rewrite proposal from merged JSON", () => {
    const parsed = parseTurnInterpretation(JSON.stringify({
      route: "retrieval",
      isIdentityQuestion: false,
      intentTopic: "retreat details",
      inScopeRequest: "Tell me about the first retreat",
      outsideScopeRequest: null,
      rewrite: {
        rewrittenQuery: "first retreat details",
        semanticQuery: "first retreat details",
        lexicalQuery: "first retreat",
        queryShape: "general_grounding",
        temporalQueryMode: "none",
        retrievalSubqueries: [
          {
            label: "first retreat",
            semanticQuery: "first retreat details",
            lexicalQuery: "first retreat",
            reason: null,
          },
        ],
        turnKind: "referential_followup",
        proposedActiveSubject: "first retreat",
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      },
    }));

    expect(parsed.route).toBe("retrieval");
    expect(parsed.intentTopic).toBe("retreat details");
    expect(parsed.rewrite).toMatchObject({
      rewrittenQuery: "first retreat details",
      semanticQuery: "first retreat details",
      lexicalQuery: "first retreat",
      queryShape: "general_grounding",
      turnKind: "referential_followup",
      confidence: 0.9,
    });
  });

  it("falls back to retrieval routing when the merged gateway fails", async () => {
    const interpreter = new LlmConversationTurnInterpreter({
      async interpret() {
        throw new Error("malformed model output");
      },
    });

    await expect(interpreter.interpretChatTurn({
      query: "What can I book?",
      history: [],
      workspaceId: "workspace-1",
    })).resolves.toEqual({
      route: "retrieval",
      framing: { isIdentityQuestion: false },
    });
  });

  it("normalizes partial merged output with router fallback defaults and no rewrite proposal", async () => {
    const interpreter = new LlmConversationTurnInterpreter(gatewayReturning({}));

    await expect(interpreter.interpretChatTurn({
      query: "Anything available?",
      history: [],
      workspaceId: "workspace-1",
    })).resolves.toEqual({
      route: "retrieval",
      framing: { isIdentityQuestion: false },
    });
  });

  it("does not expose a rewrite proposal for direct turns", async () => {
    const interpreter = new LlmConversationTurnInterpreter(gatewayReturning({
      route: "direct",
      isIdentityQuestion: true,
      intentTopic: "assistant role",
      rewrite: {
        rewrittenQuery: "should be ignored",
        semanticQuery: "should be ignored",
        lexicalQuery: "should be ignored",
        queryShape: "general_grounding",
        temporalQueryMode: "none",
        retrievalSubqueries: [],
        turnKind: "fresh_subject",
        relatedEntities: [],
        unresolved: false,
        confidence: 0.5,
      },
    }));

    const result = await interpreter.interpretChatTurn({
      query: "Who are you?",
      history: [],
      workspaceId: "workspace-1",
    });

    expect(result).toEqual({
      route: "direct",
      framing: {
        intentTopic: "assistant role",
        isIdentityQuestion: true,
      },
    });
  });

  it("uses per-turn usage attribution for eval-driven interpretation", async () => {
    let usageContext: unknown;
    const interpreter = new LlmConversationTurnInterpreter({
      async interpret(input) {
        usageContext = input.usageContext;
        return { route: "direct" };
      },
    });

    await interpreter.interpretChatTurn({
      query: "Who are you?",
      history: [],
      workspaceId: "workspace-1",
      usageAttribution: { surface: "eval", requestId: "run-123" },
    });

    expect(usageContext).toMatchObject({
      surface: "eval",
      requestId: "run-123",
      operation: "turn_interpretation",
    });
  });

  it("keeps custom instructions out of interpretation while rendering rewrite guidance", () => {
    const prompt = buildTurnInterpretationPrompt({
      context: "USER: Which retreats are next? [authoritative for grounding]",
      semanticRewriteInstructions: "Semantic custom guidance.",
      lexicalRewriteInstructions: "Lexical custom guidance.",
      query: "the first one",
    });

    expect(prompt).not.toContain("Configured response instructions:");
    expect(prompt).toContain("Retrieval evidence decides whether the assistant has support");
    expect(prompt).toContain("Do not rely on English keyword matching");
    expect(prompt).toContain("Semantic custom guidance.");
    expect(prompt).toContain("Lexical custom guidance.");
    expect(prompt).toContain('"route":"retrieval|direct"');
    expect(prompt).toContain('"rewrite"');
  });
});

const gatewayReturning = (
  result: Awaited<ReturnType<TurnInterpretationGateway["interpret"]>>,
): TurnInterpretationGateway => ({
  async interpret() {
    return result;
  },
});
