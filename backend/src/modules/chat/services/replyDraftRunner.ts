import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { ChatCitation } from "../contracts/index.js";
import { loadConversationSummaryText, type ConversationSummaryStore } from "../contracts/conversationSummary.js";
import type { RoutineState } from "@radioso/conversation-contract";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { ModelCallUsageAttribution } from "../../../shared/domain/modelCallUsageContext.js";
import type { WorkbenchReplayInput, WorkbenchReplayResult } from "./workbenchReplayRunner.js";

/**
 * The agent's live configuration, resolved by whoever owns agents. Chat replays a turn; it does
 * not know how an agent's directives, skills, and instructions are assembled into a config.
 */
export interface ReplyDraftAgentConfigPort {
  resolveConfig(workspaceId: string, agentId: string): Promise<WorkbenchReplayInput["baselineAgentConfig"] | null>;
}

/** Only the identity a draft needs: which workspace owns the conversation, and which agent speaks in it. */
export interface ReplyDraftConversationReadPort {
  findByIdAndWorkspaceId(conversationId: string, workspaceId: string): Promise<{
    id: string;
    workspaceId: string;
    agentId: string | null;
  } | null>;
}

export interface ReplyDraftRoutineStateReadPort {
  loadActive(input: { sessionId: string }): Promise<RoutineState | null>;
  /** A routine paused on an approval persists as `suspended`, which `loadActive` cannot see. */
  loadSuspended(input: { sessionId: string }): Promise<RoutineState | null>;
}

export interface ReplyDraftRunnerOptions {
  readonly conversations: ReplyDraftConversationReadPort;
  readonly messages: Pick<MessageRepositoryPort, "listRecentByConversationId">;
  readonly agentConfig: ReplyDraftAgentConfigPort;
  /**
   * The rolling summary of everything before the loaded window. A live turn injects it, so a draft
   * composed without it answers from a shorter memory than the agent has and can contradict a
   * commitment the conversation already made. Read through the shared helper, so the "blank means
   * absent, a failed read means absent" policy cannot drift from the live turn's.
   */
  readonly summaries: Pick<ConversationSummaryStore, "load">;
  /**
   * Where the conversation currently stands in a routine. A draft is the *next* turn, so unlike an
   * eval replay — which must not seed a captured turn with post-turn state — the live position is
   * exactly the right seed. Both statuses matter and they are separate reads: an active routine is
   * seeded so the draft continues it, and a suspended one (a conversation waiting on an approval)
   * is deliberately not, because that is what the live turn does with it.
   */
  readonly routineStates: ReplyDraftRoutineStateReadPort;
  readonly logger?: { warn: (fields: object, message?: string) => void };
  readonly replay: { run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> };
}

export interface ChatReplyDraftInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly accountId?: string | null;
  readonly historyLimit: number;
  readonly usageAttribution: ModelCallUsageAttribution;
  /**
   * Claims the workspace allowance this draft spends. Invoked immediately before the turn is
   * dispatched, never before the checks above it — a conversation that cannot be drafted for at
   * all must not cost an answer, and its refusal must not arrive as a quota error.
   */
  readonly reserve: () => Promise<void>;
}

export interface ChatReplyDraftResult {
  readonly agentId: string;
  readonly draft: string;
  readonly citations: ReadonlyArray<ChatCitation>;
  /** Messages the draft was composed over, so a thin transcript is visible as a thin transcript. */
  readonly groundedOnMessageCount: number;
  /** Whether the rolling summary of the turns before that window was available to the draft. */
  readonly groundedOnSummary: boolean;
  /** Whether the draft resumed a routine the conversation is part-way through. */
  readonly groundedOnRoutine: boolean;
}

const stripSessionId = ({ sessionId: _sessionId, ...position }: RoutineState) => position;

/**
 * Composes what the agent would say next in a live conversation, without becoming a turn in it.
 *
 * The run is ephemeral: it uses the replay runner's in-memory effect profile, so no message,
 * conversation, routine state, or summary is written and nothing reaches the customer. That is the
 * whole point — the operator reads the draft, edits it, and sends it themselves.
 */
export class ReplyDraftRunner {
  constructor(private readonly options: ReplyDraftRunnerOptions) {}

  async draftReply(input: ChatReplyDraftInput): Promise<ChatReplyDraftResult> {
    const conversation = await this.options.conversations.findByIdAndWorkspaceId(
      input.conversationId,
      input.workspaceId,
    );
    if (!conversation) {
      throw notFound("Conversation not found");
    }
    const agentId = conversation.agentId;
    if (!agentId) {
      throw badRequest("The conversation has no agent to draft a reply for");
    }

    const transcript = await this.options.messages.listRecentByConversationId(
      input.workspaceId,
      input.conversationId,
      input.historyLimit,
    );
    // The customer's most recent message, wherever it sits. Requiring it to be the *last* turn
    // refuses the two shapes this queue is made of: a handoff, where the agent spoke and then
    // escalated, and a complaint, where the agent answered and the customer said it was wrong. In
    // both the question is still outstanding — that is why a person is being asked to step in.
    const waitingIndex = transcript.map((message) => message.role).lastIndexOf("user");
    if (waitingIndex < 0) {
      throw badRequest("The conversation has no customer message to reply to");
    }
    const waiting = transcript[waitingIndex]!;
    // Everything after that message is dropped from history, which is right for an agent answer the
    // customer complained about — the point is to answer it again, better. It is wrong for an
    // operator's own reply: that message *did* answer the customer, so drafting another would hand
    // over a duplicate with no sign the question was already handled.
    if (transcript.slice(waitingIndex + 1).some((message) => message.source === "human_agent")) {
      throw badRequest("An operator has already replied to the customer's last message");
    }

    const [baselineAgentConfig, summary, routineState, suspendedRoutine] = await Promise.all([
      this.options.agentConfig.resolveConfig(input.workspaceId, agentId),
      // Routine state is keyed by conversation id, and so is the summary.
      loadConversationSummaryText(this.options.summaries, input.conversationId, this.options.logger),
      this.options.routineStates.loadActive({ sessionId: input.conversationId }),
      this.options.routineStates.loadSuspended({ sessionId: input.conversationId }),
    ]);
    if (!baselineAgentConfig) {
      throw notFound("Agent not found");
    }

    await input.reserve();
    const result = await this.options.replay.run({
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      sourceAgentId: agentId,
      baselineAgentConfig,
      // A draft is composed, read, and edited before anyone sends it, so the turn that composes it
      // must not act. Safe test leaves the answering skill running and suppresses every skill that
      // reaches outside — a notify, a webhook, a contact send, an external MCP tool — which would
      // otherwise fire against a real customer's conversation on the operator's behalf.
      executionMode: "safe_test",
      query: waiting.content,
      history: transcript.slice(0, waitingIndex),
      conversationSummary: summary ?? null,
      // The runner keys routine state by the ephemeral conversation it creates, so the seed is the
      // position without its session id. A suspended routine seeds nothing: the live turn skips the
      // routine entirely while it waits on an approval, so seeding one would make the draft attempt
      // a turn the agent itself would not take. Refusing instead would be worse — a suspended row
      // never expires, so the whole approval section of the queue would lose drafting for good.
      routineStartState: suspendedRoutine ? null : (routineState ? stripSessionId(routineState) : null),
      usageAttribution: input.usageAttribution,
    });

    return {
      agentId,
      draft: result.answer,
      citations: result.citations ?? [],
      groundedOnMessageCount: waitingIndex + 1,
      groundedOnSummary: summary !== undefined,
      groundedOnRoutine: routineState !== null,
    };
  }
}
