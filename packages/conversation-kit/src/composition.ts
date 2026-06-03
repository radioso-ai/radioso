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
  readonly skills: readonly SkillDefinition[];
  readonly stores: ConversationStores;
  readonly modelGateway: ConversationModelGateway;
  runTurn(input: RunConversationTurnInput): Promise<ProcessTurnResult>;
  listEvents(sessionId: string): ConversationEvent[];
}

export interface CreateConversationKitOptions extends ConversationKitModelGatewayOptions {
  agent?: ConversationAgentConfig;
  directives?: Directive[];
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

export const createConversationKit = (options: CreateConversationKitOptions = {}): ConversationKit => {
  const modelGateway = createConversationKitModelGateway(options);
  const stores = options.stores ?? new InMemoryConversationStores();
  const routineStore = new InMemoryConversationRoutineStore();
  const engine = options.engine ?? new DefaultConversationEngine();
  const agent = options.agent ?? defaultAgent();
  const directives = [...(options.directives ?? [])];
  const skills = [...(options.skills ?? [])];
  const directiveMatcher = options.directiveMatcher ?? createDefaultConversationDirectiveMatcher(modelGateway);
  const selector = options.selector ?? createDefaultConversationSkillSelector();
  const dispatcher = options.dispatcher ?? createDefaultConversationSkillDispatcher(options.localSkills);
  const composer = options.composer ?? createModelBackedConversationComposer(modelGateway);

  return {
    agent,
    directives,
    skills,
    stores,
    modelGateway,
    async runTurn(input): Promise<ProcessTurnResult> {
      const inputEvent: ConversationInputEvent = {
        id: createId("input"),
        kind: "message",
        content: input.message,
        metadata: input.metadata,
      };
      return engine.processTurn({
        agent: input.agent ?? agent,
        sessionId: input.sessionId ?? createId("session"),
        inputEvent,
        skills: input.skills ?? skills,
        directives: input.directives ?? directives,
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
