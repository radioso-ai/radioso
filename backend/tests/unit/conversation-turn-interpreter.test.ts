import { describe, expect, it } from "vitest";

import {
  buildTurnInterpretationPrompt,
  LlmConversationTurnInterpreter,
  ModelTurnInterpretationGateway,
  parseTurnInterpretation,
  type TurnInterpretationGateway,
} from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import type { PageReadCapability } from "../../src/modules/chat/services/pageRead/pageReadDecision.js";
import type { ModelInferencePipeline } from "../../src/shared/infra/llm/modelInferencePipeline.js";

const pageReadCapability: PageReadCapability = {
  available: true,
  mode: "content",
  supportedOperations: ["metadata", "lookup", "summarize"],
};

const directInterpretation = (overrides: Record<string, unknown> = {}) => JSON.stringify({
  route: "direct",
  isIdentityQuestion: false,
  intentTopic: null,
  inScopeRequest: null,
  outsideScopeRequest: null,
  rewrite: null,
  ...overrides,
});

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
      pageReadCapability,
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
      today: "2026-10-21",
    });

    expect(prompt).not.toContain("Configured response instructions:");
    expect(prompt).toContain("Retrieval evidence decides whether the assistant has support");
    expect(prompt).toContain("Do not rely on English keyword matching");
    expect(prompt).toContain("Semantic custom guidance.");
    expect(prompt).toContain("Lexical custom guidance.");
    expect(prompt).toContain('"route":"retrieval|direct"');
    expect(prompt).toContain('"rewrite"');
  });

  it("dates the staged interpretation so the rewrite can resolve a named period", () => {
    const prompt = buildTurnInterpretationPrompt({ context: "", query: "Che corsi ci sono a marzo?", today: "2026-10-21 (Wednesday)" });

    expect(prompt).toContain("Today's date: 2026-10-21 (Wednesday)");
    expect(prompt).toContain('"requestedDateRange":{"dateFrom":"YYYY-MM-DD","dateTo":"YYYY-MM-DD"}|null');
  });

  it("dates the staged gateway's prompt with its clock's UTC day and weekday", async () => {
    const prompts: string[] = [];
    const inference = {
      async complete(request: { prompt: string }) {
        prompts.push(request.prompt);
        return { text: directInterpretation() };
      },
    } as unknown as ModelInferencePipeline;

    await new ModelTurnInterpretationGateway(inference, () => new Date("2026-10-21T23:30:00.000Z")).interpret({
      query: "What's on this weekend?",
      contextMessages: [],
      usageContext: {
        workspaceId: "workspace-1",
        surface: "assistant",
        operation: "turn_interpretation",
        attemptKey: "turn_interpretation",
      },
    });

    expect(prompts[0]).toContain("Today's date: 2026-10-21 (Wednesday)");
  });

  it("carries a staged rewrite's requested date range into the proposal", () => {
    const parsed = parseTurnInterpretation(directInterpretation({
      route: "retrieval",
      rewrite: {
        rewrittenQuery: "corsi a marzo 2027",
        semanticQuery: "corsi a marzo 2027",
        lexicalQuery: "corsi marzo",
        queryShape: "event_date_lookup",
        temporalQueryMode: "listing",
        requestedDateRange: { dateFrom: "2027-03-01", dateTo: "2027-03-31" },
        retrievalSubqueries: [],
        turnKind: "fresh_subject",
        proposedActiveSubject: null,
        relatedEntities: [],
        unresolved: false,
        confidence: 0.9,
      },
    }));

    expect(parsed.rewrite?.requestedDateRange).toEqual({ dateFrom: "2027-03-01", dateTo: "2027-03-31" });
  });

  it("keeps pageRead absent without a capability and still parses existing output", () => {
    const parsed = parseTurnInterpretation(directInterpretation());
    expect(parsed).not.toHaveProperty("pageRead");
  });

  it("rejects pageRead without a capability", () => {
    expect(() => parseTurnInterpretation(directInterpretation({
      pageRead: { required: true, operation: "lookup", resolvedRequest: "current page" },
    }))).toThrow();
  });

  it("requires pageRead when a capability is supplied", () => {
    expect(() => parseTurnInterpretation(directInterpretation(), pageReadCapability)).toThrow();
  });

  it("rejects a required page read with null operation and request", () => {
    expect(() => parseTurnInterpretation(directInterpretation({
      pageRead: { required: true, operation: null, resolvedRequest: null },
    }), pageReadCapability)).toThrow();
  });

  it("rejects a not-required page read with non-null fields", () => {
    expect(() => parseTurnInterpretation(directInterpretation({
      pageRead: { required: false, operation: "lookup", resolvedRequest: "current page" },
    }), pageReadCapability)).toThrow();
  });

  it("accepts a valid not-required staged page-read contribution", () => {
    const parsed = parseTurnInterpretation(directInterpretation({
      pageRead: { required: false, operation: null, resolvedRequest: null },
    }), pageReadCapability);
    expect(parsed.pageRead).toEqual({
      required: false,
      operation: null,
      resolvedRequest: null,
    });
  });

  it.each(["lookup", "summarize", "transform"] as const)(
    "accepts a valid %s staged page-read contribution",
    (operation) => {
      const parsed = parseTurnInterpretation(directInterpretation({
        pageRead: { required: true, operation, resolvedRequest: `${operation} request` },
      }), pageReadCapability);
      expect(parsed.pageRead).toEqual({
        required: true,
        operation,
        resolvedRequest: `${operation} request`,
      });
    },
  );

  it("renders staged page-read instructions and output shape only with capability", () => {
    const base = {
      context: "",
      query: "What is on this page?",
      today: "2026-10-21",
    };
    expect(buildTurnInterpretationPrompt(base)).not.toContain("Page Read Classification");
    expect(buildTurnInterpretationPrompt(base)).not.toContain('"pageRead"');

    const prompt = buildTurnInterpretationPrompt({ ...base, pageReadCapability });
    expect(prompt).toContain("Page Read Classification");
    expect(prompt).toContain("mode: content");
    expect(prompt).toContain('"pageRead":{"required":false,"operation":"metadata|lookup|summarize|transform|null","resolvedRequest":"string|null"}');
  });

  it("threads capability through the staged gateway and returns its contribution", async () => {
    let receivedCapability: PageReadCapability | null | undefined;
    const interpreter = new LlmConversationTurnInterpreter({
      async interpret(input) {
        receivedCapability = input.pageReadCapability;
        return {
          route: "direct",
          pageRead: {
            required: true,
            operation: "lookup",
            resolvedRequest: "current page",
          },
        };
      },
    });

    const result = await interpreter.interpretChatTurn({
      query: "What is on this page?",
      history: [],
      workspaceId: "workspace-1",
      pageReadCapability,
    });

    expect(receivedCapability).toEqual(pageReadCapability);
    expect(result.pageRead).toEqual({
      required: true,
      operation: "lookup",
      resolvedRequest: "current page",
    });
  });
});

const gatewayReturning = (
  result: Awaited<ReturnType<TurnInterpretationGateway["interpret"]>>,
): TurnInterpretationGateway => ({
  async interpret() {
    return result;
  },
});
