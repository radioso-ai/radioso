import type {
  ConversationAgentConfig,
  ConversationEvent,
  DirectiveCoherenceGate,
  Directive,
  RenderableTurn,
  Routine,
} from "@radioso/conversation-contract";

import { createConversationKit, type ConversationKit, type CreateConversationKitOptions } from "./composition.js";
import type {
  ConversationKitAuthoringStore,
  UpdateConversationKitAgentInput,
  UpdateConversationKitDirectiveInput,
  UpdateConversationKitRoutineInput,
} from "./authoringStore.js";
import {
  createDirectiveCoherenceGate,
  DirectiveCoherenceError,
} from "@radioso/conversation-defaults";
import { createId } from "./ids.js";

type MaybePromise<T> = T | Promise<T>;

export interface CreateAgentInput {
  id?: string;
  name?: string;
  instructions?: string[];
  defaultLocale?: string | null;
  metadata?: Record<string, unknown>;
}

export interface ConversationKitSession {
  id: string;
  agentId: string;
  createdAt: string;
  metadata?: Record<string, unknown>;
}

export interface CreateSessionInput {
  id?: string;
  agentId: string;
  metadata?: Record<string, unknown>;
}

export interface SendMessageInput {
  sessionId: string;
  message: string;
  metadata?: Record<string, unknown>;
}

export interface CreateConversationKitClientOptions extends CreateConversationKitOptions {
  kit?: ConversationKit;
}

export interface ConversationKitClient {
  createAgent(input: CreateAgentInput): ConversationAgentConfig;
  getAgent(agentId: string): ConversationAgentConfig | null;
  listAgents(): ConversationAgentConfig[];
  updateAgent(agentId: string, input: UpdateConversationKitAgentInput): ConversationAgentConfig | null;
  deleteAgent(agentId: string): boolean;
  createDirective(agentId: string, directive: Directive): MaybePromise<Directive>;
  getDirective(agentId: string, directiveId: string): Directive | null;
  listDirectives(agentId: string): Directive[];
  updateDirective(
    agentId: string,
    directiveId: string,
    input: UpdateConversationKitDirectiveInput,
  ): MaybePromise<Directive | null>;
  deleteDirective(agentId: string, directiveId: string): boolean;
  addDirective(agentId: string, directive: Directive): MaybePromise<Directive>;
  addDirectives(agentId: string, directives: Directive[]): MaybePromise<Directive[]>;
  createRoutine(routine: Routine): Routine;
  getRoutine(routineId: string): Routine | null;
  listRoutines(): Routine[];
  updateRoutine(routineId: string, input: UpdateConversationKitRoutineInput): Routine | null;
  deleteRoutine(routineId: string): boolean;
  createSession(input: CreateSessionInput): ConversationKitSession;
  getSession(sessionId: string): ConversationKitSession | null;
  sendMessage(input: SendMessageInput): Promise<RenderableTurn>;
  listEvents(sessionId: string): ConversationEvent[];
}

class InMemoryConversationKitClient implements ConversationKitClient {
  private readonly kit: ConversationKit;
  private readonly authoringStore: ConversationKitAuthoringStore;
  private readonly directiveCoherence?: DirectiveCoherenceGate;
  private readonly sessions = new Map<string, ConversationKitSession>();

  constructor(options: CreateConversationKitClientOptions) {
    this.kit = options.kit ?? createConversationKit(options);
    this.authoringStore = options.authoringStore ?? this.kit.authoringStore;
    this.directiveCoherence = options.directiveCoherence?.enabled === false
      ? undefined
      : this.kit.directiveCoherence ?? createDirectiveCoherenceGate(options.directiveCoherence, this.kit.modelGateway);
  }

  createAgent(input: CreateAgentInput): ConversationAgentConfig {
    const agent: ConversationAgentConfig = {
      id: input.id ?? createId("agent"),
      name: input.name,
      instructions: input.instructions,
      defaultLocale: input.defaultLocale,
      metadata: input.metadata,
    };
    return this.authoringStore.createAgent(agent);
  }

  getAgent(agentId: string): ConversationAgentConfig | null {
    return this.authoringStore.getAgent(agentId);
  }

  listAgents(): ConversationAgentConfig[] {
    return this.authoringStore.listAgents();
  }

  updateAgent(agentId: string, input: UpdateConversationKitAgentInput): ConversationAgentConfig | null {
    return this.authoringStore.updateAgent(agentId, input);
  }

  deleteAgent(agentId: string): boolean {
    return this.authoringStore.deleteAgent(agentId);
  }

  createDirective(agentId: string, directive: Directive): MaybePromise<Directive> {
    const candidate: Directive = {
      ...directive,
      id: directive.id ?? createId("directive"),
    };
    if (!this.directiveCoherence) {
      this.requireAgent(agentId);
      return this.authoringStore.createDirective(agentId, candidate);
    }
    return this.createDirectiveWithGate(agentId, candidate);
  }

  getDirective(agentId: string, directiveId: string): Directive | null {
    return this.authoringStore.getDirective(agentId, directiveId);
  }

  listDirectives(agentId: string): Directive[] {
    return this.authoringStore.listDirectives(agentId);
  }

  updateDirective(
    agentId: string,
    directiveId: string,
    input: UpdateConversationKitDirectiveInput,
  ): MaybePromise<Directive | null> {
    const existing = this.authoringStore.getDirective(agentId, directiveId);
    if (!existing) {
      return null;
    }
    const candidate: Directive = { ...existing, ...input, id: directiveId };
    if (!this.directiveCoherence) {
      return this.authoringStore.updateDirective(agentId, directiveId, input);
    }
    return this.updateDirectiveWithGate(agentId, directiveId, candidate);
  }

  deleteDirective(agentId: string, directiveId: string): boolean {
    return this.authoringStore.deleteDirective(agentId, directiveId);
  }

  addDirective(agentId: string, directive: Directive): MaybePromise<Directive> {
    return this.createDirective(agentId, directive);
  }

  addDirectives(agentId: string, directives: Directive[]): MaybePromise<Directive[]> {
    if (!this.directiveCoherence) {
      return directives.map((directive) => this.addDirective(agentId, directive) as Directive);
    }
    return this.addDirectivesWithGate(agentId, directives);
  }

  createRoutine(routine: Routine): Routine {
    return this.authoringStore.createRoutine(routine);
  }

  getRoutine(routineId: string): Routine | null {
    return this.authoringStore.getRoutine(routineId);
  }

  listRoutines(): Routine[] {
    return this.authoringStore.listRoutines();
  }

  updateRoutine(routineId: string, input: UpdateConversationKitRoutineInput): Routine | null {
    return this.authoringStore.updateRoutine(routineId, input);
  }

  deleteRoutine(routineId: string): boolean {
    return this.authoringStore.deleteRoutine(routineId);
  }

  createSession(input: CreateSessionInput): ConversationKitSession {
    this.requireAgent(input.agentId);
    const session: ConversationKitSession = {
      id: input.id ?? createId("session"),
      agentId: input.agentId,
      createdAt: new Date().toISOString(),
      metadata: input.metadata,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  getSession(sessionId: string): ConversationKitSession | null {
    return this.sessions.get(sessionId) ?? null;
  }

  async sendMessage(input: SendMessageInput): Promise<RenderableTurn> {
    const session = this.sessions.get(input.sessionId);
    if (!session) {
      throw new Error(`conversation_kit_session_not_found:${input.sessionId}`);
    }
    const agent = this.requireAgent(session.agentId);
    const directives = this.authoringStore.listDirectives(agent.id);
    const result = await this.kit.runTurn({
      sessionId: session.id,
      agent,
      directives,
      message: input.message,
      metadata: input.metadata,
    });
    return result.response;
  }

  listEvents(sessionId: string): ConversationEvent[] {
    return this.kit.listEvents(sessionId);
  }

  private requireAgent(agentId: string): ConversationAgentConfig {
    const agent = this.authoringStore.getAgent(agentId);
    if (!agent) {
      throw new Error(`conversation_kit_agent_not_found:${agentId}`);
    }
    return agent;
  }

  private async createDirectiveWithGate(agentId: string, candidate: Directive): Promise<Directive> {
    this.requireAgent(agentId);
    await this.requireDirectiveCoherence(agentId, candidate);
    return this.authoringStore.createDirective(agentId, candidate);
  }

  private async updateDirectiveWithGate(
    agentId: string,
    directiveId: string,
    candidate: Directive,
  ): Promise<Directive | null> {
    this.requireAgent(agentId);
    await this.requireDirectiveCoherence(agentId, candidate, directiveId);
    return this.authoringStore.updateDirective(agentId, directiveId, candidate);
  }

  private async addDirectivesWithGate(agentId: string, directives: Directive[]): Promise<Directive[]> {
    const created: Directive[] = [];
    for (const directive of directives) {
      created.push(await this.createDirective(agentId, directive));
    }
    return created;
  }

  private async requireDirectiveCoherence(
    agentId: string,
    candidate: Directive,
    replacingDirectiveId?: string,
  ): Promise<void> {
    if (!this.directiveCoherence) {
      return;
    }
    const agent = this.requireAgent(agentId);
    const existingDirectives = this.authoringStore
      .listDirectives(agentId)
      .filter((directive) => directive.id !== replacingDirectiveId);
    const verdict = await this.directiveCoherence.checker.check({
      agent,
      candidate,
      existingDirectives,
    });
    if (!verdict.coherent) {
      throw new DirectiveCoherenceError(verdict);
    }
  }
}

export const createConversationKitClient = (
  options: CreateConversationKitClientOptions = {},
): ConversationKitClient => new InMemoryConversationKitClient(options);
