import { describe, expect, it } from "vitest";

import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import {
  toConversationAgentConfig,
  toConversationInputEvent,
  toConversationMessage,
  toConversationTrace,
  toPreparedStagedContext,
} from "../../src/modules/chat/services/conversationContractMappers.js";
import type { ActivityTrace, RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: "msg_1",
  conversationId: "conv_1",
  workspaceId: "workspace_1",
  role: "user",
  content: "Hello",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const agent = (overrides: Partial<AgentRecord> = {}): AgentRecord => ({
  id: "agent_1",
  workspaceId: "workspace_1",
  name: "Support",
  customInstruction: "Answer in a practical tone.",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  contactRequestDelivery: { recipientEmails: [], webhook: null },
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
  skillSettings: {},
  logo: null,
  theme: {
    brand: "#000000",
    brandText: "#ffffff",
    surface: "#ffffff",
    text: "#000000",
  },
  branding: {
    hidePoweredBy: false,
    privacyPolicyUrl: null,
  },
  greetingInstruction: "",
  assistantDefaultLocale: "en",
  proactiveGreetingEnabled: false,
  chatModelOverride: { provider: "openai", model: "gpt-test" },
  surfaceSettings: {
    authenticatedChat: { enabled: true },
    anonymousChat: { enabled: false, token: null },
    websiteEmbed: {
      enabled: false,
      token: null,
      allowedOrigins: [],
      launcherLabel: "Chat",
      launcherPosition: "bottom-right",
      theme: {
        brand: "#000000",
        brandText: "#ffffff",
        surface: "#ffffff",
        text: "#000000",
      },
      copy: {},
      expertOverrides: {},
    },
    extensions: {},
  },
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

describe("conversation contract mappers", () => {
  it("maps persisted messages into conversation contract messages", () => {
    expect(toConversationMessage(message({ metadata: { source: "test" } }))).toEqual({
      id: "msg_1",
      role: "user",
      content: "Hello",
      createdAt: "2026-01-01T00:00:00.000Z",
      metadata: { source: "test" },
    });
  });

  it("maps the user message into a contract input event", () => {
    expect(toConversationInputEvent(message({
      inputMetadata: { method: "intent_click", intent: { skillName: "order.status" } },
    }))).toEqual({
      id: "msg_1",
      kind: "message",
      content: "Hello",
      metadata: {
        method: "intent_click",
        intent: { skillName: "order.status" },
      },
    });
  });

  it("adapts the Radioso agent record into product-independent agent config", () => {
    expect(toConversationAgentConfig(agent())).toEqual({
      id: "agent_1",
      name: "Support",
      instructions: ["Answer in a practical tone."],
      defaultLocale: "en",
      model: { provider: "openai", model: "gpt-test" },
      metadata: {
        workspaceId: "workspace_1",
        retrievalEnabled: true,
        contactRequestsEnabled: false,
      },
    });
  });

  it("maps retrieval activity traces into conversation traces", () => {
    const trace: ActivityTrace = {
      traceId: "trace_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      totalDurationMs: 1000,
      stages: [{
        stageId: "rewrite",
        kind: "rewrite",
        label: "Rewrite",
        status: "unavailable",
        startedAt: "2026-01-01T00:00:00.000Z",
        inputs: { query: "Hello" },
        outputs: { skipped: true },
        metrics: { latencyMs: 3 },
      }],
      links: [{
        fromStageId: "rewrite",
        toStageId: "answer",
        kind: "sequence",
      }],
      summary: {
        status: "success",
      },
    };

    expect(toConversationTrace(trace)).toEqual({
      traceId: "trace_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:01.000Z",
      stages: [{
        id: "rewrite",
        kind: "rewrite",
        status: "unavailable",
        startedAt: "2026-01-01T00:00:00.000Z",
        inputs: { query: "Hello" },
        outputs: { skipped: true },
        metrics: { latencyMs: 3 },
      }],
      links: [{
        from: "rewrite",
        to: "answer",
        kind: "sequence",
      }],
      summary: {
        status: "success",
      },
    });
  });

  it("maps missing legacy retrieval traces into an explicit unavailable trace", () => {
    const trace = toConversationTrace(undefined);

    expect(trace).toMatchObject({
      traceId: "unavailable-trace",
      stages: [],
      links: [],
    });
    expect(trace.startedAt).toEqual(expect.any(String));
  });

  it("wraps the prepared result as staged context sourced from the owning skill", () => {
    const retrieval = {
      contexts: [{ chunkId: "chunk_1" }],
      diagnostics: { retrievalSkipped: false },
    } as RetrievalPipelineResult;

    expect(toPreparedStagedContext(retrieval, "retrieval.answer")).toEqual({
      kind: "retrieval",
      source: "retrieval.answer",
      data: retrieval,
      metadata: {
        contextCount: 1,
        retrievalSkipped: false,
      },
    });
  });

  it("sources the staged context from a non-retrieval skill — never retrieval.answer", () => {
    const skipped = {
      contexts: [],
      diagnostics: { retrievalSkipped: true },
    } as unknown as RetrievalPipelineResult;

    expect(toPreparedStagedContext(skipped, "direct.answer").source).toBe("direct.answer");
    expect(toPreparedStagedContext(skipped, "direct.answer").source).toBe(
      "direct.answer",
    );
  });
});
