import { describe, expect, it } from "vitest";

import type { ConversationEngine } from "@radioso/conversation-contract";
import { DefaultConversationEngine } from "@radioso/conversation-engine";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  attemptRoutineTurnWithConversationEngine,
  type RunPreparedChatTurnStreamWithConversationEngineEvent,
  runPreparedChatTurnStreamWithConversationEngine,
  runPreparedChatTurnWithConversationEngine,
} from "../../src/modules/chat/services/conversationEngineChatTurn.js";
import type { ChatPresentedAnswer } from "../../src/modules/chat/services/chatAnswerPresenter.js";
import type { ProcessTurnResult } from "@radioso/conversation-contract";
import type { TurnSkill } from "../../src/modules/chat/services/turnOutcome.js";
import {
  RETRIEVAL_OUTCOME_KIND,
  RETRIEVAL_TURN_SKILL,
  buildRetrievalTurnOutcome,
} from "../../src/modules/chat/services/retrievalTurnSkill.js";
import {
  DefaultTurnSelectionStrategy,
  type TurnSelectionStrategy,
} from "../../src/modules/chat/services/turnSelectionStrategy.js";
import {
  toConversationTrace,
  toPreparedStagedContext,
} from "../../src/modules/chat/services/conversationContractMappers.js";
import { ChatTurnSkillSelector } from "../../src/modules/chat/services/turnSkillSelector.js";
import type { RouteScopedDirectiveRuntime } from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import type {
  Directive,
  DirectiveSteerInput,
  DirectiveSteeringResult,
} from "../../src/modules/directives/public.js";
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
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
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

const retrievalResult = (): RetrievalPipelineResult =>
  ({
    contexts: [],
    diagnostics: {},
    trace: {
      traceId: "trace_1",
      startedAt: "2026-01-01T00:00:00.000Z",
      stages: [],
      links: [],
    },
  } as unknown as RetrievalPipelineResult);

const session = (): PreparedSession => {
  const retrieval = retrievalResult();
  return {
    agent: agent(),
    conversation: conversation(),
    history: [],
    retrieval,
    turnRoute: "social_only",
    userMessage: message(),
    directiveSteering: {
      rules: [],
      matches: [],
      omissions: [],
    },
    stagedContext: [toPreparedStagedContext(retrieval)],
    turnTrace: toConversationTrace(retrieval.trace),
  };
};

describe("attemptRoutineTurnWithConversationEngine", () => {
  const routinePorts = {
    routineStore: { loadActive: async () => null, save: async () => {}, clear: async () => {} },
    routineRunner: { resume: async () => ({ response: { answer: "" }, nextState: null }) },
    routineActivator: { activate: async () => null },
    presentRoutineReply: (response: { answer: string }): ChatPresentedAnswer =>
      ({ answer: response.answer, skillName: "routine", skillOutcome: "routine", skillStatus: "completed" }) as ChatPresentedAnswer,
  };
  const engineWith = (result: ProcessTurnResult | null): ConversationEngine =>
    ({
      attemptRoutine: async () => result,
      processTurn: async () => {
        throw new Error("processTurn should not run when attempting a routine");
      },
      // eslint-disable-next-line require-yield
      processTurnStream: async function* () {
        throw new Error("processTurnStream should not run when attempting a routine");
      },
    }) as ConversationEngine;

  it("presents the routine reply when the engine claims the turn", async () => {
    const result = {
      sessionId: "conv_1",
      events: [],
      decision: { selected: [], reason: "routine_activated:contact.request" },
      outcomes: [],
      response: { answer: "What is your email?" },
      trace: { traceId: "t", startedAt: "x", stages: [] },
      actions: [{ type: "contact.send", payload: { email: "a@b.c" } }],
    } as unknown as ProcessTurnResult;
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: engineWith(result),
      session: session(),
      ...routinePorts,
    });
    expect(outcome?.presentation.answer).toBe("What is your email?");
    expect(outcome?.result.actions).toEqual([{ type: "contact.send", payload: { email: "a@b.c" } }]);
  });

  it("returns null when no routine claims the turn (so the host falls through to grounding)", async () => {
    const outcome = await attemptRoutineTurnWithConversationEngine({
      engine: engineWith(null),
      session: session(),
      ...routinePorts,
    });
    expect(outcome).toBeNull();
  });
});

// A fake engine that drives the adapter's ports the way the real engine does:
// select, dispatch the selected skill, then compose. Records what was dispatched.
const drivingEngine = (): { engine: ConversationEngine; dispatched: string[]; selectorCalls: number[] } => {
  const dispatched: string[] = [];
  const selectorCalls: number[] = [];
  const engine: ConversationEngine = {
    async attemptRoutine() {
      return null;
    },
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
    // A1 parity on the engine path: the dispatched outcome carries the prepared
    // neutral spine — the turn trace derived from the retrieval result, and the
    // staged context stamped with the dispatching skill name.
    expect(result.outcomes[0]?.trace.traceId).toBe("trace_1");
    expect(result.outcomes[0]?.stagedContext[0]).toMatchObject({
      kind: "retrieval",
      source: RETRIEVAL_TURN_SKILL,
    });
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

  it("runs directive matching and terminal skill selection inside the engine loop", async () => {
    const directive: Directive = {
      name: "brief",
      condition: { kind: "always" },
      action: "Keep it brief.",
      priority: 10,
    };
    const matched: Array<{ turnContext: Record<string, unknown>; directives: string[] }> = [];
    const directiveRuntime: RouteScopedDirectiveRuntime = {
      directivesFor() {
        return [directive];
      },
      matcher: {
        async match(input) {
          matched.push({
            turnContext: input.turnContext,
            directives: input.directives.map((candidate) => candidate.name),
          });
          return [{
            directive,
            selectionMode: "deterministic",
            selectionReason: "Directive condition is unconditional (always).",
          }];
        },
      },
      async resolveMatches(_input: DirectiveSteerInput, matches): Promise<DirectiveSteeringResult> {
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            priority: match.directive.priority,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    };
    const selectedDirectiveSets: string[][] = [];
    const strategy: TurnSelectionStrategy = {
      select(input) {
        selectedDirectiveSets.push(input.directives.map((match) => match.directive.name));
        return ["retrieval"];
      },
    };
    const retrievalSkill: TurnSkill = {
      definition: { name: RETRIEVAL_TURN_SKILL, outcomeKinds: [RETRIEVAL_OUTCOME_KIND] },
      selects: () => true,
      dispatch: (s) => buildRetrievalTurnOutcome(s),
      renderer: {
        supports: (outcome) => outcome.kind === RETRIEVAL_OUTCOME_KIND,
        render: async (_outcome, ctx) => ({
          answer: ctx.session.directiveSteering?.rules.map((rule) => rule.action).join(" ") ?? "",
          skillName: RETRIEVAL_TURN_SKILL,
          skillOutcome: "completed",
          skillStatus: "completed",
        }),
      },
    };
    const prepared = session();
    prepared.directiveSteering = undefined;

    const { presentation, result } = await runPreparedChatTurnWithConversationEngine({
      engine: new DefaultConversationEngine(),
      session: prepared,
      directiveRuntime,
      turnSkillSelector: new ChatTurnSkillSelector([retrievalSkill], strategy),
      turnSkills: [retrievalSkill],
      query: "Where is my order?",
    });

    expect(matched).toEqual([{
      turnContext: { query: "Where is my order?", route: "social_only" },
      directives: ["brief"],
    }]);
    expect(selectedDirectiveSets).toEqual([["brief"]]);
    expect(presentation.answer).toBe("Keep it brief.");
    expect(result.outcomes[0]?.steering).toEqual([
      expect.objectContaining({ action: "Keep it brief.", source: "directive", lifespan: "response" }),
    ]);
    expect(result.trace.stages.map((stage) => stage.kind)).toEqual([
      "gather",
      "directive_match",
      "skill_selection",
      "skill_dispatch",
      "compose",
    ]);
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
