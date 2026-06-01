import { describe, expect, it, vi } from "vitest";

import type {
  ConversationEvent,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
} from "@radioso/conversation-contract";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import { createChatProcessTurnInput } from "../../src/modules/chat/services/conversationProcessTurnInput.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

const conversation = (): ConversationRecord => ({
  id: "conv_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  agentName: "Support",
  sourceChannel: null,
  anonymousSessionId: null,
  sourceOrigin: null,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z"),
});

const message = (overrides: Partial<MessageRecord> = {}): MessageRecord => ({
  id: "msg_1",
  conversationId: "conv_1",
  workspaceId: "workspace_1",
  role: "user",
  content: "Where is my order?",
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  ...overrides,
});

const agent = (): AgentRecord => ({
  id: "agent_1",
  workspaceId: "workspace_1",
  name: "Support",
  customInstruction: "Be specific.",
  suggestedQuestionsEnabled: true,
  assistantLinkUtmEnabled: true,
  retrievalEnabled: true,
  sourceScope: { mode: "all" },
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
  chatModelOverride: null,
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
});

const preparedSession = (): PreparedSession => ({
  agent: agent(),
  conversation: conversation(),
  history: [message({ id: "history_1", content: "Earlier question" })],
  retrieval: {
    contexts: [],
    diagnostics: {},
    trace: {
      traceId: "trace_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [],
      links: [],
    },
  } as unknown as RetrievalPipelineResult,
  turnRoute: "social_only",
  userMessage: message({
    inputMetadata: { method: "intent_click", intent: { skillName: "order.status" } },
  }),
  directiveSteering: {
    rules: [],
    matches: [{
      directive: {
        name: "brief",
        condition: { kind: "always" },
        action: "Keep it brief.",
      },
      selectionMode: "deterministic",
      selectionReason: "always",
    }],
    omissions: [],
  },
  stagedContext: [],
  turnTrace: { traceId: "trace_1", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
});

const dispatcher: ConversationSkillDispatcher = {
  dispatch: vi.fn(),
};

const selector: ConversationSkillSelector = {
  select: vi.fn(),
};

const composer: ConversationTurnComposer = {
  compose: vi.fn(),
};

describe("createChatProcessTurnInput", () => {
  it("projects a prepared chat session into reusable conversation engine input", async () => {
    const appended: ConversationEvent[] = [];
    const input = createChatProcessTurnInput({
      session: preparedSession(),
      skills: [{ name: "order.status" }],
      dispatcher,
      selector,
      composer,
      appendEvent: async (event) => {
        appended.push(event);
      },
    });

    expect(input.agent).toMatchObject({
      id: "agent_1",
      name: "Support",
      instructions: ["Be specific."],
      metadata: { workspaceId: "workspace_1", retrievalEnabled: true },
    });
    expect(input.sessionId).toBe("conv_1");
    expect(input.inputEvent).toEqual({
      id: "msg_1",
      kind: "message",
      content: "Where is my order?",
      metadata: {
        method: "intent_click",
        intent: { skillName: "order.status" },
      },
    });
    await expect(input.stores.loadHistory({ sessionId: "conv_1" })).resolves.toEqual([
      expect.objectContaining({
        id: "history_1",
        role: "user",
        content: "Earlier question",
      }),
    ]);
    await expect(input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: [],
    })).resolves.toEqual([
      expect.objectContaining({
        directive: expect.objectContaining({ name: "brief" }),
        selectionReason: "always",
      }),
    ]);
    await input.stores.appendEvent({
      sessionId: "conv_1",
      kind: "assistant.response",
      content: "Done",
    });
    expect(appended).toEqual([
      expect.objectContaining({ kind: "assistant.response", content: "Done" }),
    ]);
  });

  it("fails closed when a caller tries to use the placeholder model gateway", async () => {
    const input = createChatProcessTurnInput({
      session: preparedSession(),
      dispatcher,
      selector,
      composer,
    });

    await expect(input.modelGateway.complete({ messages: [] })).rejects.toThrow(
      "conversation_model_gateway_not_configured",
    );
  });
});
