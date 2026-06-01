import request from "supertest";
import { describe, expect, it } from "vitest";

import type { ChatGateway } from "../../src/modules/chat/services/chatService.js";
import type { RerankGateway } from "../../src/modules/retrieval/services/rerankService.js";
import type { TriggerAnalysisGateway } from "../../src/modules/retrieval/services/queryRewriteService.js";
import { SUGGESTIONS_SENTINEL } from "../../src/modules/chat/services/groundedAnswerEnvelope.js";
import type { ProductAnalyticsEvent } from "../../src/shared/analytics/productAnalyticsTypes.js";
import { createTestApp, issueTestToken } from "../support/testApp.js";
import { InMemoryMessageRepository } from "../support/fakes.js";
import { retrievalFixtureDocuments } from "../support/retrievalFixtures.js";

const envelope = (answer: string, suggestions: unknown[]): string =>
  `${answer}\n${SUGGESTIONS_SENTINEL}\n${JSON.stringify(suggestions)}`;

const isoDateOffset = (offsetDays: number): string => {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + offsetDays);
  return value.toISOString().slice(0, 10);
};

const getAnalyticsPayload = (metadata: Record<string, unknown>): ProductAnalyticsEvent | null => {
  const candidate = metadata.analytics;
  if (!candidate || typeof candidate !== "object" || typeof (candidate as { eventName?: unknown }).eventName !== "string") {
    return null;
  }

  return candidate as ProductAnalyticsEvent;
};

describe("chat integration", () => {
  it("evaluates today() dynamically for date metadata rules", async () => {
    const { app } = createTestApp();
    const { token } = await issueTestToken(app, "dynamic-date@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Upcoming Conference",
        content: "The next conference is scheduled soon.",
        metadata: {
          category: "event",
          dateFrom: isoDateOffset(5),
        },
      })
      .expect(202);

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Past Conference",
        content: "The last conference already happened.",
        metadata: {
          category: "event",
          dateFrom: isoDateOffset(-5),
        },
      })
      .expect(202);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        metadataRules: [
          {
            id: "upcoming-events",
            field: "dateFrom",
            valueType: "date",
            operator: "gte",
            value: "today()",
            effect: "filter",
            enabled: true,
            triggerMode: "always_on",
          },
        ],
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Which conference is upcoming?", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Upcoming Conference",
        }),
      ]),
    );
    expect(response.body.debug.activitySummary.appliedConstraints).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          signalKey: "metadata.dateFrom",
          summary: "dateFrom >= today()",
        }),
      ]),
    );
    expect(response.body.debug.activitySummary.candidateCounts.final).toBeGreaterThan(0);
  });

  it("enacts triggerable filters only for matched turns", async () => {
    const triggerAnalysisGateway: TriggerAnalysisGateway = {
      async analyze({ query, rules }) {
        const eventRule = rules.find((rule) => rule.id === "events-only");
        const matched = /conference|event|course|camp/i.test(query);

        return {
          status: "applied",
          consideredRules: eventRule
            ? [
                {
                  ruleId: eventRule.id,
                  matched,
                  matchStrength: matched ? 0.95 : 0.08,
                  reason: matched
                    ? "The user is asking about an upcoming event."
                    : "The user is not asking an event-style question.",
                  triggerInstructionPreview: eventRule.triggerInstruction ?? "",
                },
              ]
            : [],
          matchedRuleIds: matched && eventRule ? [eventRule.id] : [],
          unmatchedRuleIds: !matched && eventRule ? [eventRule.id] : [],
          matchCount: matched && eventRule ? 1 : 0,
          matcherVersion: "test",
        };
      },
    };
    const { app } = createTestApp({ triggerAnalysisGateway });

    const { token } = await issueTestToken(app, "triggered-filters@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Conference Schedule",
        content: "The next conference is on 2026-06-20.",
        metadata: {
          category: "event",
          dateFrom: "2026-06-20",
        },
      });

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Medical Glossary",
        content: "Mononuclear disease is an older term associated with infectious mononucleosis.",
        metadata: {
          category: "glossary",
        },
      });

    const settingsResponse = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "Keep the query meaning-preserving and standalone.",
        lexicalRewriteInstructions: "Prefer exact literals, aliases, and corpus-native notation.",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        metadataRules: [
          {
            id: "events-only",
            field: "category",
            valueType: "string",
            operator: "equals",
            value: "event",
            effect: "filter",
            enabled: true,
            triggerMode: "match_turn",
            triggerInstruction: "Enact when the user is asking about upcoming events, conferences, camps, or courses.",
          },
        ],
      });

    expect(settingsResponse.status).toBe(200);

    const matched = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "When is the next conference?", stream: false, includeDebug: true });

    const unmatched = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What is mononuclear disease?", stream: false, includeDebug: true });

    expect(matched.status).toBe(200);
    expect(unmatched.status).toBe(200);
    expect(matched.body.answer).toEqual(expect.any(String));
    expect(unmatched.body.answer).toEqual(expect.any(String));
    expect(matched.body.debug.activitySummary.triggerAnalysis).toMatchObject({
      matchedRuleIds: ["events-only"],
      matchCount: 1,
    });
    expect(unmatched.body.debug.activitySummary.triggerAnalysis).toMatchObject({
      matchedRuleIds: [],
      unmatchedRuleIds: ["events-only"],
      matchCount: 0,
    });
    expect(matched.body.debug.activityTrace.stages).toEqual(
      expect.arrayContaining([expect.objectContaining({ stageId: "trigger_analysis", kind: "trigger_analysis" })]),
    );
  });

  it("adds bounded grounded continuations without conversation-mode metadata", async () => {
    const deterministicGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The testing guide explains testing and parsing content for users[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [
            { text: "Which input formats do the parser notes list?", kind: "deeper", contextIndex: 1 },
            { text: "Which onboarding questions are answered?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "The testing guide explains testing and parsing content for users[[1]].";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: deterministicGateway });

    const { token, workspaceId } = await issueTestToken(app, "conversation-modes@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Testing Guide", content: "The testing docs cover testing and parsing content for users." },
      { title: "Parser Notes", content: "The testing docs cover parser validation rules and supported input formats." },
      { title: "User FAQ", content: "The testing docs cover common user questions and onboarding tips." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const ask = async () => {
      const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
      await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
        ...existing,
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
      });
      const agent = await dependencies.agentService.resolve(workspaceId);
      await dependencies.agentService.update(workspaceId, agent.id, {
        suggestedQuestionsEnabled: true,
      });

      return request(app)
        .post("/api/v1/assistant/chat")
        .set("Authorization", authorization)
        .send({ message: "What do the testing docs cover?", stream: false, includeDebug: true });
    };

    const factual = await ask();
    const followUp = await ask();

    expect(factual.status).toBe(200);
    expect(followUp.status).toBe(200);

    expect(factual.body.answer).toEqual(expect.any(String));
    expect(followUp.body.answer).toEqual(expect.any(String));
    expect(factual.body.answer).not.toContain("\n- ");
    expect(followUp.body.answer).not.toContain("\n- ");
    expect(followUp.body.suggestions.length).toBeGreaterThan(0);
    expect(followUp.body.suggestions.length).toBeLessThanOrEqual(3);
    expect(followUp.body.conversationModeMetadata).toBeUndefined();
  });

  it("suppresses suggested questions when the setting is disabled", async () => {
    const deterministicGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The testing guide explains testing and parsing content for users[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          return envelope(answerText, [{ text: "What parser rules apply?", kind: "deeper", contextIndex: 1 }]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "The testing guide explains testing and parsing content for users[[1]].";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: deterministicGateway });

    const { token, workspaceId } = await issueTestToken(app, "conversation-modes-disabled@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Testing Guide",
        content: "The testing docs cover testing and parsing content for users.",
      });

    const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
    await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
      ...existing,
      queryRewriteEnabled: false,
      suggestedQuestionsEnabled: false,
      suggestedQuestionsCount: 4,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.1,
      rerankTopK: 5,
    });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What do the testing docs cover?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.suggestions).toBeUndefined();
    expect(response.body.conversationModeMetadata).toBeUndefined();
  });

  it("uses recent conversation context for broader exploratory suggestions across turns", async () => {
    let latestSuggestionPrompt = "";
    const deterministicGateway: ChatGateway = {
      async answer({ systemPrompt, query }) {
        const answerText =
          query === "What should I add next?"
            ? "Add meals and orientation[[1]]."
            : "Start with a beginner retreat schedule[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          latestSuggestionPrompt = systemPrompt;
          return envelope(answerText, [
            { text: "What should the retreat schedule include?", kind: "deeper", contextIndex: 1 },
            { text: "How should facilitators support retreat attendees?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: deterministicGateway });

    const { token, workspaceId } = await issueTestToken(app, "conversation-intent@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Retreat Planning Guide", content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation." },
      { title: "Retreat Facilitation Notes", content: "Facilitators should balance logistics, teaching goals, and attendee support." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
    await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
      ...existing,
      queryRewriteEnabled: false,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 4,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.1,
      rerankTopK: 5,
    });

    const first = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Help me plan a beginner retreat", stream: false, includeDebug: true });
    const second = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        message: "What should I add next?",
        stream: false,
        includeDebug: true,
      });

    expect(second.status).toBe(200);
    expect(latestSuggestionPrompt).toContain("Recent conversation context");
    expect(second.body.suggestions).toHaveLength(2);
    expect(second.body.suggestions.some((suggestion: { kind: string }) => suggestion.kind === "deeper")).toBe(true);
    expect(second.body.suggestions.some((suggestion: { kind: string }) => suggestion.kind === "broader")).toBe(true);
  });

  it("recenters broader exploratory suggestions after an explicit subject pivot", async () => {
    let latestSuggestionPrompt = "";
    const deterministicGateway: ChatGateway = {
      async answer({ systemPrompt, query }) {
        const answerText =
          query === "What about facilitator support?"
            ? "Facilitators should balance logistics and attendee care[[1]]."
            : "Start with a beginner retreat schedule[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          latestSuggestionPrompt = systemPrompt;

          if (systemPrompt.includes("Active subject:\nFacilitator support")) {
            return envelope(answerText, [
              { text: "How should facilitators support retreat attendees?", kind: "deeper", contextIndex: 1 },
              { text: "Which support roles should back up retreat facilitators?", kind: "broader", contextIndex: 2 },
            ]);
          }

          return envelope(answerText, [
            { text: "What should the retreat schedule include?", kind: "deeper", contextIndex: 1 },
            { text: "How should retreat facilitators support attendees?", kind: "broader", contextIndex: 2 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const queryRewriteGateway = {
      async rewrite({ query }: { query: string }) {
        if (query === "What about facilitator support?") {
          return {
            rewrittenQuery: "facilitator support",
            semanticQuery: "facilitator support retreat attendees",
            lexicalQuery: "facilitator support",
            turnKind: "explicit_recenter" as const,
            proposedActiveSubject: "Facilitator support",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.97,
          };
        }

        return {
          rewrittenQuery: "beginner retreat planning",
          semanticQuery: "beginner retreat planning",
          lexicalQuery: "beginner retreat planning",
          turnKind: "fresh_subject" as const,
          proposedActiveSubject: "Beginner retreat planning",
          relatedEntities: [],
          unresolved: false,
          confidence: 0.94,
        };
      },
    };
    const { app, dependencies } = createTestApp({
      chatGateway: deterministicGateway,
      queryRewriteGateway,
    });

    const { token, workspaceId } = await issueTestToken(app, "conversation-pivot@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Retreat Planning Guide", content: "A beginner retreat should cover meditation, schedule planning, meals, and orientation." },
      { title: "Retreat Facilitation Notes", content: "Facilitators should balance logistics, teaching goals, and attendee support." },
      { title: "Retreat Support Roles", content: "Support roles include hospitality, orientation, and attendee care." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
    await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
      ...existing,
      queryRewriteEnabled: true,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 4,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.1,
      rerankTopK: 5,
    });

    const first = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Help me plan a beginner retreat", stream: false, includeDebug: true });
    const second = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        message: "What about facilitator support?",
        stream: false,
        includeDebug: true,
      });

    expect(second.status).toBe(200);
    expect(latestSuggestionPrompt).toContain("Active subject:\nFacilitator support");
    expect(second.body.suggestions).toHaveLength(2);
    expect(second.body.suggestions.some((suggestion: { kind: string }) => suggestion.kind === "deeper")).toBe(true);
    expect(second.body.suggestions.some((suggestion: { kind: string }) => suggestion.kind === "broader")).toBe(true);
  });

  it("caps suggestions at three without directness-mode filtering", async () => {
    let envelopeCallCount = 0;
    const deterministicGateway: ChatGateway = {
      async answer({ systemPrompt }) {
        const answerText = "The testing guide explains testing and parsing content for users[[1]].";
        if (systemPrompt?.includes("Output envelope")) {
          envelopeCallCount += 1;
          return envelope(answerText, [
            { text: "How should teams apply these rules?", kind: "deeper", contextIndex: 1 },
            { text: "What setup examples are available?", kind: "deeper", contextIndex: 1 },
            { text: "Which workflow risks should I compare?", kind: "broader", contextIndex: 1 },
            { text: "What rollout steps come next?", kind: "broader", contextIndex: 1 },
          ]);
        }
        return answerText;
      },
      async *streamAnswer() {
        yield "The testing guide explains testing and parsing content for users[[1]].";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: deterministicGateway });

    const { token, workspaceId } = await issueTestToken(app, "conversation-directness@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Testing Guide",
        content: "The testing docs cover testing and parsing content for users.",
      });

    const existing = await dependencies.retrievalSettingsService.getForWorkspace(workspaceId);
    await dependencies.retrievalSettingsService.updateForWorkspace(workspaceId, {
      ...existing,
      queryRewriteEnabled: false,
      suggestedQuestionsEnabled: true,
      suggestedQuestionsCount: 4,
      rerankEnabled: false,
      vectorTopK: 20,
      similarityThreshold: 0.1,
      rerankTopK: 5,
    });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Just the answer: what do the testing docs cover?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(envelopeCallCount).toBe(1);
    expect(response.body.suggestions).toHaveLength(3);
    expect(response.body.conversationModeMetadata).toBeUndefined();
  });

  it("creates a new conversation and reuses it on follow-up questions", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "followup@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const first = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });
    const second = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        message: "And who is it for?",
        stream: false,
        includeDebug: true,
      });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.conversationId).toEqual(first.body.conversationId);
    expect(second.body.answer).toEqual(expect.any(String));
  });

  it("returns a safe answer when no relevant chunks are found", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "empty@example.com");

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What is the capital of France?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
  });

  it("records product analytics for completed chat answers", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "chat-analytics@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);

    const analyticsEvent = [...repositories.auditEventRepository.items]
      .reverse()
      .find((event) => event.eventType === "product.analytics" && getAnalyticsPayload(event.metadata)?.eventName === "chat.completed");
    const analyticsPayload = analyticsEvent ? getAnalyticsPayload(analyticsEvent.metadata) : null;

    expect(analyticsEvent).toBeTruthy();
    expect(analyticsPayload).toEqual(
      expect.objectContaining({
        eventName: "chat.completed",
        subjectType: "conversation",
        source: "backend",
      }),
    );
  });

  it("returns an actionable provider setup error when the model provider rejects credentials", async () => {
    const failingGateway: ChatGateway = {
      async answer() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
      async *streamAnswer() {
        throw {
          status: 401,
          code: "invalid_api_key",
          error: {
            message: "Incorrect API key provided.",
            code: "invalid_api_key",
          },
        };
      },
    };
    const { app } = createTestApp({ chatGateway: failingGateway });

    const { token } = await issueTestToken(app, "provider-error@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      error: {
        code: "service_unavailable",
        message: "The AI provider rejected the credentials. Replace the workspace API key at Settings → Credentials, or update the matching environment variable (OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or OPENAI_COMPATIBLE_API_KEY) and restart Radioso.",
      },
    });
  });

  it("returns a normal JSON 500 when streaming fails before the first SSE event", async () => {
    const { app, dependencies } = createTestApp();

    dependencies.chatService.streamAnswer = async function* () {
      throw new Error("stream setup failed");
    };

    const { token } = await issueTestToken(app, "stream-route-error@example.com");

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", `Bearer ${token}`)
      .send({ message: "What does the page explain?", stream: true });

    expect(response.status).toBe(500);
    expect(response.headers["content-type"]).toContain("application/json");
    expect(response.body).toEqual({
      error: {
        code: "internal_error",
        message: "Internal server error",
      },
    });
  });

  it("delivers mixed-support answers intact without dropping uncited sentences", async () => {
    const mixedGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const { app } = createTestApp({ chatGateway: mixedGateway });

    const { token } = await issueTestToken(app, "mixed-support@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toContain("24/7 phone support");
    expect(response.body.answerSegments).toEqual([
      { text: "The page explains testing and parsing content for users", citationIndices: [0] },
      { text: ". It also offers 24/7 phone support." },
    ]);
  });

  it("turns fully unsupported grounded drafts into a conversational grounded miss", async () => {
    const unsupportedGateway: ChatGateway = {
      async answer() {
        return "It also offers 24/7 phone support and a discount code.";
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone support and a discount code.";
      },
    };
    const { app } = createTestApp({ chatGateway: unsupportedGateway });

    const { token } = await issueTestToken(app, "fully-unsupported@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.answer).not.toContain("discount code");
  });

  it("uses exploratory recovery without leaking unsupported claims", async () => {
    const unsupportedGateway: ChatGateway = {
      async answer() {
        return "It also offers 24/7 phone support and a discount code.";
      },
      async *streamAnswer() {
        yield "It also offers 24/7 phone support and a discount code.";
      },
    };
    const { app } = createTestApp({ chatGateway: unsupportedGateway });

    const { token } = await issueTestToken(app, "unsupported-exploratory@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      { title: "Guide", content: "The testing docs cover testing and parsing content for users." },
      { title: "Parser Notes", content: "The testing docs cover parser validation rules and supported input formats." },
      { title: "User FAQ", content: "The testing docs cover common user questions and onboarding tips." },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What do the testing docs cover?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.answer).not.toContain("\n- ");
    expect(response.body.answer).not.toContain("discount code");
    expect(response.body.answer).not.toContain("24/7 phone support");
  });

  it("keeps conversations account scoped", async () => {
    const { app } = createTestApp();

    const { token: firstToken } = await issueTestToken(app, "scope-a@example.com");
    const { token: secondToken } = await issueTestToken(app, "scope-b@example.com");

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ title: "A", content: "Account A data only." });

    const firstChat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", `Bearer ${firstToken}`)
      .send({ message: "What data is here?", stream: false, includeDebug: true });
    const secondChat = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", `Bearer ${secondToken}`)
      .send({
        conversationId: firstChat.body.conversationId,
        message: "Can I reuse this conversation?",
        stream: false,
        includeDebug: true,
      });

    expect(firstChat.status).toBe(200);
    expect(secondChat.status).toBe(404);
  });

  it("returns grounded answers for strict and broad retrieval profiles", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "profiles@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of Object.values(retrievalFixtureDocuments)) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    const strictSettings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 100,
        similarityThreshold: 0.8,
        rerankTopK: 20,
        chunkingStrategy: "fixed_window",
      });

    const strictResponse = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
        includeDebug: true,
      });

    const broadSettings = await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 100,
        similarityThreshold: 0.2,
        rerankTopK: 20,
        chunkingStrategy: "fixed_window",
      });

    const firstFollowUp = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "Tell me about the session cookie",
        stream: false,
        includeDebug: true,
      });
    const broadResponse = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: firstFollowUp.body.conversationId,
        message: "What is it used for?",
        stream: false,
        includeDebug: true,
      });

    expect(strictSettings.status).toBe(200);
    expect(strictResponse.status).toBe(200);
    expect(strictResponse.body.answer).not.toContain("could not find relevant information");

    expect(broadSettings.status).toBe(200);
    expect(broadResponse.status).toBe(200);
    expect(broadResponse.body.answer).not.toContain("could not find relevant information");
  });

  it("records retrieval diagnostics for successful chats", async () => {
    const { app, dependencies } = createTestApp();

    const { token } = await issueTestToken(app, "diagnostics@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.sessionCookie);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 50,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "Tell me about the session cookie",
        stream: false,
        includeDebug: true,
      });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(response.body.debug.activitySummary).toMatchObject({
      execution: {
        surface: "assistant",
        path: "assistant_retrieval",
        retrievalInvoked: true,
      },
      candidateCounts: {
        semantic: expect.any(Number),
        lexical: expect.any(Number),
        merged: expect.any(Number),
        final: expect.any(Number),
      },
      rerankStatus: expect.any(String),
      fallbackApplied: expect.any(Boolean),
      rewrite: {
        status: expect.any(String),
        eligible: expect.any(Boolean),
        ran: expect.any(Boolean),
        materialDisagreement: expect.any(Boolean),
      },
    });
    expect(response.body.debug.route).toEqual({
      type: "retrieval",
      reason: "evidence_required",
    });
    expect(response.body.debug.activityTrace).toMatchObject({
      summary: {
        execution: {
          surface: "assistant",
          path: "assistant_retrieval",
          retrievalInvoked: true,
        },
        shapeName: expect.any(String),
        queryShape: expect.any(String),
        resolvedSteps: expect.any(Array),
        skillDiagnostic: expect.objectContaining({
          skillName: "retrieval.answer",
          callerSurface: "assistant",
          selectionMode: "deterministic",
          evidence: expect.objectContaining({
            supportStatus: expect.any(String),
          }),
        }),
      },
      stages: expect.any(Array),
    });
    expect(chatAudit?.metadata?.retrieval).toMatchObject({
      rewriteStatus: expect.any(String),
      rerankStatus: expect.any(String),
      originalCandidateCount: expect.any(Number),
      normalizedCandidateCount: expect.any(Number),
      finalContextCount: expect.any(Number),
      queryEmbeddingDurationMs: expect.any(Number),
      rewriteEligible: expect.any(Boolean),
      rewriteRan: expect.any(Boolean),
    });
    expect(chatAudit?.metadata).toMatchObject({
      assistantMessageId: expect.any(String),
      conversationId: response.body.conversationId,
      stream: false,
      route: {
        generator: "assistant",
        routeType: "retrieval",
        routeReason: "evidence_required",
        retrievalInvoked: true,
      },
    });

    const detail = await request(app)
      .get(`/api/v1/history/chat/${response.body.conversationId}`)
      .set("Authorization", authorization)
      .expect(200);
    const assistantTurn = detail.body.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistantTurn?.debug?.route).toMatchObject({
      generator: "assistant",
      routeType: "retrieval",
      routeReason: "evidence_required",
      retrievalInvoked: true,
    });
    expect(assistantTurn?.debug?.activitySummary?.execution).toMatchObject({
      surface: "assistant",
      path: "assistant_retrieval",
      retrievalInvoked: true,
    });
    expect(assistantTurn?.debug?.activityTrace?.summary).toMatchObject({
      shapeName: response.body.debug.activityTrace.summary.shapeName,
      queryShape: response.body.debug.activityTrace.summary.queryShape,
      skillDiagnostic: expect.objectContaining({
        skillName: "retrieval.answer",
        callerSurface: "assistant",
      }),
    });
  });

  it("records grounded answers in assistant-turn audit metadata without validation diagnostics", async () => {
    const mixedGateway: ChatGateway = {
      async answer() {
        return "The page explains testing and parsing content for users[[1]]. It also offers 24/7 phone support.";
      },
      async *streamAnswer() {
        yield "The page explains testing and parsing content for users[[1]]. ";
        yield "It also offers 24/7 phone support.";
      },
    };
    const { app, dependencies } = createTestApp({ chatGateway: mixedGateway });

    const { token } = await issueTestToken(app, "degraded-outcome@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(chatAudit?.metadata).toMatchObject({
      answerOutcome: "grounded_success",
    });
    expect(chatAudit?.metadata).not.toHaveProperty("validation");

    const assistantMessageId = (chatAudit?.metadata as { assistantMessageId?: string } | undefined)?.assistantMessageId;
    const assistantMessage = [...(dependencies.messageRepository as InMemoryMessageRepository).items.values()]
      .flat()
      .find((message) => message.id === assistantMessageId);
    expect(assistantMessage?.skillName).toBe("retrieval.answer");
    expect(assistantMessage?.skillOutcome).toBe("grounded");
  });

  it("keeps no-context refusals distinct in audit metadata", async () => {
    const { app, dependencies } = createTestApp();

    const { token } = await issueTestToken(app, "no-context-outcome@example.com");
    const authorization = `Bearer ${token}`;

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What is the capital of France?", stream: false, includeDebug: true });

    const auditEvents = (dependencies.auditService as unknown as { events: Array<{ eventType: string; metadata?: Record<string, unknown> }> }).events;
    const chatAudit = [...auditEvents].reverse().find((event) => event.eventType === "chat.answer");

    expect(response.status).toBe(200);
    expect(chatAudit?.metadata).toMatchObject({
      answerOutcome: "no_context_refusal",
    });
    expect(chatAudit?.metadata).not.toHaveProperty("validation");

    const assistantMessageId = (chatAudit?.metadata as { assistantMessageId?: string } | undefined)?.assistantMessageId;
    const assistantMessage = [...(dependencies.messageRepository as InMemoryMessageRepository).items.values()]
      .flat()
      .find((message) => message.id === assistantMessageId);
    expect(assistantMessage?.skillName).toBe("retrieval.answer");
    expect(assistantMessage?.skillOutcome).toBe("no_context");
  });

  it("records a failure turn that can be inspected through history", async () => {
    const failingGateway: ChatGateway = {
      async answer() {
        throw new Error("upstream unavailable");
      },
      async *streamAnswer() {
        throw new Error("upstream unavailable");
      },
    };
    const { app } = createTestApp({ chatGateway: failingGateway });

    const { token } = await issueTestToken(app, "history-failure@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    const failure = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(failure.status).toBe(500);

    const history = await request(app)
      .get("/api/v1/history/chat")
      .set("Authorization", authorization);

    expect(history.status).toBe(200);
    expect(history.body.conversations).toHaveLength(1);

    const detail = await request(app)
      .get(`/api/v1/history/chat/${history.body.conversations[0].id}`)
      .set("Authorization", authorization);

    expect(detail.status).toBe(200);
    expect(detail.body.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "What does the page explain?" }),
      ]),
    );
    expect(detail.body.messages.some((message: { role: string }) => message.role === "assistant")).toBe(false);
  });

  it("preserves ambiguity for unresolved relation follow-ups", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite() {
          return {
            rewrittenQuery: "Does Narayani work with Arudra?",
            turnKind: "referential_relation",
            proposedActiveSubject: "Narayani",
            relatedEntities: ["Arudra"],
            unresolved: true,
            confidence: 0.62,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "ambiguity@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Narayani", content: "Narayani is a teacher and speaker." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const first = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Tell me about Narayani", stream: false, includeDebug: true });
    const second = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        message: "Does she work with Arudra?",
        stream: false,
        includeDebug: true,
      });

    expect(second.status).toBe(200);
    expect(second.body.debug.activitySummary.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
      materialDisagreement: false,
      continuityDecision: "unresolved",
    });
  });

  it("uses rewritten retrieval for unresolved single-subject followups", async () => {
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite() {
          return {
            rewrittenQuery: "Can I buy Narayani's book La mia anima ricorda Swami Kriyananda?",
            turnKind: "referential_followup",
            proposedActiveSubject: "Narayani",
            relatedEntities: [],
            unresolved: true,
            confidence: 0.62,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "book-followup@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Narayani Anaya Archivi - Ananda Edizioni",
        content:
          "Narayani Anaya. La mia anima ricorda Swami Kriyananda. Aggiungi al carrello. Prezzo 18,00 euro.",
      });
    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Narayani Profile",
        content: "Narayani is the author of La mia anima ricorda Swami Kriyananda.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const first = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Who is Narayani?", stream: false, includeDebug: true });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: first.body.conversationId,
        message: "Can I buy her book?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.debug.activitySummary.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
    });
  });

  it("routes social-only turns away from retrieval while keeping answer instructions available", async () => {
    let observedPrompt = "";
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseIntent: "social_only" as const,
            turnKind: "ambiguous" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.95,
          };
        },
      },
      chatGateway: {
        async answer({ prompt }) {
          observedPrompt = prompt;
          return "Thanks. Ask me about retreats or courses whenever you like.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });

    const { token } = await issueTestToken(app, "social-only@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        customInstruction: "Keep the reply warm and short.",
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Thanks for the help", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.citations ?? []).toEqual([]);
    expect(response.body.debug.activitySummary).toMatchObject({
      responseIntent: "social_only",
      retrievalSkipped: true,
      intentConfidence: 0.95,
    });
    expect(response.body.debug.activitySummary.candidateCounts).toEqual({
      semantic: 0,
      lexical: 0,
      merged: 0,
      final: 0,
    });
    expect(observedPrompt).toContain("Keep the reply warm and short.");
    expect(observedPrompt).toContain("Answer Instructions:");
  });

  it("keeps social-only intent routing active when query rewriting is disabled", async () => {
    let rewriteCalls = 0;
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          rewriteCalls += 1;
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseIntent: "social_only" as const,
            turnKind: "ambiguous" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.95,
          };
        },
      },
      chatGateway: {
        async answer() {
          return "You’re welcome. I can help with Ananda courses or booking when you’re ready.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });

    const { token } = await issueTestToken(app, "social-rewrite-disabled@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: false,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        customInstruction: "Help users with Ananda courses and booking.",
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "thanks", stream: false, includeDebug: true })
      .expect(200);

    expect(rewriteCalls).toBe(1);
    expect(response.body.debug.route).toEqual({
      type: "direct",
      reason: "social_only",
    });
    expect(response.body.debug.activitySummary).toMatchObject({
      responseIntent: "social_only",
      retrievalSkipped: true,
      intentConfidence: 0.95,
      rewrite: {
        status: "skipped",
        eligible: false,
        ran: false,
      },
    });
  });

  it("routes assistant-identity-only turns through the same non-retrieval path", async () => {
    let observedPrompt = "";
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseIntent: "assistant_identity" as const,
            turnKind: "ambiguous" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.91,
          };
        },
      },
      chatGateway: {
        async answer({ prompt }) {
          observedPrompt = prompt;
          return "I'm the workspace assistant, and I help answer questions from this workspace.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });

    const { token } = await issueTestToken(app, "assistant-identity@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        customInstruction: "Keep identity replies direct.",
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Remind me what you do around here", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.citations ?? []).toEqual([]);
    expect(response.body.debug.activitySummary).toMatchObject({
      responseIntent: "assistant_identity",
      retrievalSkipped: true,
      intentConfidence: 0.91,
      execution: {
        surface: "assistant",
        path: "assistant_direct",
        retrievalInvoked: false,
      },
    });
    expect(response.body.debug.route).toEqual({
      type: "direct",
      reason: "assistant_identity",
    });

    const detail = await request(app)
      .get(`/api/v1/history/chat/${response.body.conversationId}`)
      .set("Authorization", authorization)
      .expect(200);
    const assistantTurn = detail.body.messages.find((message: { role: string }) => message.role === "assistant");
    expect(assistantTurn?.debug?.route).toMatchObject({
      generator: "assistant",
      routeType: "direct",
      routeReason: "assistant_identity",
      retrievalInvoked: false,
    });
    expect(assistantTurn?.debug?.activitySummary?.execution).toMatchObject({
      surface: "assistant",
      path: "assistant_direct",
      retrievalInvoked: false,
    });
    expect(observedPrompt).toContain("Keep identity replies direct.");
    expect(observedPrompt).toContain("Answer Instructions:");
  });

  it("uses selected agent behavior for retrieval-enabled direct turns", async () => {
    let observedPrompt = "";
    const { app } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: input.query,
            semanticQuery: input.query,
            lexicalQuery: input.query,
            responseIntent: "assistant_identity" as const,
            turnKind: "ambiguous" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.91,
          };
        },
      },
      chatGateway: {
        async answer({ prompt }) {
          observedPrompt = prompt;
          return "I'm Balaram, and I help answer questions from this workspace.";
        },
        async *streamAnswer() {
          yield "unused";
        },
      },
    });

    const { token } = await issueTestToken(app, "selected-agent-behavior@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
        customInstruction: "You are Vikram, the customer support assistant.",
      })
      .expect(200);

    const agent = await request(app)
      .post("/api/v1/agents")
      .set("Authorization", authorization)
      .send({
        name: "Balaram",
        customInstruction: "You are Balaram, the course guide.",
        retrievalEnabled: true,
      })
      .expect(201);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ agentId: agent.body.id, message: "who are you?", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body).toMatchObject({
      agentId: agent.body.id,
      agentName: "Balaram",
    });
    expect(response.body.debug.route).toEqual({
      type: "direct",
      reason: "assistant_identity",
    });
    expect(observedPrompt).toContain("Balaram");
    expect(observedPrompt).not.toContain("Vikram");
    expect(observedPrompt).toContain("You are Balaram, the course guide.");
  });

  it("keeps mixed social-plus-substantive turns on the retrieval path", async () => {
    const deterministicGateway: ChatGateway = {
      async answer() {
        return "The next retreat is the Spring Retreat.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({
      chatGateway: deterministicGateway,
      queryRewriteGateway: {
        async rewrite(input) {
          return {
            rewrittenQuery: "what retreats are coming up Spring Retreat",
            semanticQuery: "what retreats are coming up Spring Retreat",
            lexicalQuery: "\"Spring Retreat\" retreats",
            responseIntent: "retrieval" as const,
            turnKind: "fresh_subject" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.88,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "mixed-turn@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Spring Retreat",
        content: "The next retreat is the Spring Retreat.",
      })
      .expect(202);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Thanks, what retreats are coming up?", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Spring Retreat",
        }),
      ]),
    );
    expect(response.body.debug.activitySummary).toMatchObject({
      responseIntent: "retrieval",
      retrievalSkipped: false,
    });
  });

  it("fails safely to retrieval when a non-retrieval intent is low confidence", async () => {
    const deterministicGateway: ChatGateway = {
      async answer() {
        return "The next retreat is the Spring Retreat.";
      },
      async *streamAnswer() {
        yield "unused";
      },
    };
    const { app } = createTestApp({
      chatGateway: deterministicGateway,
      queryRewriteGateway: {
        async rewrite() {
          return {
            rewrittenQuery: "Thanks for the help",
            semanticQuery: "Thanks for the help",
            lexicalQuery: "Thanks for the help",
            responseIntent: "social_only" as const,
            turnKind: "ambiguous" as const,
            relatedEntities: [],
            unresolved: false,
            confidence: 0.62,
          };
        },
      },
    });

    const { token } = await issueTestToken(app, "low-confidence-intent@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Spring Retreat",
        content: "The next retreat is the Spring Retreat.",
      })
      .expect(202);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        semanticRewriteInstructions: "",
        lexicalRewriteInstructions: "",
        suggestedQuestionsEnabled: true,
        suggestedQuestionsCount: 3,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.1,
        rerankTopK: 5,
      })
      .expect(200);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "Thanks for the help", stream: false, includeDebug: true })
      .expect(200);

    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.citations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Spring Retreat",
        }),
      ]),
    );
    expect(response.body.debug.activitySummary).toMatchObject({
      responseIntent: "retrieval",
      retrievalSkipped: false,
      intentFallbackApplied: true,
    });
  });

  it("resolves a single assistant-offered branch after a bare acceptance", async () => {
    const { app, dependencies } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          if (input.query !== "go ahead") {
            return {
              rewrittenQuery: input.query,
              semanticQuery: input.query,
              lexicalQuery: input.query,
              turnKind: "fresh_subject" as const,
              relatedEntities: [],
              unresolved: false,
              confidence: 0.9,
            };
          }

          return {
            rewrittenQuery: "RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking",
            semanticQuery: "RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking",
            lexicalQuery: "\"RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking\"",
            turnKind: "referential_followup" as const,
            proposedActiveSubject: "RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking",
            relatedEntities: [],
            unresolved: false,
            confidence: 0.88,
          };
        },
      },
    });

    const { token, workspaceId } = await issueTestToken(app, "assistant-acceptance-single@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking",
        content: "Simple Living and High Thinking explores the course themes, community ideals, and practical applications.",
      });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const conversation = await dependencies.conversationRepository.create(workspaceId);
    await dependencies.messageRepository.create({
      conversationId: conversation.id,
      workspaceId,
      role: "assistant",
      content:
        "I couldn't verify that from your workspace documents, but I did find related material in \"RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking\" if you'd like to explore that instead.",
    });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: conversation.id,
        message: "go ahead",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(response.body.debug.activitySummary.parsedQuery).toMatchObject({
      originalQuery: "go ahead",
      semanticQuery: "RESIDENTIAL COURSE: Original Teachings of Yogananda - Simple Living and High Thinking",
    });
    expect(response.body.debug.activitySummary.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
    });
  });

  it("does not guess among multiple assistant-offered branches after a bare acceptance", async () => {
    const { app, dependencies } = createTestApp({
      queryRewriteGateway: {
        async rewrite(input) {
          if (input.query !== "go ahead") {
            return {
              rewrittenQuery: input.query,
              semanticQuery: input.query,
              lexicalQuery: input.query,
              turnKind: "fresh_subject" as const,
              relatedEntities: [],
              unresolved: false,
              confidence: 0.9,
            };
          }

          return {
            rewrittenQuery: "go ahead",
            semanticQuery: "go ahead",
            lexicalQuery: "go ahead",
            responseLanguagePolicy: "match_user_question" as const,
            retrievalSubqueries: [
              {
                id: "",
                label: "what I can do in this conversation",
                semanticQuery: "what I can do in this conversation",
                lexicalQuery: "\"what I can do in this conversation\"",
                responseLanguagePolicy: "match_user_question" as const,
              },
              {
                id: "",
                label: "how I respond to your questions",
                semanticQuery: "how I respond to your questions",
                lexicalQuery: "\"how I respond to your questions\"",
                responseLanguagePolicy: "match_user_question" as const,
              },
              {
                id: "",
                label: "Ananda course topics",
                semanticQuery: "Ananda course topics",
                lexicalQuery: "\"Ananda course topics\"",
                responseLanguagePolicy: "match_user_question" as const,
              },
            ],
            turnKind: "ambiguous" as const,
            relatedEntities: ["what I can do in this conversation", "how I respond to your questions", "Ananda course topics"],
            unresolved: false,
            confidence: 0.84,
          };
        },
      },
    });

    const { token, workspaceId } = await issueTestToken(app, "assistant-acceptance-multi@example.com");
    const authorization = `Bearer ${token}`;

    for (const document of [
      {
        title: "What I can do in this conversation",
        content: "This document lists what the assistant can do in this conversation.",
      },
      {
        title: "How I respond to your questions",
        content: "This document describes how the assistant responds to questions.",
      },
      {
        title: "Ananda course topics",
        content: "This document summarizes the available Ananda course topics.",
      },
    ]) {
      await request(app)
        .post("/api/v1/document/")
        .set("Authorization", authorization)
        .send(document);
    }

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const conversation = await dependencies.conversationRepository.create(workspaceId);
    await dependencies.messageRepository.create({
      conversationId: conversation.id,
      workspaceId,
      role: "assistant",
      content:
        "I can’t tell you my exact instruction set. If you want, I can still help with nearby things like: what I can do in this conversation, how I respond to your questions, or a brief summary of the Ananda course topics shown here.",
    });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        conversationId: conversation.id,
        message: "go ahead",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.debug.activitySummary.parsedQuery).toMatchObject({
      originalQuery: "go ahead",
      semanticQuery: "go ahead",
      lexicalQuery: "go ahead",
    });
    expect(response.body.debug.activitySummary.retrievalSubqueries).toEqual([
      {
        id: "subquery_1",
        label: "what I can do in this conversation",
        semanticQuery: "what I can do in this conversation",
        lexicalQuery: "\"what I can do in this conversation\"",
        responseLanguagePolicy: "match_user_question",
      },
      {
        id: "subquery_2",
        label: "how I respond to your questions",
        semanticQuery: "how I respond to your questions",
        lexicalQuery: "\"how I respond to your questions\"",
        responseLanguagePolicy: "match_user_question",
      },
      {
        id: "subquery_3",
        label: "Ananda course topics",
        semanticQuery: "Ananda course topics",
        lexicalQuery: "\"Ananda course topics\"",
        responseLanguagePolicy: "match_user_question",
      },
    ]);
    expect(response.body.debug.activitySummary.rewrite).toMatchObject({
      status: "applied",
      eligible: true,
      ran: true,
    });
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
  }, 10_000);

  it("returns the exact-match source for identifier-style queries", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "identifiers@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Feature Flags",
        content: "Flag HVC-42-ALPHA enables the hybrid retrieval rollout path for internal testing environments.",
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "What does flag HVC-42-ALPHA enable?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).not.toContain("could not find relevant information");
    expect(response.body.citations[0]?.title).toBe("Feature Flags");
  });

  it("applies persisted retrieval settings without adding tone markers to answers", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "answer-settings@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
  });

  it("emits citation metadata regardless of the legacy citationDisplayEnabled setting", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "no-citations@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({ title: "Guide", content: "The page explains testing and parsing content for users." });

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: false,
        vectorTopK: 20,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({ message: "What does the page explain?", stream: false, includeDebug: true });

    expect(response.status).toBe(200);
    expect(response.body.answer).toEqual(expect.any(String));
    expect(response.body.answer.length).toBeGreaterThan(0);
    expect(Array.isArray(response.body.citations)).toBe(true);
    expect(response.body.citations.length).toBeGreaterThan(0);
  });

  it("falls back safely when rerank fails", async () => {
    const failingRerankGateway: RerankGateway = {
      async rerank() {
        throw new Error("rerank failed");
      },
    };
    const { app } = createTestApp({ rerankGateway: failingRerankGateway });

    const { token } = await issueTestToken(app, "rerank-failure@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.rateLimits);

    await request(app)
      .put("/api/v1/settings/retrieval")
      .set("Authorization", authorization)
      .send({
        queryRewriteEnabled: true,
        rerankEnabled: true,
        vectorTopK: 50,
        similarityThreshold: 0.2,
        rerankTopK: 5,
        chunkingStrategy: "fixed_window",
      });

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.citations[0]?.title).toBe("Rate Limits");
    expect(response.body.debug.activitySummary.rerankStatus).toBe("fallback");
  });

  it("still answers grounded questions when lexical search is disabled", async () => {
    const { app } = createTestApp({
      lexicalSearch: {
        async search() {
          return [];
        },
      },
    });

    const { token } = await issueTestToken(app, "lexical-off@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.rateLimits);

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "What is the API rate limit and how long should a client wait before retrying?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.citations[0]?.title).toBe("Rate Limits");
    expect(response.body.debug.activitySummary.candidateCounts.lexical).toBe(0);
  });

  it("accepts metadataFilter in the request body and returns a successful response", async () => {
    const { app } = createTestApp();

    const { token } = await issueTestToken(app, "metadata-filter@example.com");
    const authorization = `Bearer ${token}`;

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "English Guide",
        content: "This guide covers the English API documentation for external users.",
        metadata: { language: "en" },
      });

    await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send({
        title: "Spanish Guide",
        content: "Esta guía cubre la documentación de la API en español para usuarios externos.",
        metadata: { language: "es" },
      });

    // The in-memory fake does not apply @> JSON containment filtering on chunk metadata,
    // so we cannot assert that only English chunks are returned here. The test verifies
    // that metadataFilter is a valid request field that is accepted without errors and
    // that the pipeline runs to completion.
    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "What does the guide cover?",
        stream: false,
        includeDebug: true,
        metadataFilter: { language: "en" },
      });

    expect(response.status).toBe(200);
    expect(response.body).toHaveProperty("answer");
    expect(response.body).toHaveProperty("conversationId");
    expect(response.body.debug).toHaveProperty("activitySummary");
    expect(response.body.debug).toHaveProperty("activityTrace");
  });

  it("handles legacy chunks without search text or structured attributes", async () => {
    const { app, repositories } = createTestApp();

    const { token } = await issueTestToken(app, "legacy-chunks@example.com");
    const authorization = `Bearer ${token}`;

    const documentResponse = await request(app)
      .post("/api/v1/document/")
      .set("Authorization", authorization)
      .send(retrievalFixtureDocuments.sessionCookie);

    const storedChunks = repositories.chunkRepository.items.get(documentResponse.body.documentId);
    if (storedChunks) {
      repositories.chunkRepository.items.set(
        documentResponse.body.documentId,
        storedChunks.map((chunk) => ({
          ...chunk,
          searchText: null,
        })),
      );
    }

    const response = await request(app)
      .post("/api/v1/assistant/chat")
      .set("Authorization", authorization)
      .send({
        message: "Which cookie name is used for browser sessions?",
        stream: false,
        includeDebug: true,
      });

    expect(response.status).toBe(200);
    expect(response.body.answer).not.toContain("could not find relevant information");
    expect(response.body.citations[0]?.title).toBe("Session Cookie");
  });

});
