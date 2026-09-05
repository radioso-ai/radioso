import { OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL } from "../../../shared/domain/conversationSource.js";
import type {
  CopilotReplyDraftInput,
  CopilotReplyDraftPort,
  CopilotReplyDraftResult,
  ReplyDraftProbeServiceDependencies,
} from "../contracts/replyDraft.js";
import type { UsageLimitReservation } from "../../../shared/domain/usageLimitPolicy.js";
import { enforceCopilotExpensiveOperation, withCopilotSpendRefusals } from "./expensiveOperationGuard.js";

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

    // A draft is a full agent turn against the workspace's provider, so it draws on the same
    // allowance a customer answer does. The reservation is handed to the runner rather than taken
    // here, because the runner refuses several conversations before it dispatches anything — one
    // with no customer message, or one an operator has already answered, costs nothing and says so
    // instead of reporting a quota that was never the reason.
    let reservation: UsageLimitReservation | null = null;
    return withCopilotSpendRefusals(async () => {
      try {
        const result = await this.dependencies.chatReplyDraft.draftReply({
          workspaceId: input.workspaceId,
          conversationId: input.conversationId,
          accountId: input.accountId,
          historyLimit: REPLY_DRAFT_HISTORY_LIMIT,
          usageAttribution: {
            surface: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
            requestId: input.copilotConversationId,
          },
          reserve: async () => {
            reservation = await this.dependencies.usageLimitPolicy.reserveAnswer({
              accountId: input.accountId,
              workspaceId: input.workspaceId,
              surface: OPERATOR_COPILOT_PROBE_SOURCE_CHANNEL,
            });
          },
        });

        return {
          agentId: result.agentId,
          conversationId: input.conversationId,
          draft: result.draft,
          citations: result.citations,
          groundedOnMessageCount: result.groundedOnMessageCount,
          groundedOnSummary: result.groundedOnSummary,
          groundedOnRoutine: result.groundedOnRoutine,
        };
      } finally {
        // Past the reservation the turn has been dispatched, so a later failure asks "did the
        // provider already run", not "did the call succeed". Releasing here would hand back budget
        // a real generation consumed; a refusal before the reservation has nothing to commit.
        await (reservation)?.commit();
      }
    });
  }
}
