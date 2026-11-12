import type { MessageSource } from "@radioso/conversation-contract";
import type { ConversationRecord } from "../../../db/repositories/conversationRepository.js";
import type { MessageRecord, MessageRole } from "../../../db/repositories/messageRepository.js";
import type { FacetExtractionJobStore } from "../../facets/public.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { isAudiencePulseCustomerSource, isAudiencePulseEndUserChannel } from "../audiencePulseHistorySource.js";

/**
 * The same eligibility rule Audience Pulse reads history with
 * ({@link isAudiencePulseCustomerSource}, {@link isAudiencePulseEndUserChannel}),
 * restated as a write-time predicate so a facet extraction job is enqueued for the
 * same population the census will later read. `role` is checked here too even though
 * this module only ever writes `"user"` messages: the rule is reused, not restated,
 * so it stays correct if that ever changes.
 */
export const isEligibleForFacetExtraction = (input: {
  role: MessageRole;
  source: MessageSource | null | undefined;
  sourceChannel: string | null;
}): boolean =>
  input.role === "user"
  && isAudiencePulseCustomerSource(input.source ?? null)
  && isAudiencePulseEndUserChannel(input.sourceChannel);

/**
 * Fire-and-forget: a queue outage must never fail the turn that triggered it, so the
 * enqueue promise is never awaited by the caller and its rejection is caught here.
 */
export const enqueueFacetExtraction = (
  facetExtractionJobs: Pick<FacetExtractionJobStore, "enqueue"> | undefined,
  logger: Pick<AppLogger, "warn"> | undefined,
  userMessage: MessageRecord,
  conversation: ConversationRecord,
): void => {
  if (!facetExtractionJobs) {
    return;
  }
  if (!isEligibleForFacetExtraction({
    role: userMessage.role,
    source: userMessage.source,
    sourceChannel: conversation.sourceChannel,
  })) {
    return;
  }
  void facetExtractionJobs
    .enqueue({ messageId: userMessage.id, workspaceId: userMessage.workspaceId })
    .catch((error: unknown) => {
      logger?.warn(
        {
          err: error,
          workspaceId: userMessage.workspaceId,
          messageId: userMessage.id,
        },
        "Facet extraction enqueue failed",
      );
    });
};
