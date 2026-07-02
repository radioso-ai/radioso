import type { MessageSource, RoutineState } from "@radioso/conversation-contract";

import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRole } from "../../../db/repositories/messageRepository.js";

// Narrow ports: the fork only reads a source conversation + its messages and creates a
// new conversation with copied turns. It must never learn the full repository surface.
export interface ForkConversationRepositoryPort {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
  create(workspaceId: string, agentId?: string | null, sourceChannel?: string | null): Promise<ConversationRecord>;
}

export interface ForkMessageRepositoryPort {
  listByConversationId(workspaceId: string, conversationId: string): Promise<MessageRecord[]>;
  create(input: {
    conversationId: string;
    workspaceId: string;
    role: MessageRole;
    content: string;
    source?: MessageSource;
  }): Promise<MessageRecord>;
}

export interface ForkRoutineStateRepositoryPort {
  loadActive(input: { sessionId: string }): Promise<RoutineState | null>;
  save(state: RoutineState): Promise<void>;
}

/** Raised when the source conversation is not owned by the caller's workspace. */
export class ConversationForkSourceNotFoundError extends Error {
  constructor(conversationId: string) {
    super(`Source conversation ${conversationId} not found in workspace`);
    this.name = "ConversationForkSourceNotFoundError";
  }
}

// Test sessions are the "authenticated_chat" operator-test channel (see OPERATOR_TEST_SOURCE_CHANNELS).
const TEST_SESSION_SOURCE_CHANNEL = "authenticated_chat";

// System messages are runtime scaffolding, not part of the human-visible thread an operator
// wants to continue in the dashboard test chat.
const COPYABLE_ROLES: ReadonlySet<MessageRole> = new Set<MessageRole>(["user", "assistant"]);

export class ConversationForkService {
  constructor(
    private readonly conversationRepository: ForkConversationRepositoryPort,
    private readonly messageRepository: ForkMessageRepositoryPort,
    private readonly routineStateRepository: ForkRoutineStateRepositoryPort,
  ) {}

  async forkForTest(workspaceId: string, sourceConversationId: string): Promise<{ conversationId: string }> {
    const source = await this.conversationRepository.findByIdAndWorkspaceId(sourceConversationId, workspaceId);
    if (!source) {
      throw new ConversationForkSourceNotFoundError(sourceConversationId);
    }

    const messages = await this.messageRepository.listByConversationId(workspaceId, sourceConversationId);
    const fork = await this.conversationRepository.create(workspaceId, source.agentId, TEST_SESSION_SOURCE_CHANNEL);

    // Resume mid-routine: the source's CURRENT (post-turn) routine position is exactly
    // what a forward-continuing test session needs. (Eval *replay* deliberately does NOT
    // seed this, because it regenerates an already-answered turn and would start a step
    // ahead — the fork continues forward, so the live position is correct.) The state is
    // keyed by session id, which is the conversation id; re-key it to the fork. Only an
    // active routine is copied (loadActive filters out completed/suspended/expired).
    const routineState = await this.routineStateRepository.loadActive({ sessionId: sourceConversationId });
    if (routineState) {
      await this.routineStateRepository.save({ ...routineState, sessionId: fork.id });
    }

    // Sequential inserts preserve order: created_at is DB-generated per insert.
    for (const message of messages) {
      if (!COPYABLE_ROLES.has(message.role)) {
        continue;
      }
      await this.messageRepository.create({
        conversationId: fork.id,
        workspaceId,
        role: message.role,
        content: message.content,
        source: message.source,
      });
    }

    return { conversationId: fork.id };
  }
}
