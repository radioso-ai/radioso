import type { MessageRecord, MessageRepositoryPort } from "../../../db/repositories/messageRepository.js";
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
  readonly replay: { run(input: WorkbenchReplayInput): Promise<WorkbenchReplayResult> };
}

export interface ChatReplyDraftInput {
  readonly workspaceId: string;
  readonly conversationId: string;
  readonly accountId?: string | null;
  readonly historyLimit: number;
  readonly usageAttribution: ModelCallUsageAttribution;
}

export interface ChatReplyDraftResult {
  readonly agentId: string;
  readonly draft: string;
  readonly citations: ReadonlyArray<unknown>;
  /** Messages the draft was composed over, so a thin transcript is visible as a thin transcript. */
  readonly groundedOnMessageCount: number;
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

    const baselineAgentConfig = await this.options.agentConfig.resolveConfig(input.workspaceId, agentId);
    if (!baselineAgentConfig) {
      throw notFound("Agent not found");
    }

    const result = await this.options.replay.run({
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      sourceAgentId: agentId,
      baselineAgentConfig,
      query: waiting.content,
      history: transcript.slice(0, -1) as MessageRecord[],
      usageAttribution: input.usageAttribution,
    });

    return {
      agentId,
      draft: result.answer,
      citations: result.citations ?? [],
      groundedOnMessageCount: transcript.length,
    };
  }
}
