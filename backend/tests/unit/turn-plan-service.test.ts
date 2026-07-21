import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import {
  TurnPlanService,
  parseTurnPlan,
  turnPlanDirectiveClassifications,
  type TurnPlanGatewayFactory,
  type TurnPlanRequest,
} from "../../src/modules/chat/services/turnPlanService.js";

const validPlanJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    route: "retrieval",
    isIdentityQuestion: false,
    intentTopic: "refund policy",
    inScopeRequest: "refund window",
    outsideScopeRequest: null,
    rewrite: {
      rewrittenQuery: "What is the refund window?",
      semanticQuery: "refund window duration",
      lexicalQuery: "refund window",
      queryShape: "policy_answer",
      temporalQueryMode: "none",
      retrievalSubqueries: [],
      turnKind: "fresh_subject",
      proposedActiveSubject: "refund window",
      relatedEntities: [],
      unresolved: false,
      confidence: 0.9,
    },
    responseLanguage: "English",
    routineRankings: [{
      routineId: "book-call",
      confidence: 0.2,
      variables: { company: "Acme", seats: 25 },
    }],
    directiveClassifications: [{ name: "refund-tone", matched: true, confidence: 0.8 }],
    ...overrides,
  });

const candidates = {
  routineIds: new Set(["book-call"]),
  directiveNames: new Set(["refund-tone"]),
};

const history: MessageRecord[] = [];

const request = (overrides: Partial<TurnPlanRequest> = {}): TurnPlanRequest => ({
  query: "How long is the refund window?",
  history,
  answerScopeReference: "Refund support assistant.",
  routineCandidates: [{ routineId: "book-call", title: "Book a call", triggerSummary: "wants a call", priority: 0 }],
  directiveCandidates: [{ name: "refund-tone", condition: "when the customer asks for a refund" }],
  workspaceContext: { workspaceId: "w1" },
  usageContext: {
    workspaceId: "w1",
    conversationId: "conv-1",
    messageId: "msg-1",
    surface: "assistant",
    operation: "turn_planning",
    attemptKey: "msg-1:turn_planning",
  },
  ...overrides,
});

const factory = (client: { complete: ReturnType<typeof vi.fn> }): TurnPlanGatewayFactory & { create: ReturnType<typeof vi.fn> } =>
  ({ create: vi.fn(async () => client) }) as unknown as TurnPlanGatewayFactory & { create: ReturnType<typeof vi.fn> };

describe("parseTurnPlan", () => {
  it("parses a retrieval plan with rewrite, language, rankings, and classifications", () => {
    const plan = parseTurnPlan(validPlanJson(), candidates);
    expect(plan).not.toBeNull();
    expect(plan?.route).toBe("retrieval");
    expect(plan?.responseLanguage).toBe("English");
    expect(plan?.rewriteProposal?.rewrittenQuery).toBe("What is the refund window?");
    expect(plan?.routineRankings).toEqual([{
      routineId: "book-call",
      confidence: 0.2,
      variables: { company: "Acme", seats: 25 },
    }]);
    expect(plan?.directiveClassifications).toEqual([{ name: "refund-tone", matched: true, confidence: 0.8 }]);
  });

  it("drops the rewrite on a direct route", () => {
    const plan = parseTurnPlan(validPlanJson({ route: "direct", rewrite: null }), candidates);
    expect(plan?.route).toBe("direct");
    expect(plan?.rewriteProposal).toBeUndefined();
  });

  it("tolerates code-fenced JSON", () => {
    const plan = parseTurnPlan("```json\n" + validPlanJson() + "\n```", candidates);
    expect(plan?.route).toBe("retrieval");
  });

  it("rejects malformed JSON", () => {
    expect(parseTurnPlan("not json", candidates)).toBeNull();
  });

  it("rejects a route outside the enum", () => {
    expect(parseTurnPlan(validPlanJson({ route: "search" }), candidates)).toBeNull();
  });

  it("rejects an unknown routine id (whole-plan failure)", () => {
    expect(
      parseTurnPlan(validPlanJson({ routineRankings: [{ routineId: "ghost", confidence: 0.5 }] }), candidates),
    ).toBeNull();
  });

  it("rejects an unknown directive name (whole-plan failure)", () => {
    expect(
      parseTurnPlan(
        validPlanJson({ directiveClassifications: [{ name: "ghost", matched: true, confidence: 0.5 }] }),
        candidates,
      ),
    ).toBeNull();
  });

  it("rejects an out-of-range confidence", () => {
    expect(
      parseTurnPlan(validPlanJson({ routineRankings: [{ routineId: "book-call", confidence: 1.5 }] }), candidates),
    ).toBeNull();
  });

  it("rejects an incomplete plan instead of defaulting missing classifications", () => {
    const parsed = JSON.parse(validPlanJson()) as Record<string, unknown>;
    delete parsed.directiveClassifications;
    expect(parseTurnPlan(JSON.stringify(parsed), candidates)).toBeNull();
  });

  it("rejects unknown top-level fields", () => {
    expect(parseTurnPlan(validPlanJson({ unexpected: true }), candidates)).toBeNull();
  });

  it("rejects a retrieval plan without a structured rewrite", () => {
    expect(parseTurnPlan(validPlanJson({ rewrite: null }), candidates)).toBeNull();
  });

  it("rejects duplicate routine rankings", () => {
    expect(
      parseTurnPlan(
        validPlanJson({
          routineRankings: [
            { routineId: "book-call", confidence: 0.7 },
            { routineId: "book-call", confidence: 0.6 },
          ],
        }),
        candidates,
      ),
    ).toBeNull();
  });

  it("rejects non-object routine variables", () => {
    expect(
      parseTurnPlan(
        validPlanJson({
          routineRankings: [{ routineId: "book-call", confidence: 0.7, variables: "Acme" }],
        }),
        candidates,
      ),
    ).toBeNull();
  });

  it("rejects missing or duplicate directive classifications", () => {
    expect(parseTurnPlan(validPlanJson({ directiveClassifications: [] }), candidates)).toBeNull();
    expect(
      parseTurnPlan(
        validPlanJson({
          directiveClassifications: [
            { name: "refund-tone", matched: true, confidence: 0.8 },
            { name: "refund-tone", matched: false, confidence: 0.2 },
          ],
        }),
        candidates,
      ),
    ).toBeNull();
  });

  it("rejects an unusable non-null language label", () => {
    expect(parseTurnPlan(validPlanJson({ responseLanguage: "unknown" }), candidates)).toBeNull();
  });

  it("accepts a null language when none can be determined", () => {
    const plan = parseTurnPlan(validPlanJson({ responseLanguage: null }), candidates);
    expect(plan?.responseLanguage).toBeUndefined();
  });
});

describe("turnPlanDirectiveClassifications", () => {
  it("keeps only matched classifications as contract classifications", () => {
    const plan = parseTurnPlan(
      validPlanJson({
        directiveClassifications: [
          { name: "refund-tone", matched: true, confidence: 0.8 },
        ],
      }),
      candidates,
    );
    expect(turnPlanDirectiveClassifications(plan!)).toEqual([{ name: "refund-tone", confidence: 0.8 }]);
  });

  it("drops unmatched classifications", () => {
    const candidates2 = { routineIds: new Set<string>(), directiveNames: new Set(["a", "b"]) };
    const plan = parseTurnPlan(
      JSON.stringify({
        route: "direct",
        isIdentityQuestion: false,
        intentTopic: null,
        inScopeRequest: null,
        outsideScopeRequest: null,
        rewrite: null,
        responseLanguage: "English",
        routineRankings: [],
        directiveClassifications: [
          { name: "a", matched: false, confidence: 0.9 },
          { name: "b", matched: true, confidence: 0.6 },
        ],
      }),
      candidates2,
    );
    expect(turnPlanDirectiveClassifications(plan!)).toEqual([{ name: "b", confidence: 0.6 }]);
  });
});

describe("TurnPlanService", () => {
  it("resolves a validated plan from one gateway call", async () => {
    const client = { complete: vi.fn(async (_request: { prompt: string }) => ({ text: validPlanJson() })) };
    const gatewayFactory = factory(client);
    const service = new TurnPlanService(gatewayFactory);

    const plan = await service.plan(request());

    expect(gatewayFactory.create).toHaveBeenCalledTimes(1);
    expect(client.complete).toHaveBeenCalledTimes(1);
    expect(plan?.route).toBe("retrieval");
  });

  it("passes the bound usage operation through the factory", async () => {
    const client = { complete: vi.fn(async () => ({ text: validPlanJson() })) };
    const gatewayFactory = factory(client);
    await new TurnPlanService(gatewayFactory).plan(request());
    expect(gatewayFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        usageContext: expect.objectContaining({ operation: "turn_planning" }),
      }),
    );
  });

  it("injects the rolling summary and limits routine-variable extraction to the latest message", async () => {
    const client = { complete: vi.fn(async (_request: { prompt: string }) => ({ text: validPlanJson() })) };
    await new TurnPlanService(factory(client)).plan(request({
      history: [{ role: "user", content: "My company is OldCo." } as MessageRecord],
      query: "Please book a call.",
      conversationSummary: "The buyer previously discussed annual billing.",
    }));

    const prompt = client.complete.mock.calls[0]?.[0].prompt;
    expect(prompt).toContain("The buyer previously discussed annual billing.");
    expect(prompt).toContain("Never copy values from earlier turns");
    expect(prompt).toContain("My company is OldCo.");
  });

  it("returns null on a provider error", async () => {
    const client = { complete: vi.fn(async () => { throw new Error("provider down"); }) };
    const plan = await new TurnPlanService(factory(client)).plan(request());
    expect(plan).toBeNull();
  });

  it("returns null on malformed output", async () => {
    const client = { complete: vi.fn(async () => ({ text: "<<<garbage>>>" })) };
    const plan = await new TurnPlanService(factory(client)).plan(request());
    expect(plan).toBeNull();
  });

  it("returns null (not a rejection) when the timeout fires, aborting the call", async () => {
    const client = {
      complete: vi.fn(
        (req: { signal?: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            if (req.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    };
    const service = new TurnPlanService(factory(client), { timeoutMs: 5 });
    await expect(service.plan(request())).resolves.toBeNull();
  });

  it("propagates an external abort into the gateway call without rejecting", async () => {
    const controller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const client = {
      complete: vi.fn(
        (req: { signal?: AbortSignal }) =>
          new Promise<{ text: string }>((_resolve, reject) => {
            observedSignal = req.signal;
            if (req.signal?.aborted) {
              reject(new Error("aborted"));
              return;
            }
            req.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
          }),
      ),
    };
    const planPromise = new TurnPlanService(factory(client)).plan(request({ signal: controller.signal }));
    controller.abort();
    await expect(planPromise).resolves.toBeNull();
    expect(observedSignal?.aborted).toBe(true);
  });
});
