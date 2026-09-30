import { describe, expect, it, vi } from "vitest";

import { ChatAnswerPresenter } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import { RetrievalAnswerComposer } from "../../src/modules/chat/services/retrievalTurnSkill.js";
import { createDirectiveAdherenceSideChannel } from "../../src/shared/domain/directiveAdherence.js";
import type { AssistantSuggestionExpansionService } from "../../src/modules/chat/services/assistantSuggestionExpansionService.js";
import type { ChatAnswerSupport } from "../../src/modules/chat/services/chatAnswerSupport.js";
import type { ChatGateway } from "../../src/modules/chat/contracts/chatGateway.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";

const session = (): PreparedSession => ({
  agent: { id: "agent-1", workspaceId: "workspace-1", name: "Agent" },
  conversation: { id: "conversation-1", workspaceId: "workspace-1" },
  history: [],
  userMessage: { id: "message-1", conversationId: "conversation-1", workspaceId: "workspace-1", role: "user", content: "Can I attend for one day?", createdAt: new Date() },
  effectiveQuery: "Can I attend for one day?",
  turnRoute: "retrieval",
  retrieval: {
    systemPrompt: "Answer from Results only.",
    prompt: "Result 1: The course meets on Saturday.",
    diagnostics: {},
    contexts: [{ documentId: "doc-1", chunkId: "chunk-1", title: "Course schedule", content: "The course meets on Saturday." }],
    responseSettings: { suggestedQuestionsEnabled: false, suggestedQuestionsCount: 0 },
  },
  answerCoverage: {
    availability: "assessed",
    coverage: "unanswered",
    reason: "insufficient_evidence",
    unresolvedRequest: "Whether one-day attendance is permitted",
    schemaVersion: 1,
  },
  stagedContext: [],
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
  turnTrace: { traceId: "trace-1", startedAt: new Date().toISOString(), stages: [] },
} as unknown as PreparedSession);

describe("RetrievalAnswerComposer coverage composition", () => {
  it("wires the coverage head verdict instructions unconditionally and leaves the assessor's own turn outcome intact (#1260)", async () => {
    const gateway = {
      answer: vi.fn(async () => JSON.stringify({
        coverage: "unanswered_insufficient_evidence",
        requestFocus: "whether one-day attendance is permitted",
        outcome: "answer",
        answer: "The course meets on Saturday[[1]], but I cannot confirm one-day attendance[[?]].",
        v: 2,
        claims: [[1], []],
        suggestions: [],
        grounding: "degraded",
      })),
    } as unknown as ChatGateway;
    const composer = new RetrievalAnswerComposer(
      {
        buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
        buildChatUsageContext: () => ({ surface: "assistant", operation: "answer" }),
        buildPromptWithContext: (prompt: string) => prompt,
      } as unknown as ChatAnswerSupport,
      gateway,
      new ChatAnswerPresenter({ apply: () => ({ suggestions: [] }) } as unknown as AssistantSuggestionExpansionService),
      {} as never,
    );

    const result = await composer.composeAnswer(session(), "Can I attend for one day?", undefined, undefined);

    const call = (gateway.answer as unknown as { mock: { calls: Array<[{ systemPrompt: string; prompt: string }]> } }).mock.calls[0][0];
    expect(call.systemPrompt).toContain("Coverage verdict");
    expect(call.systemPrompt).toContain("Coverage-aware response");
    // The pre-compose assessor's own result no longer reaches the prompt (#1260):
    // the model commits its own verdict in the envelope head instead of receiving one.
    expect(call.prompt).not.toContain("coverage");
    expect(call.prompt).not.toContain("Whether one-day attendance is permitted");
    // Whatever populates `session.answerCoverage` (the head recorder's callback
    // in production; the fixture directly here) still drives the turn's
    // answerOutcome; only the prompt injection is gone.
    expect(result.answerOutcome).toBe("coverage_unanswered");
  });

  it("filters coverage-conditional steering by the already-known zero-evidence verdict on the page-context fallback (review round 2, R3)", async () => {
    const gateway = {
      answer: vi.fn(async () => JSON.stringify({
        coverage: "unanswered_insufficient_evidence",
        requestFocus: "the workshop dates",
        outcome: "answer",
        answer: "The page says the workshop runs monthly.",
        v: 2,
        claims: [],
        suggestions: [],
        grounding: "degraded",
      })),
    } as unknown as ChatGateway;
    const zeroContextSession = {
      ...session(),
      retrieval: { ...session().retrieval, contexts: [] },
      directiveSteering: {
        rules: [{
          directiveName: "offer-form",
          action: "Offer the contact form.",
          source: "directive",
          lifespan: "response",
          coverageCriteria: { coverage: ["unanswered"] },
        }],
        matches: [],
        omissions: [],
      },
    } as unknown as PreparedSession;
    const composer = new RetrievalAnswerComposer(
      {
        buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
        buildChatUsageContext: () => ({ surface: "assistant", operation: "answer" }),
        // Different from `session.retrieval.prompt`, so the page-context fallback
        // actually runs instead of `generateAnswerWithPageContext` bailing to null.
        buildPromptWithContext: () => "Page: The workshop runs monthly.",
      } as unknown as ChatAnswerSupport,
      gateway,
      new ChatAnswerPresenter({ apply: () => ({ suggestions: [] }) } as unknown as AssistantSuggestionExpansionService),
      {} as never,
    );

    await composer.composeAnswer(zeroContextSession, "When is the workshop?", undefined, undefined);

    const call = (gateway.answer as unknown as { mock: { calls: Array<[{ systemPrompt: string }]> } }).mock.calls[0][0];
    // The deterministic zero-evidence verdict (`unanswered`/`insufficient_evidence`)
    // is already known and already reported to the coverage sink before this
    // page-context call composes its prompt. A coverage-gated rule that matches it
    // must render as a plain instruction, not as an unresolved condition on a fresh
    // verdict — this call's own envelope schema still asks for one, but nothing
    // reads it; the host already committed to the deterministic verdict.
    expect(call.systemPrompt).toContain("Offer the contact form.");
    expect(call.systemPrompt).not.toContain("Only when your coverage verdict is one of");
  });

  it("builds the directive-adherence schema enum from the same known-verdict-filtered rules as the prompt on the page-context fallback (round 3, Q4)", async () => {
    const gateway = {
      answer: vi.fn(async () => JSON.stringify({
        coverage: "unanswered_insufficient_evidence",
        requestFocus: "the workshop dates",
        outcome: "answer",
        answer: "The page says the workshop runs monthly.",
        v: 2,
        claims: [],
        suggestions: [],
        grounding: "degraded",
      })),
    } as unknown as ChatGateway;
    const zeroContextSession = {
      ...session(),
      retrieval: { ...session().retrieval, contexts: [] },
      directiveSteering: {
        rules: [
          {
            id: "d1",
            directiveName: "offer-form",
            action: "Offer the contact form.",
            source: "directive",
            lifespan: "response",
            // Matches the deterministic zero-evidence verdict (`unanswered`).
            coverageCriteria: { coverage: ["unanswered"] },
          },
          {
            id: "d2",
            directiveName: "book-demo",
            action: "Offer to book a demo.",
            source: "directive",
            lifespan: "response",
            // Never matches the zero-evidence verdict, so it never renders here.
            coverageCriteria: { coverage: ["answered"] },
          },
        ],
        matches: [],
        omissions: [],
      },
    } as unknown as PreparedSession;
    const composer = new RetrievalAnswerComposer(
      {
        buildChatWorkspaceContext: () => ({ workspaceId: "workspace-1" }),
        buildChatUsageContext: () => ({ surface: "assistant", operation: "answer" }),
        buildPromptWithContext: () => "Page: The workshop runs monthly.",
      } as unknown as ChatAnswerSupport,
      gateway,
      new ChatAnswerPresenter({ apply: () => ({ suggestions: [] }) } as unknown as AssistantSuggestionExpansionService),
      {} as never,
      undefined,
      { forSteeringRules: (rules) => createDirectiveAdherenceSideChannel(rules) },
    );

    await composer.composeAnswer(zeroContextSession, "When is the workshop?", undefined, undefined);

    const call = (gateway.answer as unknown as {
      mock: { calls: Array<[{ systemPrompt: string; generation: { responseFormat: { schema: { properties: Record<string, unknown> } } } }]> };
    }).mock.calls[0][0];
    expect(call.systemPrompt).toContain("Offer the contact form.");
    expect(call.systemPrompt).not.toContain("Offer to book a demo.");
    // Q4: the side channel used to build its attestable rule enum from the
    // unfiltered steering rules, so a rule the known-verdict filter dropped from
    // the prompt still showed up as an id the model could (and had to) attest to.
    const adherenceSchema = call.generation.responseFormat.schema.properties.adherence as {
      items: { properties: { rule: { enum: string[] } } };
    };
    expect(adherenceSchema.items.properties.rule.enum).toEqual(["d1"]);
  });
});
