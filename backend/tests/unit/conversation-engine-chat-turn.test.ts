import { describe, expect, it } from "vitest";

import type { ConversationEngine } from "@radioso/conversation-contract";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import { runPreparedChatTurnWithConversationEngine } from "../../src/modules/chat/services/conversationEngineChatTurn.js";
import {
  GenericTurnOutcomeRenderer,
  TurnOutcomeRendererRegistry,
  type TurnOutcome,
} from "../../src/modules/chat/services/turnOutcome.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";

const conversation = (): ConversationRecord => ({
  id: "conv_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  agentName: "Support",
  sourceChannel: null,
  sourceOrigin: null,
  anonymousSessionId: null,
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
  customInstruction: "",
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
  assistantDefaultLocale: null,
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

const session = (): PreparedSession => ({
  agent: agent(),
  conversation: conversation(),
  history: [],
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
  userMessage: message(),
  directiveSteering: {
    rules: [],
    matches: [],
    omissions: [],
  },
});

describe("runPreparedChatTurnWithConversationEngine", () => {
  it("runs a prepared chat outcome through the pure engine and Radioso renderer registry", async () => {
    const engine: ConversationEngine = {
      async processTurn(input) {
        const history = await input.stores.loadHistory({ sessionId: input.sessionId });
        const turn = {
          agent: input.agent,
          sessionId: input.sessionId,
          inputEvent: input.inputEvent,
          history,
          stagedContext: [],
          steering: [],
        };
        const decision = await input.selector.select({
          turn,
          skills: input.skills,
          directives: [],
        });
        const skill = input.skills.find((candidate) => candidate.name === decision.selected[0]?.skillName);
        if (!skill || !decision.selected[0]) {
          throw new Error("test skill selection failed");
        }
        const outcome = await input.dispatcher.dispatch({
          skill,
          turn,
          selected: decision.selected[0],
        });
        const response = await input.composer.compose({
          turn,
          outcomes: [outcome],
          decision,
        });
        return {
          sessionId: input.sessionId,
          events: [],
          decision,
          outcomes: [outcome],
          response,
          trace: {
            traceId: "test-engine",
            startedAt: "2026-01-01T00:00:00.000Z",
            stages: [],
          },
        };
      },
    };
    const turnOutcome: TurnOutcome = {
      kind: "generic",
      skillName: "order.status",
      outcome: {
        status: "completed",
        answer: "Your order ships tomorrow.",
      },
      stagedContext: [],
      steering: [],
      trace: {
        traceId: "trace_1",
        startedAt: "2026-01-01T00:00:00.000Z",
        stages: [],
      },
    };

    const presentation = await runPreparedChatTurnWithConversationEngine({
      engine,
      session: session(),
      turnOutcome,
      turnRenderers: new TurnOutcomeRendererRegistry([new GenericTurnOutcomeRenderer()]),
      query: "Where is my order?",
    });

    expect(presentation).toMatchObject({
      answer: "Your order ships tomorrow.",
      skillName: "order.status",
      skillOutcome: "completed",
      skillStatus: "completed",
    });
  });
});
