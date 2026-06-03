import type {
  ConversationAgentConfig,
  ConversationEvent,
  Directive,
  RenderableTurn,
} from "@radioso/conversation-contract";

import { createConversationKit, type CreateConversationKitOptions } from "./composition.js";
import { createId } from "./ids.js";

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

export interface ConversationKitClient {
  createAgent(input: CreateAgentInput): ConversationAgentConfig;
  addDirective(agentId: string, directive: Directive): Directive;
  addDirectives(agentId: string, directives: Directive[]): Directive[];
  createSession(input: CreateSessionInput): ConversationKitSession;
  getSession(sessionId: string): ConversationKitSession | null;
  sendMessage(input: SendMessageInput): Promise<RenderableTurn>;
  listEvents(sessionId: string): ConversationEvent[];
}

class InMemoryConversationKitClient implements ConversationKitClient {
  private readonly kit;
  private readonly agents = new Map<string, ConversationAgentConfig>();
  private readonly directivesByAgent = new Map<string, Directive[]>();
  private readonly sessions = new Map<string, ConversationKitSession>();

  constructor(options: CreateConversationKitOptions) {
    this.kit = createConversationKit(options);
  }

  createAgent(input: CreateAgentInput): ConversationAgentConfig {
    const agent: ConversationAgentConfig = {
      id: input.id ?? createId("agent"),
      name: input.name,
      instructions: input.instructions,
      defaultLocale: input.defaultLocale,
      metadata: input.metadata,
    };
    this.agents.set(agent.id, agent);
    return agent;
  }

  addDirective(agentId: string, directive: Directive): Directive {
    this.requireAgent(agentId);
    const directives = this.directivesByAgent.get(agentId) ?? [];
    directives.push(directive);
    this.directivesByAgent.set(agentId, directives);
    return directive;
  }

  addDirectives(agentId: string, directives: Directive[]): Directive[] {
    return directives.map((directive) => this.addDirective(agentId, directive));
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
    const result = await this.kit.runTurn({
      sessionId: session.id,
      agent,
      directives: this.directivesByAgent.get(agent.id) ?? [],
      message: input.message,
      metadata: input.metadata,
    });
    return result.response;
  }

  listEvents(sessionId: string): ConversationEvent[] {
    return this.kit.listEvents(sessionId);
  }

  private requireAgent(agentId: string): ConversationAgentConfig {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`conversation_kit_agent_not_found:${agentId}`);
    }
    return agent;
  }
}

export const createConversationKitClient = (
  options: CreateConversationKitOptions = {},
): ConversationKitClient => new InMemoryConversationKitClient(options);
