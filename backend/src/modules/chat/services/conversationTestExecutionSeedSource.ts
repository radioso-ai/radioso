import type { PendingClarification, RoutineState } from "@radioso/conversation-contract";

import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import type { DirectiveFiringState } from "../../directives/public.js";
import { RETRIEVAL_BEHAVIOR } from "../../../shared/domain/behaviorConfig.js";
import type {
  TestExecutionSeed,
  TestExecutionSeedMessage,
  TestExecutionSeedSource,
} from "../../test-execution/public.js";
import { exportTestExecutionReplayContinuation } from "./testExecutionContinuation.js";

// Reader ports: a seed reads a source conversation, its recent thread, and its live runtime
// state, and never persists anything of its own. No port here exposes a save; the one
// side effect is inside `loadPending`, whose Postgres implementation expires a stale
// pending clarification row as it reads (the same expiry a live turn would apply).
export interface SeedConversationReaderPort {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<ConversationRecord | null>;
}

export interface SeedMessageReaderPort {
  listRecentByConversationId(workspaceId: string, conversationId: string, limit: number): Promise<MessageRecord[]>;
}

export interface SeedRoutineStateReaderPort {
  loadActive(input: { sessionId: string }): Promise<RoutineState | null>;
}

export interface SeedClarificationReaderPort {
  loadPending(input: { sessionId: string }): Promise<PendingClarification | null>;
}

export interface SeedDirectiveStateReaderPort {
  load(input: { sessionId: string }): Promise<DirectiveFiringState | null>;
}

interface ConversationTestExecutionSeedSourceOptions {
  conversations: SeedConversationReaderPort;
  messages: SeedMessageReaderPort;
  routineStates: SeedRoutineStateReaderPort;
  clarifications: SeedClarificationReaderPort;
  directiveStates: SeedDirectiveStateReaderPort;
}

// System messages are runtime scaffolding, not part of the human-visible thread an operator
// continues in a private test.
const seedMessage = (message: MessageRecord): TestExecutionSeedMessage | null =>
  message.role === "user" || message.role === "assistant"
    ? { role: message.role, content: message.content, messageId: message.id, createdAt: message.createdAt }
    : null;

// A seeded side is replayed in full on every test turn (there is no rolling summary behind
// it), so the seed is the same recent-message window a live turn reads. One extra row is
// fetched only to tell a thread that exactly fills the window from one that overflowed it.
// When older messages were cut, a leading assistant reply has lost the question it answered,
// so the thread opens on its first user turn instead. A thread that fits keeps its greeting.
const HISTORY_WINDOW = RETRIEVAL_BEHAVIOR.rewriteConversationContextMaxMessages;

const seedThread = (fetched: readonly MessageRecord[]): TestExecutionSeedMessage[] => {
  const windowCut = fetched.length > HISTORY_WINDOW;
  const messages = windowCut ? fetched.slice(fetched.length - HISTORY_WINDOW) : fetched;
  const thread = messages.flatMap((message) => {
    const seeded = seedMessage(message);
    return seeded ? [seeded] : [];
  });
  if (!windowCut) return thread;
  const firstUser = thread.findIndex((message) => message.role === "user");
  return firstUser < 0 ? [] : thread.slice(firstUser);
};

/**
 * Seeds a private test execution from a live conversation: the user+assistant thread plus
 * the conversation's CURRENT (post-turn) routine, clarification, and directive position,
 * which is exactly what a forward-continuing test needs. (Eval *replay* deliberately does
 * NOT seed runtime state, because it regenerates an already-answered turn and would start
 * a step ahead.) The state is exported without its session id so the trusted runner
 * rebinds it to the side's own conversation; the source is never touched.
 */
export class ConversationTestExecutionSeedSource implements TestExecutionSeedSource {
  constructor(private readonly options: ConversationTestExecutionSeedSourceOptions) {}

  async loadSeed(input: { workspaceId: string; agentId: string; conversationId: string }): Promise<TestExecutionSeed | null> {
    const source = await this.options.conversations.findByIdAndWorkspaceId(input.conversationId, input.workspaceId);
    // One answer for "missing", "another workspace's", and "another agent's": the execution's
    // agent owns the revision under test, so a thread from another agent is not its seed.
    if (!source || source.agentId !== input.agentId) return null;

    const sessionId = input.conversationId;
    const [messages, routineState, pendingClarification, directiveState] = await Promise.all([
      this.options.messages.listRecentByConversationId(input.workspaceId, input.conversationId, HISTORY_WINDOW + 1),
      this.options.routineStates.loadActive({ sessionId }),
      this.options.clarifications.loadPending({ sessionId }),
      this.options.directiveStates.load({ sessionId }),
    ]);

    return {
      messages: seedThread(messages),
      continuation: routineState || pendingClarification || directiveState
        ? exportTestExecutionReplayContinuation({ routineState, pendingClarification, directiveState })
        : null,
    };
  }
}
