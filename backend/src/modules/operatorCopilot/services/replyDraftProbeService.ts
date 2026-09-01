import { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type {
  CopilotReplyDraftInput,
  CopilotReplyDraftPort,
  CopilotReplyDraftResult,
  ReplyDraftProbeServiceDependencies,
} from "../contracts/replyDraft.js";
import { enforceCopilotExpensiveOperation } from "./expensiveOperationGuard.js";

/**
 * How much of the live conversation a draft is composed over. Deep enough to carry a real support
 * thread, bounded because the draft run pays for every turn it reads.
 */
const REPLY_DRAFT_HISTORY_LIMIT = 30;

/**
 * Composes a reply an operator can send, and never sends it.
 *
 * The draft costs a real generation, so it spends the operator's expensive-operation budget like
 * every other probe. Nothing it produces is persisted or delivered: the boundary between drafting
 * and sending is the reason this is a probe rather than a proposal, because a proposal's apply
 * path would be the send.
 */
export class ReplyDraftProbeService implements CopilotReplyDraftPort {
  constructor(private readonly dependencies: ReplyDraftProbeServiceDependencies) {}

  async draft(input: CopilotReplyDraftInput): Promise<CopilotReplyDraftResult> {
    await enforceCopilotExpensiveOperation(this.dependencies, input, "draft_reply");

    const result = await this.dependencies.chatReplyDraft.draftReply({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      accountId: input.accountId,
      historyLimit: REPLY_DRAFT_HISTORY_LIMIT,
      usageAttribution: {
        surface: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
        requestId: input.copilotConversationId,
      },
    });

    return {
      agentId: result.agentId,
      conversationId: input.conversationId,
      draft: result.draft,
      citations: result.citations,
      groundedOnMessageCount: result.groundedOnMessageCount,
    };
  }
}
