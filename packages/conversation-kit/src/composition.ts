import type {
  ConversationAgentConfig,
  ConversationDirectiveMatcher,
  ConversationEngine,
  ConversationEvent,
  ConversationInputEvent,
  ConversationModelGateway,
  ConversationRoutineSkillDispatcher,
  ConversationSkillInputResolver,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationStores,
  ConversationTurnComposer,
  Directive,
  ProcessTurnResult,
  Routine,
  SkillDefinition,
} from "@radioso/conversation-contract";
import {
  InMemoryConversationRoutineStore,
  InMemoryConversationStores,
  RoutineNextStepSelector,
  RoutineRegistry,
  RoutineStepRenderer,
  type RoutineRegistration,
} from "@radioso/conversation-defaults";
import * as conversationDefaults from "@radioso/conversation-defaults";
import { DefaultConversationEngine, DefaultRoutineRunner } from "@radioso/conversation-engine";

import {
  createDefaultConversationDirectiveMatcher,
  createDefaultConversationSkillDispatcher,
  createDefaultConversationSkillSelector,
  createDefaultRoutineSkillDispatcher,
  createModelBackedConversationComposer,
  type DefaultConversationSkillSelectorOptions,
  type LocalSkillRegistry,
} from "./defaultPorts.js";
import {
  createDirectiveCoherenceGate,
  type DirectiveCoherenceGate,
  type DirectiveCoherenceGateOptions,
} from "@radioso/conversation-defaults";
import {
  TransientConversationKitAuthoringStore,
  type ConversationKitAuthoringStore,
} from "./authoringStore.js";
import { createId } from "./ids.js";
import { createConversationKitModelGateway, type ConversationKitModelGatewayOptions } from "./modelGateway.js";

export interface RunConversationTurnInput {
  sessionId?: string;
  message: string;
  agent?: ConversationAgentConfig;
  directives?: Directive[];
  skills?: SkillDefinition[];
  metadata?: Record<string, unknown>;
}

const createSkillInputResolver = (modelGateway: ConversationModelGateway): ConversationSkillInputResolver => {
  const factory = (conversationDefaults as typeof conversationDefaults & {
    createConversationSkillInputResolver: (options: { modelGateway: ConversationModelGateway }) => ConversationSkillInputResolver;
  }).createConversationSkillInputResolver;
  return factory({ modelGateway });
};

export interface ConversationKit {
  readonly agent: ConversationAgentConfig;
  readonly directives: readonly Directive[];
  readonly routines: readonly Routine[];
  readonly authoringStore: ConversationKitAuthoringStore;
  readonly skills: readonly SkillDefinition[];
  readonly stores: ConversationStores;
  readonly modelGateway: ConversationModelGateway;
  readonly directiveCoherence?: DirectiveCoherenceGate;
  runTurn(input: RunConversationTurnInput): Promise<ProcessTurnResult>;
  listEvents(sessionId: string): ConversationEvent[];
}

export interface CreateConversationKitOptions extends ConversationKitModelGatewayOptions {
  agent?: ConversationAgentConfig;
  directives?: Directive[];
  routines?: Routine[];
  /**
   * Routines paired with when they should *start* (the host-owned `activates` predicate,
   * per the conversation contract). Their routines are also seeded into the authoring
   * store so they are listable/resumable. Without a registration a routine is still
   * authorable and resumable, but never auto-starts — activation logic lives here, not
   * in the engine.
   */
  routineRegistrations?: RoutineRegistration[];
  /**
   * How a routine's `skill` steps run. Without one the kit dispatches them against the
   * registered `skills` and their `localSkills` handlers, resolving each step's authored
   * `inputBindings` into the handler's arguments. Supply your own to run routine skills
   * through a different executor (an MCP client, a remote service) — it never replaces
   * turn-level dispatch, which stays on `dispatcher`.
   */
  routineSkillDispatcher?: ConversationRoutineSkillDispatcher;
  authoringStore?: ConversationKitAuthoringStore;
  skills?: SkillDefinition[];
  localSkills?: LocalSkillRegistry;
  /**
   * Per-skill availability the default selector consults before letting a directive
   * binding claim a turn. Read per turn, so a long-lived kit sees current state.
   */
  agentSkillStates?: DefaultConversationSkillSelectorOptions["agentSkillStates"];
  stores?: InMemoryConversationStores;
  engine?: ConversationEngine;
  directiveMatcher?: ConversationDirectiveMatcher;
  selector?: ConversationSkillSelector;
  /** Override the default model-backed declared-skill input resolver. */
  skillInputResolver?: ConversationSkillInputResolver;
  dispatcher?: ConversationSkillDispatcher;
  composer?: ConversationTurnComposer;
  directiveCoherence?: DirectiveCoherenceGateOptions;
}

const defaultAgent = (): ConversationAgentConfig => ({
  id: "agent_default",
  name: "Conversation Kit",
});

const directiveWithId = (directive: Directive): Directive => ({
  ...directive,
  id: directive.id ?? createId("directive"),
});

const seedAuthoringStore = (
  store: ConversationKitAuthoringStore,
  agent: ConversationAgentConfig,
  directives: readonly Directive[],
  routines: readonly Routine[],
): void => {
  if (!store.getAgent(agent.id)) {
    store.createAgent(agent);
  }
  for (const directive of directives.map(directiveWithId)) {
    if (!directive.id || store.getDirective(agent.id, directive.id)) {
      continue;
    }
    store.createDirective(agent.id, directive);
  }
  for (const routine of routines) {
    if (!store.getRoutine(routine.id)) {
      store.createRoutine(routine);
    }
  }
};

export const createConversationKit = (options: CreateConversationKitOptions = {}): ConversationKit => {
  const modelGateway = createConversationKitModelGateway(options);
  const stores = options.stores ?? new InMemoryConversationStores();
  const routineStore = new InMemoryConversationRoutineStore();
  const engine = options.engine ?? new DefaultConversationEngine();
  const agent = options.agent ?? defaultAgent();
  const directives = (options.directives ?? []).map(directiveWithId);
  const routineRegistrations = options.routineRegistrations ?? [];
  const routines = [...(options.routines ?? []), ...routineRegistrations.map((registration) => registration.routine)];
  const authoringStore = options.authoringStore ?? new TransientConversationKitAuthoringStore();
  seedAuthoringStore(authoringStore, agent, directives, routines);
  const skills = [...(options.skills ?? [])];
  const directiveMatcher = options.directiveMatcher ?? createDefaultConversationDirectiveMatcher(modelGateway);
  const selector = options.selector ?? createDefaultConversationSkillSelector(
    options.agentSkillStates ? { agentSkillStates: options.agentSkillStates } : {},
  );
  const dispatcher = options.dispatcher ?? createDefaultConversationSkillDispatcher(options.localSkills);
  const routineSkillDispatcher = options.routineSkillDispatcher
    ?? createDefaultRoutineSkillDispatcher(options.localSkills ?? new Map(), skills);
  const composer = options.composer ?? createModelBackedConversationComposer(modelGateway);
  const skillInputResolver = options.skillInputResolver ?? createSkillInputResolver(modelGateway);
  const directiveCoherence = createDirectiveCoherenceGate(options.directiveCoherence, modelGateway);

  // Routines become runnable, not just authorable: the runner resumes an active routine
  // and the activator (built from registrations) starts one. The runner is rebuilt per
  // turn from the current authoring store so routines added via CRUD are also resumable.
  const routineSelector = new RoutineNextStepSelector(modelGateway);
  const routineRenderer = new RoutineStepRenderer(modelGateway);
  const routineRegistry = new RoutineRegistry(routineRegistrations);
  const routineActivator = routineRegistry.isEmpty ? undefined : routineRegistry.activator(modelGateway);

  return {
    get agent() {
      return authoringStore.getAgent(agent.id) ?? agent;
    },
    get directives() {
      return authoringStore.listDirectives(agent.id);
    },
    get routines() {
      return authoringStore.listRoutines();
    },
    authoringStore,
    skills,
    stores,
    modelGateway,
    directiveCoherence,
    async runTurn(input): Promise<ProcessTurnResult> {
      const turnAgent = input.agent ?? authoringStore.getAgent(agent.id) ?? agent;
      const inputEvent: ConversationInputEvent = {
        id: createId("input"),
        kind: "message",
        content: input.message,
        metadata: input.metadata,
      };
      const routineRunner = new DefaultRoutineRunner(
        authoringStore.listRoutines(),
        routineSelector,
        routineRenderer,
        routineSkillDispatcher,
      );
      return engine.processTurn({
        agent: turnAgent,
        sessionId: input.sessionId ?? createId("session"),
        inputEvent,
        skills: input.skills ?? skills,
        directives: input.directives ?? authoringStore.listDirectives(turnAgent.id),
        stores,
        modelGateway,
        dispatcher,
        directiveMatcher,
        selector,
        skillInputResolver,
        composer,
        routineStore,
        routineRunner,
        ...(routineActivator ? { routineActivator } : {}),
      });
    },
    listEvents(sessionId) {
      return stores.listEvents(sessionId);
    },
  };
};
