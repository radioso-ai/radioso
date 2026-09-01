import type { UsageLimitPolicy } from "../../../shared/domain/usageLimitPolicy.js";
import type { CopilotExpensiveOperationGuardDependencies } from "./expensiveOperation.js";

export interface CopilotReplyDraftInput {
  workspaceId: string;
  accountId: string;
  operatorUserId: string;
  /** Ray's own conversation, used to attribute the model spend this draft costs. */
  copilotConversationId: string;
  conversationId: string;
}

export interface CopilotReplyDraftResult {
  agentId: string;
  conversationId: string;
  draft: string;
  citations: ReadonlyArray<unknown>;
  groundedOnMessageCount: number;
  groundedOnSummary: boolean;
}

export interface CopilotReplyDraftPort {
  draft(input: CopilotReplyDraftInput): Promise<CopilotReplyDraftResult>;
}

/**
 * The owner module's ephemeral draft run, narrowed to what Ray needs. Chat knows how to replay an
 * agent over a transcript without persisting anything; it does not know about operators, budgets,
 * or the boundary that keeps the draft from being sent.
 */
export interface CopilotChatReplyDraftPort {
  draftReply(input: {
    workspaceId: string;
    conversationId: string;
    accountId?: string | null;
    historyLimit: number;
    usageAttribution: { surface: string; requestId?: string };
  }): Promise<{
    agentId: string;
    draft: string;
    citations: ReadonlyArray<unknown>;
    groundedOnMessageCount: number;
    groundedOnSummary: boolean;
  }>;
}

export interface ReplyDraftProbeServiceDependencies extends CopilotExpensiveOperationGuardDependencies {
  chatReplyDraft: CopilotChatReplyDraftPort;
  /** A draft costs the workspace an answer, so it is reserved by the service that spends it. */
  usageLimitPolicy: Pick<UsageLimitPolicy, "reserveAnswer">;
}
