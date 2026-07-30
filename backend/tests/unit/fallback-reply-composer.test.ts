import { describe, expect, it } from "vitest";

import {
  getGroundedMissFallback,
  MissingFallbackReplyComposer,
  ModelFallbackReplyComposer,
} from "../../src/modules/chat/services/fallbackReplyComposer.js";
import { buildTurnInterpretationPrompt } from "../../src/modules/chat/services/conversationTurnInterpreter.js";
import { buildTurnPlanningPrompt } from "../../src/modules/chat/services/turnPlanService.js";
import { CHAT_BEHAVIOR } from "../../src/shared/domain/behaviorConfig.js";
import type { ModelUsageEvent, UsageEventRecorder } from "../../src/shared/domain/usageEventRecorder.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type { TextGenerationClient } from "../../src/shared/infra/llm/providerTypes.js";
import { streamResult, textResult } from "../support/llmStubs.js";

const recordingUsageRecorder = () => {
  const events: ModelUsageEvent[] = [];
  const recorder: UsageEventRecorder = {
    async recordEmbedding() {},
    async recordModelCall(event) {
      events.push(event);
    },
  };
  return { recorder, events };
};

const pipeline = (client: TextGenerationClient, recorder?: UsageEventRecorder) =>
  new ModelInferencePipelineService(client, recorder);

const usageContext = {
  workspaceId: "workspace-1",
  requestId: "request-1",
  surface: "assistant",
  operation: "answer",
  attemptKey: "grounded_miss",
} as const;

describe("scope-neutral interpretation prompt contract", () => {
  it("leaves support decisions to retrieval in staged and fused interpretation", () => {
    const prompts = [
      buildTurnInterpretationPrompt({ context: "", query: "sqrt(5)" }),
      buildTurnPlanningPrompt({
        query: "sqrt(5)",
        history: [],
        routineCandidates: [{ routineId: "book-call", title: "Book a call", triggerSummary: "wants a call", priority: 0 }],
        directiveCandidates: [{ name: "refund-tone", condition: "when the customer asks for a refund" }],
      }),
    ];

    for (const prompt of prompts) {
      expect(prompt).not.toContain("Configured response instructions:");
      expect(prompt).toContain("Do not classify scope from the question, conversation, or assistant instructions");
      expect(prompt).toContain("Retrieval evidence decides whether the assistant has support");
      expect(prompt).toContain("Always return null for inScopeRequest and outsideScopeRequest");
      expect(prompt).toContain("definition_lookup: identification or one discrete fact or attribute about a named entity");
      expect(prompt).toContain("policy_answer: a procedural, compliance, eligibility, or support-policy question");
      expect(prompt).toContain("Do not use policy_answer merely because the assistant has a behavioral directive about the topic");
      expect(prompt).toContain("semanticQuery must be a concise, self-contained retrieval formulation, not conversational wording");
      expect(prompt).toContain("After resolving a follow-up to a concrete subject, use the specialized shape that fits the resolved request");
      expect(prompt).toContain("selects one by ordinal or relative position");
      expect(prompt).toContain("Do not retain an ordinal placeholder such as first option or second plan after resolving it");
    }

    // Directive and decision-independence rules render only when candidates exist,
    // which prompts[1] now supplies. The output-shape block remains as the
    // schema-less fallback contract for OpenAI-compatible providers.
    expect(prompts[1]).toContain("Return exactly one directiveClassifications entry for every candidate directive");
    expect(prompts[1]).toContain("must not influence route, scope classification, rewrite fields, or responseLanguage");
    expect(prompts[1]).toContain("Never copy candidate routine or directive text into retrieval queries");
    expect(prompts[1]).toContain("Output Shape Rules");
    expect(prompts[1]).toContain("Each retrievalSubqueries item contains only label, semanticQuery, lexicalQuery, and reason");
    expect(prompts[1]).toContain("turnKind belongs only on the enclosing rewrite object");
    expect(CHAT_BEHAVIOR.turnPlanning.reasoningEffort).toBe("low");
    expect(CHAT_BEHAVIOR.turnPlanning.timeoutMs).toBe(12_000);
  });
});

describe("grounded miss response composer", () => {
  it("marks the static missing-model fallback as generation unavailable", async () => {
    const composer = new MissingFallbackReplyComposer();

    await expect(composer.composeNoContext({
      query: "What is the refund policy?",
      usageContext,
    })).resolves.toEqual({
      text: getGroundedMissFallback(),
      declineReason: "generation_unavailable",
    });
  });

  it("lets the model compose the full no-context response", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({
        query: "What is the capital of France?",
        usageContext,
      }),
    ).resolves.toEqual({ text: "MODEL_NO_CONTEXT", declineReason: "content_gap" });
  });

  it("asks the provider for a strict decline schema and returns the classified reply", async () => {
    let observedRequest: { responseFormat?: { name: string; strict: boolean; schema: Record<string, unknown> } } = {};
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete(request) {
        observedRequest = request;
        return textResult(JSON.stringify({
          reply: "That's outside what I can help with, but I can help with our courses.",
          declineReason: "out_of_scope",
        }));
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const result = await composer.composeNoContext({ query: "What is the capital of Mars?", usageContext });

    expect(result).toEqual({
      text: "That's outside what I can help with, but I can help with our courses.",
      declineReason: "out_of_scope",
    });
    expect(observedRequest.responseFormat?.strict).toBe(true);
    const properties = observedRequest.responseFormat?.schema.properties as Record<string, { enum?: string[] }>;
    expect(properties.declineReason?.enum).toEqual(["content_gap", "out_of_scope"]);
  });

  it("classifies an in-remit decline as a content gap", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete() {
        return textResult(JSON.stringify({ reply: "I can't confirm that today.", declineReason: "content_gap" }));
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(composer.composeNoContext({ query: "What does the refund policy say?", usageContext }))
      .resolves.toEqual({ text: "I can't confirm that today.", declineReason: "content_gap" });
  });

  it("degrades to a content gap when the model returns an unusable classification", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete() {
        return textResult(JSON.stringify({ reply: "Not my area.", declineReason: "definitely_not_a_reason" }));
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(composer.composeNoContext({ query: "Anything", usageContext }))
      .resolves.toEqual({ text: "Not my area.", declineReason: "content_gap" });
  });

  it("never shows a truncated decline envelope to the visitor", async () => {
    // The cap has to cover a reasoning pass plus the reply, so a truncated structured
    // response is a real failure mode here. Half-written JSON must not become visible text.
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete() {
        return textResult('{"reply":"I can\'t help with th');
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const result = await composer.composeNoContext({ query: "Anything", usageContext });

    expect(result.text).toBe(getGroundedMissFallback());
    expect(result.declineReason).toBe("generation_unavailable");
  });

  it("still returns bare prose from a provider that did not honor the schema", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete() {
        return textResult("That's outside what I can help with.");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(composer.composeNoContext({ query: "Anything", usageContext }))
      .resolves.toEqual({ text: "That's outside what I can help with.", declineReason: "content_gap" });
  });

  it("applies the length guard to the reply field", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "test-model" },
      async complete() {
        return textResult(JSON.stringify({
          reply: "x".repeat(CHAT_BEHAVIOR.groundedMiss.maxResponseLength + 1),
          declineReason: "out_of_scope",
        }));
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const result = await composer.composeNoContext({ query: "Anything", usageContext });

    expect(result.text).toBe(getGroundedMissFallback());
    expect(result.declineReason).toBe("generation_unavailable");
  });

  it("requests minimal reasoning effort with budget for the decline so reasoning models don't return empty", async () => {
    let observedRequest: { maxOutputTokens?: number; reasoningEffort?: string; systemPrompt?: string } = {};
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: { capability: "chat", provider: "openai", model: "gpt-5-nano" },
      async complete(request) {
        observedRequest = request;
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({ query: "What is the capital of France?", usageContext });

    expect(observedRequest.reasoningEffort).toBe("minimal");
    expect(observedRequest.maxOutputTokens ?? 0).toBeGreaterThanOrEqual(256);
    expect(observedRequest.systemPrompt).toContain("Never answer from general knowledge when support is absent");
    expect(observedRequest.systemPrompt).toContain("Retrieval found no support for the requested answer");
    expect(observedRequest.systemPrompt).toContain("Do not answer it from the question or configured instructions");
    expect(observedRequest.systemPrompt).toContain("give no solution, explanation, summary, translation, calculation");
    expect(observedRequest.systemPrompt).toContain("result, formula, code, facts, draft, or reasoning");
    expect(observedRequest.systemPrompt).toContain("team's first-person voice");
    expect(observedRequest.systemPrompt).toContain("Do not refer to yourself");
  });

  it("passes assistant scope instructions into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ systemPrompt }) {
        observedPrompt = systemPrompt ?? "";
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({
      query: "I like potato chips",
      usageContext,
      answerInstructionBlock: "Configured response instructions:\nHelp visitors choose and book Ananda courses.",
    });

    expect(observedPrompt).toContain("Configured answer instructions:");
    expect(observedPrompt).toContain("Do not refer to yourself");
    expect(observedPrompt).toContain("Help visitors choose and book Ananda courses.");
    expect(observedPrompt).toContain("Redirect to a concrete configured topic");
    expect(observedPrompt).toContain("do not merely ask for a narrower question");
    expect(observedPrompt).toContain("Do not identify, describe, summarize, compare, or explain");
    expect(observedPrompt).toContain("Do not offer unrelated topics from the query");
    expect(observedPrompt).toContain("Never expose their internal label");
    expect(observedPrompt).not.toContain("I like potato chips");
  });

  it("passes matched steering directives into no-context generation", async () => {
    let observedPrompt = "";
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ systemPrompt }) {
        observedPrompt = systemPrompt ?? "";
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({
      query: "Thanks",
      usageContext,
      steering: [
        {
          action: "Prefer short paragraphs and avoid unnecessary structure.",
          source: "directive",
          lifespan: "response",
        },
      ],
    });

    expect(observedPrompt).toContain("The following behavioral directives apply to this turn");
    expect(observedPrompt).toContain("Prefer short paragraphs and avoid unnecessary structure.");
  });

  it("forbids librarian phrasing in the grounded-miss prompt rules", async () => {
    let observedPrompt = "";
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete({ systemPrompt }) {
        observedPrompt = systemPrompt ?? "";
        return textResult("MODEL_NO_CONTEXT");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await composer.composeNoContext({ query: "Draft a follow-up", usageContext });

    expect(observedPrompt).toContain("Decline directly in the team's first-person voice");
    expect(observedPrompt).toContain("Never say “I don't have that information,”");
    expect(observedPrompt).toContain("Never mention documents, materials, sources, search, retrieval");
  });

  it("passes explicit locale guidance into grounded-miss generation", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_LOCALE_SPECIFIC");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({
        query: "Qual e il prezzo del corso?",
        usageContext,
        userExpectedLocale: "it-IT",
      }),
    ).resolves.toEqual({ text: "MODEL_LOCALE_SPECIFIC", declineReason: "content_gap" });
  });

  it("records no-context assistant usage when usage context is present", async () => {
    const { recorder, events } = recordingUsageRecorder();
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("MODEL_NO_CONTEXT", {
          inputTokens: 18,
          outputTokens: 4,
          totalTokens: 22,
          providerRequestId: "req-grounded-miss",
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    }, recorder));

    await composer.composeNoContext({
      query: "What does the pricing page say?",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "grounded_miss",
      },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      accountId: "account-1",
      workspaceId: "workspace-1",
      conversationId: "conversation-1",
      messageId: "message-1",
      surface: "assistant",
      operation: "answer",
      provider: "openai",
      model: "test-model",
      inputTokens: 18,
      outputTokens: 4,
      totalTokens: 22,
      status: "succeeded",
      usageQuality: "actual",
      providerRequestId: "req-grounded-miss",
    });
    expect(events[0]!.idempotencyKey).toContain("grounded_miss");
  });

  it("records each retried no-context provider attempt separately", async () => {
    const { recorder, events } = recordingUsageRecorder();
    let attempts = 0;
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error("transient provider failure");
        }
        return textResult("MODEL_NO_CONTEXT", {
          inputTokens: 18,
          outputTokens: 4,
          totalTokens: 22,
          quality: "actual",
        });
      },
      stream() {
        return streamResult([""]);
      },
    }, recorder));

    await composer.composeNoContext({
      query: "What does the pricing page say?",
      usageContext: {
        accountId: "account-1",
        workspaceId: "workspace-1",
        conversationId: "conversation-1",
        messageId: "message-1",
        surface: "assistant",
        operation: "answer",
        attemptKey: "grounded_miss",
      },
    });

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.status)).toEqual(["failed", "succeeded"]);
    expect(events[0]!.idempotencyKey).toContain("attempt:1");
    expect(events[1]!.idempotencyKey).toContain("attempt:2");
    expect(events[0]!.usageQuality).toBe("estimated");
    expect(events[1]!.usageQuality).toBe("actual");
  });

  it("falls back when the no-context model output is empty", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "What is the capital of France?", usageContext });
    expect(fallback.declineReason).toBe("generation_unavailable");
    expect(fallback.text.length).toBeGreaterThan(0);
    expect(fallback.text).toContain("my current focus");
    expect(fallback.text).not.toContain("narrower question");
    expect(fallback.text).not.toContain("this assistant");
    expect(fallback.text).not.toContain("the assistant");
  });

  it("keeps a scoped no-context response instead of discarding it as boilerplate-worthy", async () => {
    const scopedResponse = [
      "That is outside what I can help with here.",
      "I can help with Ananda Europe, meditation, Kriya Yoga, retreats, satsangs, events, books, videos, news, and the Ananda Assisi retreat center.",
      "If you are exploring spiritual practice, ask about a course, retreat, or upcoming online event.",
      "For example, I can help you find a beginner-friendly meditation option or point you toward the official calendar.",
    ].join(" ");
    expect(scopedResponse.length).toBeGreaterThan(320);

    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult(scopedResponse);
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({ query: "Who is Tesla?", usageContext }),
    ).resolves.toEqual({ text: scopedResponse, declineReason: "content_gap" });
  });

  it("falls back when no-context generation returns empty output for another locale", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "Qual è la capitale della Francia?", usageContext });
    expect(fallback.declineReason).toBe("generation_unavailable");
    expect(fallback.text.length).toBeGreaterThan(0);
  });

  it("falls back without trying to infer locale from ambiguous English tokens", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        return textResult("   ");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "Was changed in the pricing docs?", usageContext });
    expect(fallback.declineReason).toBe("generation_unavailable");
    expect(fallback.text.length).toBeGreaterThan(0);
  });

  it("marks a permanent provider failure as generation unavailable", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw new Error("provider unavailable");
      },
      stream() {
        return streamResult([""]);
      },
    }));

    const fallback = await composer.composeNoContext({ query: "What is the refund policy?", usageContext });

    expect(fallback).toEqual({
      text: getGroundedMissFallback(),
      declineReason: "generation_unavailable",
    });
  });

  it("propagates provider credential errors instead of masking them with fallback copy", async () => {
    const composer = new ModelFallbackReplyComposer(pipeline({
      metadata: {
        capability: "chat",
        provider: "openai",
        model: "test-model",
      },
      async complete() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
      stream() {
        return streamResult([""]);
      },
    }));

    await expect(
      composer.composeNoContext({ query: "What is the capital of France?", usageContext }),
    ).rejects.toMatchObject({
      status: 401,
      code: "invalid_api_key",
    });
  });
});
