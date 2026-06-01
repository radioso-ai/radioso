import { describe, expect, it } from "vitest";

import type { ConversationEngine } from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  type RunPreparedChatTurnStreamWithConversationEngineEvent,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "../../src/modules/chat/services/conversationEngineChatTurn.js";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import {
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
  buildRetrievalTurnOutcome,
} from "../../src/modules/chat/services/retrievalTurnSkill.js";
import { DefaultTurnSelectionStrategy } from "../../src/modules/chat/services/turnSelectionStrategy.js";
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";
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

// A fake engine that drives the adapter's ports the way the real engine does:
// select, dispatch the selected skill, then compose. Records what was dispatched.
const drivingEngine = (): { engine: ConversationEngine; dispatched: string[]; selectorCalls: number[] } => {
  const dispatched: string[] = [];
  const selectorCalls: number[] = [];
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
      const decision = await input.selector.select({ turn, skills: input.skills, directives: [] });
      selectorCalls.push(decision.selected.length);
      const selected = decision.selected[0];
      const skill = input.skills.find((candidate) => candidate.name === selected?.skillName);
      if (!skill || !selected) {
        throw new Error("test skill selection failed");
      }
      const outcome = await input.dispatcher.dispatch({ skill, turn, selected });
      dispatched.push(outcome.skillName);
      const response = await input.composer.compose({ turn, outcomes: [outcome], decision });
      return {
        sessionId: input.sessionId,
        events: [],
        decision,
        outcomes: [outcome],
        response,
        trace: { traceId: "test-engine", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      };
    },
    async *processTurnStream(input) {
      const result = await this.processTurn(input);
      yield { type: "final", result };
    },
  };
  return { engine, dispatched, selectorCalls };
};

describe("runPreparedChatTurnWithConversationEngine", () => {
  it("lets the engine select and dispatch the registered retrieval skill, then renders it", async () => {
    // The retrieval skill is injected as skill-shaped input — the adapter names no
    // skill itself. The renderer stands in for the host's grounded composition.
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (outcome) => ({
          answer: "Grounded answer.",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };

    const { engine, dispatched, selectorCalls } = drivingEngine();
    const turnSkills = [retrievalSkill];
    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine,
      session: session(),
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Where is my order?",
    });

    expect(selectorCalls).toEqual([1]);
    expect(dispatched).toEqual([RETRIEVAL_TURN_SKILL]);
    expect(presentation).toMatchObject({
      answer: "Grounded answer.",
      skillName: RETRIEVAL_TURN_SKILL,
      skillOutcome: "completed",
      skillStatus: "completed",
    });
    // The adapter surfaces the engine's turn result so the host can persist its trace.
    expect(result.outcomes[0]?.skillName).toBe(RETRIEVAL_TURN_SKILL);
  });

  it("dispatches and renders whatever terminal skill is registered (no retrieval coupling)", async () => {
    // A non-retrieval skill proves the adapter is skill-agnostic: it dispatches and
    // renders purely from the injected skill, with no `retrieval` knowledge.
    const bookingSkill: TurnSkill = {
      definition: { name: "booking.create", outcomeKinds: ["booking"] },
      selects: () => true,
      dispatch: () => ({
        kind: "booking",
        skillName: "booking.create",
        outcome: { status: "completed", answer: "Booked." },
        stagedContext: [],
        steering: [],
        trace: { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "booking",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
    };

    const { engine, dispatched } = drivingEngine();
    const turnSkills = [bookingSkill];
    const { presentation } = await runPreparedChatTurnWithConversationEngine({
      engine,
      session: session(),
      turnSkillSelector: new ChatTurnSkillSelector(turnSkills, new DefaultTurnSelectionStrategy()),
      turnSkills,
      query: "Book me a slot",
    });

    expect(dispatched).toEqual(["booking.create"]);
    expect(presentation).toMatchObject({ answer: "Booked.", skillName: "booking.create" });
  });

  it("lets the engine drive streamed turn selection and emits any final unstreamed remainder", async () => {
    const streamingSkill: TurnSkill = {
      definition: { name: "booking.create", outcomeKinds: ["booking"] },
      selects: () => true,
      dispatch: () => ({
        kind: "booking",
        skillName: "booking.create",
        outcome: { status: "completed", answer: "Hello world." },
        stagedContext: [],
        steering: [],
        trace: { traceId: "t", startedAt: "2026-01-01T00:00:00.000Z", stages: [] },
      }),
      renderer: {
        supports: (outcome) => outcome.kind === "booking",
        render: async (outcome) => ({
          answer: outcome.outcome.answer ?? "",
          skillName: outcome.skillName,
          skillOutcome: outcome.outcome.status,
          skillStatus: outcome.outcome.status,
        }),
      },
      async *streamRender() {
        yield "Hello";
        return {
          finalPresentation: {
            answer: "Hello world.",
            skillName: "booking.create",
            skillOutcome: "completed",
            skillStatus: "completed",
          },
          suggestions: { mode: "presentation" },
          hasStreamedAnswer: true,
          streamedAnswer: "Hello",
        };
      },
    };
    const engine = new DefaultConversationEngine();
    const events: RunPreparedChatTurnStreamWithConversationEngineEvent[] = [];

    for await (const event of runPreparedChatTurnStreamWithConversationEngine({
      engine,
      session: session(),
      turnSkillSelector: new ChatTurnSkillSelector([streamingSkill], new DefaultTurnSelectionStrategy()),
      turnSkills: [streamingSkill],
      query: "Book me a slot",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "chunk", text: "Hello" },
      { type: "chunk", text: " world." },
      {
        type: "final",
        presentation: expect.objectContaining({ answer: "Hello world.", skillName: "booking.create" }),
        suggestions: { mode: "presentation" },
        result: expect.objectContaining({
          response: expect.objectContaining({ answer: "Hello world." }),
        }),
        engineTrace: expect.objectContaining({
          stages: expect.arrayContaining([
            expect.objectContaining({ kind: "skill_selection" }),
            expect.objectContaining({ kind: "skill_dispatch" }),
            expect.objectContaining({ kind: "compose" }),
          ]),
        }),
      },
    ]);
  });
});
