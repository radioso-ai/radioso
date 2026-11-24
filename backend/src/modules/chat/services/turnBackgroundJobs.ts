import type { BackgroundJobRequest } from "../../../shared/background-jobs/index.js";
import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord } from "../../../db/repositories/messageRepository.js";
import { isClassifiedEnablement, type AgentContextVariableEnablement } from "../../context-variables/public.js";
import { contextClassificationRequest } from "../../contextClassification/public.js";
import { isEligibleForFacetExtraction } from "./facetExtractionEligibility.js";
import { conversationSummaryRefreshRequest } from "./summary/conversationSummaryRefreshJob.js";

/**
 * Whether the turn's conversation has its attributes classified after it: its revision has the
 * classifier fill one, and the turn is a visitor's message on an end-user channel, the population
 * facets read. A turn that answered a sensitive slot classifies too: its commit marks its messages,
 * and earlier ones it read a covered value from, so the run reads without them and recomputes a
 * value an earlier run took from them. Operator tests classify in Test Chat's own runner.
 */
const classifiesAfterTurn = (input: { session: TurnBackgroundJobSession }): boolean =>
  (input.session.revisionContextVariableEnablements ?? []).some(isClassifiedEnablement)
  && isEligibleForFacetExtraction({
    role: input.session.userMessage.role,
    source: input.session.userMessage.source,
    sourceChannel: input.session.conversation.sourceChannel,
  });

interface TurnBackgroundJobSession {
  conversation: Pick<ConversationRecord, "id" | "sourceChannel">;
  userMessage: Pick<MessageRecord, "role" | "source">;
  revisionContextVariableEnablements?: readonly AgentContextVariableEnablement[];
}

/**
 * The jobs a turn that records bookkeeping hands the worker, written in the turn's own commit so they
 * exist only once it does: the rolling summary refresh (#866) and, when it applies, the attribute
 * classification (#1884). Neither puts a model call on the reply's path.
 */
export const turnBackgroundJobs = (input: {
  workspaceId: string;
  accountId?: string;
  session: TurnBackgroundJobSession;
}): BackgroundJobRequest[] => [
  conversationSummaryRefreshRequest({
    workspaceId: input.workspaceId,
    conversationId: input.session.conversation.id,
    accountId: input.accountId,
  }),
  ...(classifiesAfterTurn(input)
    ? [contextClassificationRequest({ workspaceId: input.workspaceId, conversationId: input.session.conversation.id })]
    : []),
];
