import { describe, expect, it, vi } from "vitest";

import type {
  ConversationEvent,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationTurnComposer,
  DirectiveMatch,
} from "@radioso/conversation-contract";
import type { ConversationRecord } from "../../src/db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../src/db/repositories/messageRepository.js";
import type { AgentRecord } from "../../src/modules/agents/public.js";
import {
  createAttemptRoutineInput,
  createChatProcessTurnInput,
} from "../../src/modules/chat/services/conversationProcessTurnInput.js";
import type { PreparedSession } from "../../src/modules/chat/services/chatSessionPreparer.js";
import {
  createRouteScopedDirectiveSteering,
  type RouteScopedDirectiveRuntime,
} from "../../src/modules/chat/services/routeScopedDirectiveSteering.js";
import { DefaultAllowCapabilityPolicy } from "../../src/shared/domain/capabilityPolicy.js";
import type { RetrievalPipelineResult } from "../../src/modules/retrieval/public.js";
import type {
  Directive,
  DirectiveFiringState,
  DirectiveStateStore,
  DirectiveSteerInput,
  DirectiveSteeringResult,
} from "../../src/modules/directives/public.js";

const inMemoryDirectiveStateStore = (): DirectiveStateStore => {
  const rows = new Map<string, DirectiveFiringState>();
  return {
    async load({ sessionId }) {
      const state = rows.get(sessionId);
      return state ? { turnSeq: state.turnSeq, firings: { ...state.firings } } : null;
    },
    async save({ sessionId, state }) {
      rows.set(sessionId, { turnSeq: state.turnSeq, firings: { ...state.firings } });
    },
  };
};

const conversation = (): ConversationRecord => ({
  id: "conv_1",
  workspaceId: "workspace_1",
  agentId: "agent_1",
  agentName: "Support",
  sourceChannel: null,
  anonymousSessionId: null,
  sourceOrigin: null,
  channelContext: null,
  verifiedCustomerId: null,
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
  citationDisplayEnabled: true,
  contactRequestsEnabled: false,
  webhookExportsEnabled: false,
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
  turnRoute: "direct",
  userMessage: message({
    inputMetadata: { method: "intent_click", intent: { skillName: "order.status" } },
  }),
  effectiveQuery: "Where is my order?",
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
  resolvedContext: { fragments: [], renderFragments: [], staged: [], snapshot: {} },
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

const routeScopedDirectiveRuntime = (directives: Directive[]): {
  runtime: RouteScopedDirectiveRuntime;
  matchedTurnContexts: Record<string, unknown>[];
  directiveInputs: DirectiveSteerInput[];
} => {
  const matchedTurnContexts: Record<string, unknown>[] = [];
  const directiveInputs: DirectiveSteerInput[] = [];
  return {
    matchedTurnContexts,
    directiveInputs,
    runtime: {
      directivesFor(input) {
        directiveInputs.push(input);
        return [...directives, ...(input.additionalDirectives ?? [])];
      },
      matcher: {
        async match(input: { turnContext: Record<string, unknown>; directives: Directive[] }): Promise<DirectiveMatch[]> {
          matchedTurnContexts.push(input.turnContext);
          return input.directives.map((directive) => ({
            directive,
            selectionMode: "deterministic",
            selectionReason: "test matcher",
          }));
        },
      },
      async resolveMatches(_input: DirectiveSteerInput, matches: DirectiveMatch[]): Promise<DirectiveSteeringResult> {
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async matchAndResolve(input: DirectiveSteerInput, directives: Directive[]): Promise<DirectiveSteeringResult> {
        matchedTurnContexts.push(input.turnContext ?? {});
        const matches = directives.map((directive) => ({
          directive,
          selectionMode: "deterministic" as const,
          selectionReason: "test matcher",
        }));
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolveWithClassifications not used in this test");
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    },
  };
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

  it("lets the engine invoke the route-scoped directive matcher with the candidate catalog", async () => {
    const directive: Directive = {
      name: "brief",
      condition: { kind: "always" },
      action: "Keep it brief.",
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    const { runtime, matchedTurnContexts } = routeScopedDirectiveRuntime([directive]);
    const input = createChatProcessTurnInput({
      session,
      directiveRuntime: runtime,
      dispatcher,
      selector,
      composer,
    });

    expect(input.directives).toEqual([directive]);
    await expect(input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: input.directives,
    })).resolves.toEqual([
      expect.objectContaining({
        directive,
        selectionReason: "test matcher",
      }),
    ]);
    expect(matchedTurnContexts).toEqual([{ query: "Where is my order?", route: "direct" }]);
    expect(session.directiveSteering).toMatchObject({
      rules: [{ action: "Keep it brief.", source: "directive", lifespan: "response" }],
      matches: [expect.objectContaining({ directive })],
      omissions: [],
    });
  });

  it("passes directive match usage context with the chat turn identifiers", async () => {
    const directive: Directive = {
      name: "brief",
      condition: { kind: "always" },
      action: "Keep it brief.",
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    const directiveInputs: DirectiveSteerInput[] = [];
    const runtime: RouteScopedDirectiveRuntime = {
      matcher: {
        async match(): Promise<DirectiveMatch[]> {
          throw new Error("chat turn adapter should use matchAndResolve");
        },
      },
      directivesFor(input) {
        directiveInputs.push(input);
        return [directive];
      },
      async resolveMatches(): Promise<DirectiveSteeringResult> {
        throw new Error("chat turn adapter should use matchAndResolve");
      },
      async matchAndResolve(input, directives): Promise<DirectiveSteeringResult> {
        directiveInputs.push(input);
        return {
          rules: directives.map((candidate) => ({
            action: candidate.action,
            source: "directive",
            lifespan: "response",
          })),
          matches: directives.map((candidate) => ({
            directive: candidate,
            selectionMode: "deterministic",
            selectionReason: "test matcher",
          })),
          omissions: [],
        };
      },
      async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolveWithClassifications not used in this test");
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    };
    const input = createChatProcessTurnInput({
      session,
      directiveRuntime: runtime,
      dispatcher,
      selector,
      composer,
    });

    await input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: input.directives,
    });

    expect(directiveInputs.at(-1)).toMatchObject({
      workspaceId: "workspace_1",
      usageContext: {
        workspaceId: "workspace_1",
        conversationId: "conv_1",
        messageId: "msg_1",
        surface: "chat",
        operation: "directive_match",
        attemptKey: "msg_1:directive_match",
      },
    });
  });

  it("keeps route-scoped retrieval directives eligible before the engine resolves the turn route", async () => {
    const directDirective: Directive = {
      name: "direct-tone",
      condition: { kind: "always" },
      action: "Answer conversationally.",
    };
    const retrievalDirective: Directive = {
      name: "retrieval-grounding",
      condition: { kind: "always" },
      action: "Use retrieved context.",
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    const sessionRef = { current: session };
    const matchedDirectiveNames: string[][] = [];
    const runtime: RouteScopedDirectiveRuntime = {
      directivesFor(input) {
        const route = input.turnContext?.route;
        return [
          ...(route === "direct" ? [directDirective] : []),
          ...(route === "retrieval" ? [retrievalDirective] : []),
          ...(input.additionalDirectives ?? []),
        ];
      },
      matcher: {
        async match(): Promise<DirectiveMatch[]> {
          throw new Error("chat turn adapter should use matchAndResolve");
        },
      },
      async resolveMatches(): Promise<DirectiveSteeringResult> {
        throw new Error("chat turn adapter should use matchAndResolve");
      },
      async matchAndResolve(_input, directives): Promise<DirectiveSteeringResult> {
        matchedDirectiveNames.push(directives.map((directive) => directive.name));
        const matches = directives.map((directive) => ({
          directive,
          selectionMode: "deterministic" as const,
          selectionReason: "test matcher",
        }));
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolveWithClassifications not used in this test");
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    };
    const input = createChatProcessTurnInput({
      session,
      getSession: () => sessionRef.current,
      directiveRuntime: runtime,
      dispatcher,
      selector,
      composer,
    });

    expect(input.directives.map((directive) => directive.name)).toEqual(["direct-tone", "retrieval-grounding"]);

    sessionRef.current = { ...sessionRef.current, turnRoute: "retrieval" };
    await expect(input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: input.directives,
    })).resolves.toEqual([
      expect.objectContaining({
        directive: retrievalDirective,
        selectionReason: "test matcher",
      }),
    ]);

    expect(matchedDirectiveNames).toEqual([["retrieval-grounding"]]);
    expect(sessionRef.current.directiveSteering).toMatchObject({
      rules: [{ action: "Use retrieved context.", source: "directive", lifespan: "response" }],
      matches: [expect.objectContaining({ directive: retrievalDirective })],
      omissions: [],
    });
  });

  it("stores directive steering on the latest prepared session when matching spans session replacement", async () => {
    const directive: Directive = {
      name: "retrieval-grounding",
      condition: { kind: "always" },
      action: "Use retrieved context.",
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    const sessionRef = { current: session };
    let resolveMatch: (() => void) | undefined;
    const matchingStarted = new Promise<void>((resolve) => {
      resolveMatch = resolve;
    });
    const runtime: RouteScopedDirectiveRuntime = {
      directivesFor(input) {
        return input.turnContext?.route === "retrieval" ? [directive] : [];
      },
      matcher: {
        async match(): Promise<DirectiveMatch[]> {
          throw new Error("chat turn adapter should use matchAndResolve");
        },
      },
      async resolveMatches(): Promise<DirectiveSteeringResult> {
        throw new Error("chat turn adapter should use matchAndResolve");
      },
      async matchAndResolve(_input, directives): Promise<DirectiveSteeringResult> {
        await matchingStarted;
        const matches = directives.map((candidate) => ({
          directive: candidate,
          selectionMode: "deterministic" as const,
          selectionReason: "test matcher",
        }));
        return {
          rules: matches.map((match) => ({
            action: match.directive.action,
            source: "directive",
            lifespan: "response",
          })),
          matches,
          omissions: [],
        };
      },
      async matchAndResolveWithClassifications(): Promise<DirectiveSteeringResult> {
        throw new Error("matchAndResolveWithClassifications not used in this test");
      },
      async steer(): Promise<DirectiveSteeringResult> {
        throw new Error("steer should not pre-resolve chat engine directives");
      },
    };
    const input = createChatProcessTurnInput({
      session,
      getSession: () => sessionRef.current,
      directiveRuntime: runtime,
      dispatcher,
      selector,
      composer,
    });
    sessionRef.current = { ...sessionRef.current, turnRoute: "retrieval" };

    const matchPromise = input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: input.directives,
    });
    const replacedSession = { ...sessionRef.current, directiveSteering: undefined };
    sessionRef.current = replacedSession;
    resolveMatch?.();

    await expect(matchPromise).resolves.toEqual([
      expect.objectContaining({
        directive,
        selectionReason: "test matcher",
      }),
    ]);
    expect(session.directiveSteering).toBeUndefined();
    expect(replacedSession.directiveSteering).toMatchObject({
      rules: [{ action: "Use retrieved context.", source: "directive", lifespan: "response" }],
      matches: [expect.objectContaining({ directive })],
      omissions: [],
    });
  });

  it("adds the resolved agent's authored directives to the engine candidate catalog", () => {
    const builtIn: Directive = {
      name: "brief",
      condition: { kind: "always" },
      action: "Keep it brief.",
      priority: 60,
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    session.agent = {
      ...session.agent,
      authoredDirectives: [{
        id: "directive_1",
        agentId: "agent_1",
        name: "agent-tone",
        condition: { kind: "always" },
        action: "Use the saved agent tone.",
        priority: null,
        binding: null,
        lifecycle: null,
        requiredCapabilities: [],
        dependsOn: [],
        excludes: [],
        routes: [],
        tags: [],
        description: null,
        metadata: {},
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
        updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      }],
    };
    const { runtime, directiveInputs } = routeScopedDirectiveRuntime([builtIn]);

    const input = createChatProcessTurnInput({
      session,
      directiveRuntime: runtime,
      dispatcher,
      selector,
      composer,
    });

    expect(input.directives.map((directive) => ({
      name: directive.name,
      action: directive.action,
      priority: directive.priority,
    }))).toEqual([
      { name: "brief", action: "Keep it brief.", priority: 60 },
      { name: "agent-tone", action: "Use the saved agent tone.", priority: 50 },
    ]);
    expect(directiveInputs[0]?.additionalDirectives?.map((directive) => directive.name)).toEqual(["agent-tone"]);
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

describe("createAttemptRoutineInput", () => {
  it("wires directive candidates and matcher through the routine turn input", async () => {
    const directive: Directive = {
      name: "routine-tone",
      condition: { kind: "always" },
      action: "Keep the routine answer precise.",
      priority: 60,
    };
    const session = preparedSession();
    session.directiveSteering = undefined;
    const { runtime, matchedTurnContexts } = routeScopedDirectiveRuntime([directive]);

    const input = createAttemptRoutineInput({
      session,
      accountId: "account_1",
      directiveRuntime: runtime,
    });

    expect(input.directives).toEqual([directive]);
    expect(input.directiveMatcher).toBeDefined();
    const directiveMatcher = input.directiveMatcher;
    const directives = input.directives;
    if (!directiveMatcher || !directives) {
      throw new Error("routine directive wiring missing");
    }
    await expect(directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives,
    })).resolves.toEqual([
      expect.objectContaining({
        directive,
        selectionReason: "test matcher",
      }),
    ]);
    expect(matchedTurnContexts).toEqual([{ query: "Where is my order?", route: "direct" }]);
    expect(session.directiveSteering).toMatchObject({
      rules: [{ action: "Keep the routine answer precise.", source: "directive", lifespan: "response" }],
      matches: [expect.objectContaining({ directive })],
      omissions: [],
    });
  });
});

describe("directive lifecycle memory (#865)", () => {
  const onceDirective: Directive = {
    name: "intro",
    condition: { kind: "always" },
    action: "Introduce yourself.",
    lifecycle: { kind: "once_per_conversation" },
  };

  const matchOnce = async (session: PreparedSession, store: DirectiveStateStore) => {
    const { runtime } = routeScopedDirectiveRuntime([onceDirective]);
    const input = createChatProcessTurnInput({
      session,
      directiveRuntime: runtime,
      directiveStateStore: store,
      dispatcher,
      selector,
      composer,
      getSession: () => session,
    });
    return input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: [onceDirective],
    });
  };

  it("fires a once_per_conversation directive on the first turn, then suppresses it after commit", async () => {
    const store = inMemoryDirectiveStateStore();

    const firstTurn = preparedSession();
    const firstMatches = await matchOnce(firstTurn, store);
    expect(firstMatches.map((m) => m.directive.name)).toEqual(["intro"]);
    // The lifecycle commit runs at turn completion; flush the per-turn deferred store.
    await firstTurn.directiveStateStore?.commit();

    const secondTurn = preparedSession();
    const secondMatches = await matchOnce(secondTurn, store);
    expect(secondMatches).toEqual([]);
    expect(secondTurn.directiveSteering?.lifecycleSuppressed).toEqual([
      { directiveName: "intro", lifecycle: { kind: "once_per_conversation" } },
    ]);
  });

  it("captures and suppresses once_per_conversation firing on the fused-plan fast path with zero gateway calls", async () => {
    const store = inMemoryDirectiveStateStore();
    const contextualOnce: Directive = {
      name: "refund-intro",
      condition: { kind: "contextual", description: "when the customer first asks about refunds" },
      action: "Introduce the refund policy.",
      lifecycle: { kind: "once_per_conversation" },
    };
    const throwingGatewayFactory = {
      create: vi.fn(async () => {
        throw new Error("directive gateway must not be created on the fused fast path");
      }),
    };
    const runtime = createRouteScopedDirectiveSteering({
      capabilityPolicy: new DefaultAllowCapabilityPolicy(),
      registrations: [{ directive: contextualOnce }],
      directiveMatchGatewayFactory: throwingGatewayFactory,
    });
    const plannedHandle: NonNullable<PreparedSession["turnPlan"]> = {
      resolve: async () => ({
        status: "planned",
        plan: {
          route: "direct",
          framing: { isIdentityQuestion: false },
          routineRankings: [],
          directiveClassifications: [{ name: "refund-intro", matched: true, confidence: 0.9 }],
        },
        prepared: null,
      }),
      bypass: () => {},
    };
    const matchPlanned = async (session: PreparedSession) => {
      session.turnPlan = plannedHandle;
      const input = createChatProcessTurnInput({
        session,
        directiveRuntime: runtime,
        directiveStateStore: store,
        dispatcher,
        selector,
        composer,
        getSession: () => session,
      });
      return input.directiveMatcher.match({
        turn: {
          agent: input.agent,
          sessionId: input.sessionId,
          inputEvent: input.inputEvent,
          history: [],
          stagedContext: [],
          steering: [],
        },
        directives: [contextualOnce],
      });
    };

    const firstTurn = preparedSession();
    const firstMatches = await matchPlanned(firstTurn);
    expect(firstMatches.map((m) => m.directive.name)).toEqual(["refund-intro"]);
    await firstTurn.directiveStateStore?.commit();

    const secondTurn = preparedSession();
    const secondMatches = await matchPlanned(secondTurn);
    expect(secondMatches).toEqual([]);
    expect(secondTurn.directiveSteering?.lifecycleSuppressed).toEqual([
      { directiveName: "refund-intro", lifecycle: { kind: "once_per_conversation" } },
    ]);
    expect(throwingGatewayFactory.create).not.toHaveBeenCalled();
  });

  it("does not persist firing memory for conversations without a tracked-lifecycle directive", async () => {
    const store = inMemoryDirectiveStateStore();
    const loadSpy = vi.spyOn(store, "save");
    const repeatable: Directive = { name: "brief", condition: { kind: "always" }, action: "Be brief." };
    const { runtime } = routeScopedDirectiveRuntime([repeatable]);
    const session = preparedSession();
    const input = createChatProcessTurnInput({
      session,
      directiveRuntime: runtime,
      directiveStateStore: store,
      dispatcher,
      selector,
      composer,
      getSession: () => session,
    });
    await input.directiveMatcher.match({
      turn: {
        agent: input.agent,
        sessionId: input.sessionId,
        inputEvent: input.inputEvent,
        history: [],
        stagedContext: [],
        steering: [],
      },
      directives: [repeatable],
    });
    await session.directiveStateStore?.commit();
    expect(loadSpy).not.toHaveBeenCalled();
  });
});
