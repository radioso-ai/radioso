import { describe, expect, it, vi } from "vitest";

import type { LlmProviderMetadata, TextGenerationClient } from "../../src/shared/infra/llm/providerTypes.js";
import {
  AlwaysMatchDirectiveMatcher,
  CompositeDirectiveMatcher,
  ModelDirectiveMatchGateway,
  ProbabilisticDirectiveMatcher,
  createDirectiveMatcher,
  parseDirectiveClassifications,
  type Directive,
  type DirectiveMatchGateway,
} from "../../src/modules/directives/public.js";
import { loadPromptTemplate } from "../../src/shared/infra/prompts/promptLoader.js";

const directive = (overrides: Partial<Directive> & Pick<Directive, "name" | "action">): Directive => ({
  condition: { kind: "always" },
  ...overrides,
});

const contextual = (name: string, description: string, action = name): Directive =>
  directive({ name, action, condition: { kind: "contextual", description } });

describe("parseDirectiveClassifications", () => {
  const candidates = ["escalate", "be-gentle"];

  it("parses a JSON array and keeps only known directive names", () => {
    const raw = `[{"name":"escalate","confidence":0.8,"reason":"refund dispute"},{"name":"unknown","confidence":0.9}]`;
    expect(parseDirectiveClassifications(raw, candidates)).toEqual([
      { name: "escalate", confidence: 0.8, reason: "refund dispute" },
    ]);
  });

  it("extracts the array from surrounding prose / code fences and clamps confidence", () => {
    const raw = "Here you go:\n```json\n[{\"name\":\"be-gentle\",\"confidence\":1.7}]\n```";
    expect(parseDirectiveClassifications(raw, candidates)).toEqual([{ name: "be-gentle", confidence: 1 }]);
  });

  it("returns an empty array for unparseable or empty output", () => {
    expect(parseDirectiveClassifications("no json here", candidates)).toEqual([]);
    expect(parseDirectiveClassifications("", candidates)).toEqual([]);
  });
});

describe("ProbabilisticDirectiveMatcher", () => {
  const stubGateway = (classifications: Awaited<ReturnType<DirectiveMatchGateway["match"]>>): DirectiveMatchGateway => ({
    match: vi.fn().mockResolvedValue(classifications),
  });

  it("does not call the gateway when there are no contextual directives", async () => {
    const gateway = stubGateway([]);
    const matcher = new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 });
    const matches = await matcher.match({ turnContext: { query: "hi" }, directives: [directive({ name: "a", action: "a" })] });
    expect(matches).toEqual([]);
    expect(gateway.match).not.toHaveBeenCalled();
  });

  it("maps classifications above the threshold to probabilistic matches", async () => {
    const gateway = stubGateway([
      { name: "escalate", confidence: 0.9, reason: "angry customer" },
      { name: "be-gentle", confidence: 0.3 },
    ]);
    const matcher = new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 });
    const matches = await matcher.match({
      turnContext: { query: "this is unacceptable" },
      directives: [contextual("escalate", "customer is angry"), contextual("be-gentle", "customer seems new")],
    });

    expect(matches).toHaveLength(1);
    expect(matches[0]).toMatchObject({
      selectionMode: "probabilistic",
      selectionConfidence: 0.9,
      selectionReason: "angry customer",
    });
    expect(matches[0]!.directive.name).toBe("escalate");
  });

  it("only forwards contextual directives to the gateway", async () => {
    const gateway = stubGateway([]);
    const matcher = new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 });
    await matcher.match({
      turnContext: {},
      directives: [directive({ name: "always-on", action: "x" }), contextual("ctx", "when X")],
    });
    expect(gateway.match).toHaveBeenCalledWith(
      expect.objectContaining({ directives: [expect.objectContaining({ name: "ctx" })] }),
    );
  });

  it("resolves to no matches and notifies the observer when the gateway throws", async () => {
    const failure = new Error("400 Unsupported value");
    const gateway: DirectiveMatchGateway = { match: vi.fn().mockRejectedValue(failure) };
    const onMatchUnavailable = vi.fn();
    const matcher = new ProbabilisticDirectiveMatcher({
      gateway,
      confidenceThreshold: 0.5,
      onMatchUnavailable,
    });

    await expect(
      matcher.match({ turnContext: { query: "hi" }, directives: [contextual("ctx", "when X")] }),
    ).resolves.toEqual([]);
    expect(onMatchUnavailable).toHaveBeenCalledTimes(1);
    expect(onMatchUnavailable).toHaveBeenCalledWith(failure);
  });

  it("does not notify the observer when the gateway succeeds", async () => {
    const gateway = stubGateway([{ name: "ctx", confidence: 0.9 }]);
    const onMatchUnavailable = vi.fn();
    const matches = await new ProbabilisticDirectiveMatcher({
      gateway,
      confidenceThreshold: 0.5,
      onMatchUnavailable,
    }).match({ turnContext: {}, directives: [contextual("ctx", "when X")] });

    expect(matches.map((match) => match.directive.name)).toEqual(["ctx"]);
    expect(onMatchUnavailable).not.toHaveBeenCalled();
  });
});

describe("CompositeDirectiveMatcher", () => {
  it("concatenates results from each delegate matcher", async () => {
    const gateway: DirectiveMatchGateway = { match: vi.fn().mockResolvedValue([{ name: "ctx", confidence: 0.9 }]) };
    const matcher = new CompositeDirectiveMatcher([
      new AlwaysMatchDirectiveMatcher(),
      new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 }),
    ]);
    const matches = await matcher.match({
      turnContext: {},
      directives: [directive({ name: "standing", action: "x" }), contextual("ctx", "when X")],
    });
    expect(matches.map((m) => m.directive.name).sort()).toEqual(["ctx", "standing"]);
    expect(matches.find((m) => m.directive.name === "standing")!.selectionMode).toBe("deterministic");
    expect(matches.find((m) => m.directive.name === "ctx")!.selectionMode).toBe("probabilistic");
  });

  it("keeps the deterministic always matches when the contextual gateway throws", async () => {
    const gateway: DirectiveMatchGateway = { match: vi.fn().mockRejectedValue(new Error("400 Bad Request")) };
    const matcher = new CompositeDirectiveMatcher([
      new AlwaysMatchDirectiveMatcher(),
      new ProbabilisticDirectiveMatcher({ gateway, confidenceThreshold: 0.5 }),
    ]);
    const matches = await matcher.match({
      turnContext: {},
      directives: [directive({ name: "standing", action: "x" }), contextual("ctx", "when X")],
    });

    expect(matches.map((m) => m.directive.name)).toEqual(["standing"]);
  });
});

describe("ModelDirectiveMatchGateway", () => {
  const metadata: LlmProviderMetadata = { provider: "openai", model: "test" } as LlmProviderMetadata;

  it("renders a prompt, calls the client, and parses the structured output", async () => {
    const complete = vi.fn().mockResolvedValue({ text: '[{"name":"escalate","confidence":0.7}]' });
    const client: TextGenerationClient = {
      metadata,
      complete,
      stream: () => ({ textStream: (async function* () {})(), usage: Promise.resolve(undefined) }),
    };
    const gateway = new ModelDirectiveMatchGateway(client);
    const result = await gateway.match({
      turnContext: { query: "I want a refund now" },
      directives: [contextual("escalate", "customer demands a refund")],
    });

    expect(result).toEqual([{ name: "escalate", confidence: 0.7 }]);
    const request = complete.mock.calls[0]![0];
    expect(request.systemPrompt).toBeTruthy();
    expect(request.prompt).toContain("escalate");
    expect(request.prompt).toContain("customer demands a refund");
  });
});

describe("createDirectiveMatcher", () => {
  const metadata: LlmProviderMetadata = { provider: "openai", model: "test" } as LlmProviderMetadata;

  it("injects the backend directive-match prompt file into the default model gateway", async () => {
    const complete = vi.fn().mockResolvedValue({ text: '[{"name":"escalate","confidence":0.7}]' });
    const client: TextGenerationClient = {
      metadata,
      complete,
      stream: () => ({ textStream: (async function* () {})(), usage: Promise.resolve(undefined) }),
    };

    await createDirectiveMatcher({ textGenerationClient: client, confidenceThreshold: 0.5 }).match({
      turnContext: { query: "I want a refund now" },
      directives: [contextual("escalate", "customer demands a refund")],
    });

    expect(complete.mock.calls[0]![0].systemPrompt).toBe(loadPromptTemplate("chat/directive-match.md"));
  });

  it("logs a warning and keeps always directives when the contextual model call fails", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("400 Unsupported parameter"));
    const client: TextGenerationClient = {
      metadata,
      complete,
      stream: () => ({ textStream: (async function* () {})(), usage: Promise.resolve(undefined) }),
    };
    const logger = { debug: vi.fn(), warn: vi.fn() };

    const matches = await createDirectiveMatcher({
      textGenerationClient: client,
      confidenceThreshold: 0.5,
      logger,
    }).match({
      turnContext: { query: "I want a refund now" },
      directives: [directive({ name: "standing", action: "x" }), contextual("escalate", "customer demands a refund")],
    });

    expect(matches.map((match) => match.directive.name)).toEqual(["standing"]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [payload] = logger.warn.mock.calls[0]!;
    expect(payload).toMatchObject({
      event: "directive_contextual_match_unavailable",
      errorType: "Error",
      errorMessage: "400 Unsupported parameter",
    });
    expect(JSON.stringify(payload)).not.toContain("I want a refund now");
  });
});
