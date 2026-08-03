import { randomUUID } from "node:crypto";

import type {
  ConversationClarificationStore,
  ConversationRoutineStore,
  PendingClarification,
  RoutineState,
} from "@radioso/conversation-contract";

import type {
  ConversationRecord,
  ConversationRepositoryPort,
} from "../../../db/repositories/conversationRepository.js";
import type {
  MessageRecord,
  MessageRepositoryPort,
} from "../../../db/repositories/messageRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import {
  commitDirectiveFirings,
  emptyDirectiveFiringState,
  type DirectiveFiringState,
  type DirectiveStateStore,
} from "../../directives/public.js";
import { InMemoryRoutineStore } from "./routines/inMemoryRoutineStore.js";

const ephemeralConversation = (
  workspaceId: string,
  agentId: string | null,
): ConversationRecord => {
  const now = new Date();
  return {
    id: randomUUID(),
    workspaceId,
    agentId,
    agentName: null,
    agentInternalName: null,
    sourceChannel: "workbench_replay",
    sourceOrigin: null,
    channelContext: null,
    anonymousSessionId: null,
    verifiedCustomerId: null,
    entryPageUrl: null,
    createdAt: now,
    updatedAt: now,
  };
};

const createEphemeralConversationRepository = (): ConversationRepositoryPort => ({
  async create(workspaceId, agentId) {
    return ephemeralConversation(workspaceId, agentId ?? null);
  },
  async createWithInitialAssistantMessage() {
    throw new Error("ephemeral_turn_unexpected_initial_assistant_message");
  },
  async listPageByWorkspaceId() {
    return { conversations: [], total: 0, nextCursor: null, hasMore: false };
  },
  async countByWorkspaceId() {
    return 0;
  },
  async listPageByAnonymousSession() {
    return { conversations: [], total: 0, nextCursor: null, hasMore: false };
  },
  async findByIdAndWorkspaceId() {
    return null;
  },
  async findByIdAndAnonymousSession() {
    return null;
  },
  async setVerifiedCustomerId() {},
  async touch() {},
});

const createEphemeralMessageRepository = (): MessageRepositoryPort => ({
  async listByConversationId() {
    return [];
  },
  async listRecentByConversationId() {
    return [];
  },
  async countByConversationId() {
    return 0;
  },
  async listWindowByConversationId() {
    return { messages: [], total: 0, nextCursor: null, hasMore: false };
  },
  async listSinceByConversationId() {
    return { messages: [], latestCursor: null };
  },
  async summarizeByConversationIds() {
    return new Map();
  },
  async create(input) {
    return {
      id: input.id ?? randomUUID(),
      conversationId: input.conversationId,
      workspaceId: input.workspaceId,
      role: input.role,
      content: input.content,
      inputMetadata: input.inputMetadata,
      metadata: input.metadata,
      skillName: input.skillName,
      skillOutcome: input.skillOutcome,
      skillStatus: input.skillStatus,
      createdAt: new Date(),
    };
  },
});

const cloneDirectiveFiringState = (state: DirectiveFiringState): DirectiveFiringState => ({
  turnSeq: state.turnSeq,
  firings: Object.fromEntries(
    Object.entries(state.firings).map(([name, firing]) => [name, { ...firing }]),
  ),
});

const directiveFiringNamesFromMetadata = (
  metadata: Record<string, unknown> | undefined,
): string[] => {
  const value = metadata?.directiveFirings;
  if (!Array.isArray(value)) {
    return [];
  }
  return [
    ...new Set(
      value.filter(
        (name): name is string => typeof name === "string" && name.length > 0,
      ),
    ),
  ];
};

const directiveStateFromHistory = (
  history: readonly MessageRecord[],
): DirectiveFiringState | null => {
  let state: DirectiveFiringState | null = null;
  for (const message of history) {
    if (message.role !== "assistant") {
      continue;
    }
    const firedNames = directiveFiringNamesFromMetadata(message.metadata);
    if (!state && firedNames.length === 0) {
      continue;
    }
    state = commitDirectiveFirings(state ?? emptyDirectiveFiringState(), firedNames);
  }
  return state;
};

class EphemeralDirectiveStateStore implements DirectiveStateStore {
  constructor(private state: DirectiveFiringState | null) {}

  async load(): Promise<DirectiveFiringState | null> {
    return this.state ? cloneDirectiveFiringState(this.state) : null;
  }

  async save(input: { state: DirectiveFiringState }): Promise<void> {
    this.state = cloneDirectiveFiringState(input.state);
  }
}

class InMemoryClarificationStore implements ConversationClarificationStore {
  constructor(private pending: PendingClarification | null = null) {}

  async loadPending(input: { sessionId: string }): Promise<PendingClarification | null> {
    return this.pending?.sessionId === input.sessionId && this.pending.status === "pending"
      ? this.pending
      : null;
  }

  async save(pending: PendingClarification): Promise<void> {
    this.pending = pending;
  }

  async clear(input: { sessionId: string }): Promise<void> {
    if (this.pending?.sessionId === input.sessionId) {
      this.pending = null;
    }
  }
}

/**
 * Side-effect adapters for a single non-durable engine turn. Every write remains
 * process-local and the profile is discarded after the replay completes.
 */
export interface EphemeralChatTurnEffectProfile {
  conversationRepository: ConversationRepositoryPort;
  messageRepository: MessageRepositoryPort;
  auditService: AuditService;
  directiveStateStore: DirectiveStateStore;
  routineStore(seed?: RoutineState | null): ConversationRoutineStore;
  clarificationStore(seed?: PendingClarification | null): ConversationClarificationStore;
}

export const createEphemeralChatTurnEffectProfile = (
  history: readonly MessageRecord[],
): EphemeralChatTurnEffectProfile => ({
  conversationRepository: createEphemeralConversationRepository(),
  messageRepository: createEphemeralMessageRepository(),
  auditService: {
    async record() {},
    async getLatestSuccessfulChatAnswerMetadata() {
      return null;
    },
    async updateChatAnswerSuggestions() {},
  },
  directiveStateStore: new EphemeralDirectiveStateStore(directiveStateFromHistory(history)),
  routineStore: (seed) => new InMemoryRoutineStore(seed),
  clarificationStore: (seed) => new InMemoryClarificationStore(seed),
});
