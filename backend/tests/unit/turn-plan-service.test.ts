import { describe, expect, it, vi } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import {
  TurnPlanService,
  buildTurnPlanResponseFormat,
  buildTurnPlanningPrompt,
  parseTurnPlan,
  turnPlanDirectiveClassifications,
  type TurnPlanGatewayFactory,
  type TurnPlanRequest,
} from "../../src/modules/chat/services/turnPlanService.js";
import type { PageReadCapability } from "../../src/modules/chat/services/pageRead/pageReadDecision.js";

const validPlanJson = (overrides: Record<string, unknown> = {}): string =>
  JSON.stringify({
    route: "retrieval",
    isIdentityQuestion: false,
    intentTopic: "refund policy",
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
      variables: [
        { field: "company", value: "Acme" },
        { field: "seats", value: "25" },
      ],
    }],
    directiveClassifications: [{ name: "refund-tone", matched: true, confidence: 0.8 }],
    ...overrides,
  });

const candidates = {
  routineIds: new Set(["book-call"]),
  directiveNames: new Set(["refund-tone"]),
};

const pageReadCapability: PageReadCapability = {
  available: true,
  mode: "content",
  supportedOperations: ["metadata", "lookup", "summarize"],
};

const pageReadCandidates = {
  ...candidates,
  pageReadCapability,
};

const history: MessageRecord[] = [];

const request = (overrides: Partial<TurnPlanRequest> = {}): TurnPlanRequest => ({
  query: "How long is the refund window?",
  history,
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
    // Scope is never classified from the turn — retrieval evidence decides support —
    // so the planner is not asked for it and framing never carries it.
    expect(plan?.framing.inScopeRequest).toBeUndefined();
    expect(plan?.framing.outsideScopeRequest).toBeUndefined();
    expect(plan?.responseLanguage).toBe("English");
    expect(plan?.rewriteProposal?.rewrittenQuery).toBe("What is the refund window?");
    expect(plan?.routineRankings).toEqual([{
      routineId: "book-call",
      confidence: 0.2,
      variables: { company: "Acme", seats: "25" },
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

  it("rejects a variables value that is not a field/value pair array", () => {
    expect(
      parseTurnPlan(
        validPlanJson({
          routineRankings: [{ routineId: "book-call", confidence: 0.7, variables: { company: "Acme" } }],
        }),
        candidates,
      ),
    ).toBeNull();
  });

  it("folds variable pairs into a record and omits an empty pair array", () => {
    const withVars = parseTurnPlan(
      validPlanJson({
        routineRankings: [{
          routineId: "book-call",
          confidence: 0.7,
          variables: [{ field: "company", value: "Acme" }],
        }],
      }),
      candidates,
    );
    expect(withVars?.routineRankings[0]?.variables).toEqual({ company: "Acme" });

    const withoutVars = parseTurnPlan(
      validPlanJson({
        routineRankings: [{ routineId: "book-call", confidence: 0.7, variables: [] }],
      }),
      candidates,
    );
    expect(withoutVars?.routineRankings[0]).not.toHaveProperty("variables");
  });

  it("rejects duplicate field names within one ranking entry", () => {
    expect(
      parseTurnPlan(
        validPlanJson({
          routineRankings: [{
            routineId: "book-call",
            confidence: 0.7,
            variables: [
              { field: "company", value: "Acme" },
              { field: "company", value: "OtherCo" },
            ],
          }],
        }),
        candidates,
      ),
    ).toBeNull();
  });

  it("accepts absent ranking/classification arrays when there are no candidates", () => {
    const noCandidates = { routineIds: new Set<string>(), directiveNames: new Set<string>() };
    const plan = parseTurnPlan(
      JSON.stringify({
        route: "direct",
        isIdentityQuestion: false,
        intentTopic: null,
        rewrite: null,
        responseLanguage: "English",
      }),
      noCandidates,
    );
    expect(plan).not.toBeNull();
    expect(plan?.routineRankings).toEqual([]);
    expect(plan?.directiveClassifications).toEqual([]);
  });

  it("still rejects an absent classification array when directive candidates exist", () => {
    const plan = JSON.parse(validPlanJson()) as Record<string, unknown>;
    delete plan.directiveClassifications;
    expect(parseTurnPlan(JSON.stringify(plan), candidates)).toBeNull();
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

  it("keeps pageRead absent without a capability and still parses existing fixtures", () => {
    const plan = parseTurnPlan(validPlanJson(), candidates);
    expect(plan).not.toBeNull();
    expect(plan).not.toHaveProperty("pageRead");
  });

  it("rejects pageRead without a capability", () => {
    expect(parseTurnPlan(validPlanJson({
      pageRead: { required: true, operation: "lookup", resolvedRequest: "refund window" },
    }), candidates)).toBeNull();
  });

  it("requires pageRead when a capability is supplied", () => {
    expect(parseTurnPlan(validPlanJson(), pageReadCandidates)).toBeNull();
  });

  it("rejects a required page read with null operation and request", () => {
    expect(parseTurnPlan(validPlanJson({
      pageRead: { required: true, operation: null, resolvedRequest: null },
    }), pageReadCandidates)).toBeNull();
  });

  it("rejects a not-required page read with non-null fields", () => {
    expect(parseTurnPlan(validPlanJson({
      pageRead: { required: false, operation: "lookup", resolvedRequest: "refund window" },
    }), pageReadCandidates)).toBeNull();
  });

  it("accepts a valid not-required page read", () => {
    const plan = parseTurnPlan(validPlanJson({
      pageRead: { required: false, operation: null, resolvedRequest: null },
    }), pageReadCandidates);
    expect(plan?.pageRead).toEqual({
      required: false,
      operation: null,
      resolvedRequest: null,
    });
  });

  it.each(["lookup", "summarize", "transform"] as const)(
    "accepts a valid %s page read",
    (operation) => {
      const plan = parseTurnPlan(validPlanJson({
        pageRead: { required: true, operation, resolvedRequest: `${operation} request` },
      }), pageReadCandidates);
      expect(plan?.pageRead).toEqual({
        required: true,
        operation,
        resolvedRequest: `${operation} request`,
      });
    },
  );
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

const schemaProperty = (
  format: ReturnType<typeof buildTurnPlanResponseFormat>,
  key: string,
): Record<string, unknown> | undefined => {
  const properties = (format.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  return properties[key];
};

describe("buildTurnPlanResponseFormat", () => {
  it("emits a strict json_schema envelope with a closed object", () => {
    const format = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
    expect(format).toMatchObject({ type: "json_schema", name: "turn_plan", strict: true });
    expect(format.schema.additionalProperties).toBe(false);
  });

  it("constrains routineId and directive name to exactly the candidate values", () => {
    const format = buildTurnPlanResponseFormat({
      routineIds: ["book-call", "cancel"],
      directiveNames: ["refund-tone"],
    });
    const rankingItems = (schemaProperty(format, "routineRankings")?.items ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    expect(rankingItems.properties.routineId.enum).toEqual(["book-call", "cancel"]);
    const classificationItems = (schemaProperty(format, "directiveClassifications")?.items ?? {}) as Record<string, Record<string, Record<string, unknown>>>;
    expect(classificationItems.properties.name.enum).toEqual(["refund-tone"]);
  });

  it("models routine variables as a required field/value pair array", () => {
    const format = buildTurnPlanResponseFormat({ routineIds: ["book-call"], directiveNames: [] });
    const rankingItems = (schemaProperty(format, "routineRankings")?.items ?? {}) as Record<string, unknown>;
    const variables = (rankingItems.properties as Record<string, Record<string, unknown>>).variables;
    expect(variables.type).toBe("array");
    const pairItem = variables.items as Record<string, unknown>;
    expect(pairItem.required).toEqual(["field", "value"]);
    expect(rankingItems.required).toEqual(["routineId", "confidence", "variables"]);
  });

  it("omits ranking/classification properties (and required entries) when a list is empty", () => {
    const format = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
    expect(schemaProperty(format, "routineRankings")).toBeUndefined();
    expect(schemaProperty(format, "directiveClassifications")).toBeUndefined();
    expect(format.schema.required).not.toContain("routineRankings");
    expect(format.schema.required).not.toContain("directiveClassifications");
  });

  it("uses nullable type unions rather than string for optional fields", () => {
    const format = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
    expect(schemaProperty(format, "responseLanguage")?.type).toEqual(["string", "null"]);
    expect(schemaProperty(format, "rewrite")?.type).toEqual(["object", "null"]);
  });

  it("includes a required strict pageRead object only when capability is supplied", () => {
    const withoutCapability = buildTurnPlanResponseFormat({ routineIds: [], directiveNames: [] });
    expect(schemaProperty(withoutCapability, "pageRead")).toBeUndefined();
    expect(withoutCapability.schema.required).not.toContain("pageRead");

    const withCapability = buildTurnPlanResponseFormat({
      routineIds: [],
      directiveNames: [],
      pageReadCapability,
    });
    expect(schemaProperty(withCapability, "pageRead")).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["required", "operation", "resolvedRequest"],
      properties: {
        required: { type: "boolean" },
        operation: {
          type: ["string", "null"],
          enum: ["metadata", "lookup", "summarize", "transform", null],
        },
        resolvedRequest: { type: ["string", "null"] },
      },
    });
    expect(withCapability.schema.required).toContain("pageRead");
  });
});

describe("buildTurnPlanningPrompt", () => {
  const promptInput = (overrides: Partial<Parameters<typeof buildTurnPlanningPrompt>[0]> = {}) => ({
    query: "How long is the refund window?",
    history,
    // A summary keeps the (pre-existing) summary placeholder filled so the
    // no-candidates blank-line assertion isolates the routine/directive sections.
    conversationSummary: "The buyer previously discussed annual billing.",
    routineCandidates: [],
    directiveCandidates: [],
    ...overrides,
  });

  it("renders routine, directive, and decision-independence sections only with candidates", () => {
    const withBoth = buildTurnPlanningPrompt(promptInput({
      routineCandidates: [{ routineId: "book-call", title: "Book a call", triggerSummary: "wants a call", priority: 0 }],
      directiveCandidates: [{ name: "refund-tone", condition: "when the customer asks for a refund" }],
    }));
    expect(withBoth).toContain("Routine Ranking Rules");
    expect(withBoth).toContain("Directive Rules");
    expect(withBoth).toContain("Decision Independence");

    const bare = buildTurnPlanningPrompt(promptInput());
    expect(bare).not.toContain("Routine Ranking Rules");
    expect(bare).not.toContain("Directive Rules");
    expect(bare).not.toContain("Decision Independence");
    expect(bare).not.toMatch(/\n\n\n/);
  });

  it("renders resolved visitor context inside the directive section so conditions can reference it", () => {
    const prompt = buildTurnPlanningPrompt(promptInput({
      directiveCandidates: [{ name: "concierge", condition: "the visitor's cart is worth more than 100" }],
      visitorContext: { cart_value: 120, page_context: { pageUrl: "https://shop.example/cart" } },
    }));

    expect(prompt).toContain("Directive Rules");
    expect(prompt).toContain('"cart_value": 120');
    expect(prompt).toContain("https://shop.example/cart");
    // Directive conditions are the only planner decision that consumes visitor
    // context; routing and rewrite stay firewalled from it.
    expect(prompt.indexOf('"cart_value": 120')).toBeGreaterThan(prompt.indexOf("Directive Rules"));
  });

  it("omits visitor context when the turn has no directive candidates", () => {
    const prompt = buildTurnPlanningPrompt(promptInput({
      visitorContext: { cart_value: 120 },
    }));

    expect(prompt).not.toContain("cart_value");
  });

  it("omits the visitor-context block when nothing resolved", () => {
    const prompt = buildTurnPlanningPrompt(promptInput({
      directiveCandidates: [{ name: "refund-tone", condition: "when the customer asks for a refund" }],
      visitorContext: {},
    }));

    expect(prompt).toContain("Directive Rules");
    expect(prompt).not.toContain("Visitor context");
    expect(prompt).not.toMatch(/\n\n\n/);
  });

  it("renders a compact output shape so schema-less compatible providers still have a JSON contract", () => {
    const prompt = buildTurnPlanningPrompt(promptInput({
      routineCandidates: [{ routineId: "book-call", title: "Book a call", triggerSummary: "wants a call", priority: 0 }],
      directiveCandidates: [{ name: "refund-tone", condition: "when the customer asks for a refund" }],
    }));
    expect(prompt).toContain("Output Shape Rules");
    expect(prompt).toContain("Do not wrap in markdown fences");
    expect(prompt).toContain('"routineRankings":[{"routineId":"string","confidence":0.0,"variables":[{"field":"string","value":"string"}]}]');
    expect(prompt).toContain('"directiveClassifications":[{"name":"string","matched":false,"confidence":0.0}]');
    expect(prompt).toContain("field/value pairs");
  });

  it("omits candidate-dependent fields from the fallback output shape when candidates are absent", () => {
    const prompt = buildTurnPlanningPrompt(promptInput());
    expect(prompt).toContain("Output Shape Rules");
    expect(prompt).not.toContain('"routineRankings"');
    expect(prompt).not.toContain('"directiveClassifications"');
  });

  it("renders page-read instructions and output shape only with capability", () => {
    const withoutCapability = buildTurnPlanningPrompt(promptInput());
    expect(withoutCapability).not.toContain("Page Read Classification");
    expect(withoutCapability).not.toContain('"pageRead"');

    const withCapability = buildTurnPlanningPrompt(promptInput({ pageReadCapability }));
    expect(withCapability).toContain("Page Read Classification");
    expect(withCapability).toContain("mode: content");
    expect(withCapability).toContain("supported operations: metadata, lookup, summarize");
    expect(withCapability).toContain("still emit transform");
    expect(withCapability).toContain('"pageRead":{"required":false,"operation":"metadata|lookup|summarize|transform|null","resolvedRequest":"string|null"}');
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

  it("passes a per-call response format whose enums list this turn's candidates", async () => {
    const client = {
      complete: vi.fn(
        async (_request: { prompt: string; responseFormat?: ReturnType<typeof buildTurnPlanResponseFormat> }) =>
          ({ text: validPlanJson() }),
      ),
    };
    await new TurnPlanService(factory(client)).plan(request());
    const responseFormat = client.complete.mock.calls[0]?.[0].responseFormat;
    expect(responseFormat).toMatchObject({ type: "json_schema", name: "turn_plan", strict: true });
    const properties = (responseFormat?.schema.properties ?? {}) as Record<string, Record<string, unknown>>;
    const rankingItems = properties.routineRankings.items as Record<string, Record<string, Record<string, unknown>>>;
    expect(rankingItems.properties.routineId.enum).toEqual(["book-call"]);
    const classificationItems = properties.directiveClassifications.items as Record<string, Record<string, Record<string, unknown>>>;
    expect(classificationItems.properties.name.enum).toEqual(["refund-tone"]);
  });

  it("passes pageRead through the prompt, response schema, parse, and plan when capability is supplied", async () => {
    const client = {
      complete: vi.fn(
        async (_request: { prompt: string; responseFormat: ReturnType<typeof buildTurnPlanResponseFormat> }) => ({
          text: validPlanJson({
            pageRead: { required: true, operation: "lookup", resolvedRequest: "refund window" },
          }),
        }),
      ),
    };
    const plan = await new TurnPlanService(factory(client)).plan(request({ pageReadCapability }));

    expect(plan?.pageRead).toEqual({
      required: true,
      operation: "lookup",
      resolvedRequest: "refund window",
    });
    const call = client.complete.mock.calls[0]?.[0];
    expect(call?.prompt).toContain("Page Read Classification");
    expect(call?.responseFormat.schema.required).toContain("pageRead");
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
    expect(prompt).toContain("Retrieval evidence decides whether the assistant has support");
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
