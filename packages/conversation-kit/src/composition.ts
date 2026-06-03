import type {
  ConversationAgentConfig,
  ConversationDirectiveMatcher,
  ConversationEngine,
  ConversationEvent,
  ConversationInputEvent,
  ConversationModelGateway,
  ConversationSkillDispatcher,
  ConversationSkillSelector,
  ConversationStores,
  ConversationTurnComposer,
  Directive,
  ProcessTurnResult,
  Routine,
  SkillDefinition,
} from "@radioso/conversation-contract";
import { InMemoryConversationRoutineStore, InMemoryConversationStores } from "@radioso/conversation-defaults";
import { DefaultConversationEngine } from "@radioso/conversation-engine";

import {
  createDefaultConversationDirectiveMatcher,
  createDefaultConversationSkillDispatcher,
  createDefaultConversationSkillSelector,
  createModelBackedConversationComposer,
  type LocalSkillRegistry,
} from "./defaultPorts.js";
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

export interface ConversationKit {
  readonly agent: ConversationAgentConfig;
  readonly directives: readonly Directive[];
  readonly routines: readonly Routine[];
  readonly authoringStore: ConversationKitAuthoringStore;
  readonly skills: readonly SkillDefinition[];
  readonly stores: ConversationStores;
  readonly modelGateway: ConversationModelGateway;
  runTurn(input: RunConversationTurnInput): Promise<ProcessTurnResult>;
  listEvents(sessionId: string): ConversationEvent[];
}

export interface CreateConversationKitOptions extends ConversationKitModelGatewayOptions {
  agent?: ConversationAgentConfig;
  directives?: Directive[];
  routines?: Routine[];
  authoringStore?: ConversationKitAuthoringStore;
  skills?: SkillDefinition[];
  localSkills?: LocalSkillRegistry;
  stores?: InMemoryConversationStores;
  engine?: ConversationEngine;
  directiveMatcher?: ConversationDirectiveMatcher;
  selector?: ConversationSkillSelector;
  dispatcher?: ConversationSkillDispatcher;
  composer?: ConversationTurnComposer;
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
  const routines = [...(options.routines ?? [])];
  const authoringStore = options.authoringStore ?? new TransientConversationKitAuthoringStore();
  seedAuthoringStore(authoringStore, agent, directives, routines);
  const skills = [...(options.skills ?? [])];
  const directiveMatcher = options.directiveMatcher ?? createDefaultConversationDirectiveMatcher(modelGateway);
  const selector = options.selector ?? createDefaultConversationSkillSelector();
  const dispatcher = options.dispatcher ?? createDefaultConversationSkillDispatcher(options.localSkills);
  const composer = options.composer ?? createModelBackedConversationComposer(modelGateway);

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
    async runTurn(input): Promise<ProcessTurnResult> {
      const turnAgent = input.agent ?? authoringStore.getAgent(agent.id) ?? agent;
      const inputEvent: ConversationInputEvent = {
        id: createId("input"),
        kind: "message",
        content: input.message,
        metadata: input.metadata,
      };
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
        composer,
        routineStore,
      });
    },
    listEvents(sessionId) {
      return stores.listEvents(sessionId);
    },
  };
};
