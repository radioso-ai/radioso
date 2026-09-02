import type { MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
import type { ChatCitation } from "../contracts/index.js";
import { loadConversationSummaryText, type ConversationSummaryStore } from "../contracts/conversationSummary.js";
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
}

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
    const waiting = transcript.at(-1);
    // A draft answers somebody. When the agent or an operator spoke last there is no waiting
    // question, and composing one anyway would invent a customer turn that never happened.
    if (!waiting || waiting.role !== "user") {
      throw badRequest("The conversation's last turn is not a waiting customer message");
    }

    const [baselineAgentConfig, summary] = await Promise.all([
      this.options.agentConfig.resolveConfig(input.workspaceId, agentId),
      // Routine state is keyed by conversation id, and so is the summary.
      loadConversationSummaryText(this.options.summaries, input.conversationId, this.options.logger),
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
      history: transcript.slice(0, -1),
      conversationSummary: summary ?? null,
      usageAttribution: input.usageAttribution,
    });

    return {
      agentId,
      draft: result.answer,
      citations: result.citations ?? [],
      groundedOnMessageCount: transcript.length,
      groundedOnSummary: summary !== undefined,
    };
  }
}
