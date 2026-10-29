import type { EmailChannelJobLogger } from "../emailChannelAudit.js";
import type { EmailSendIntentRecord } from "../persistence/emailSendIntentRepository.js";
import type { SendIntentWriteOutcome, SendIntentWriter, SendIntentWriterName } from "./sendIntentWriter.js";

/** A provider's acceptance of a send: its own id, and the Message-ID it delivers under when known. */
interface ProviderAcceptance {
  providerMessageId: string;
  deliveredMessageId: string | null;
}

/** The thread index rows an accepted send is found by: the supplied id, and the delivered one when it differs. */
export const outboundIndexEntries = (intent: EmailSendIntentRecord, rfcMessageIds: readonly string[]) =>
  [...new Set(rfcMessageIds)].map((rfcMessageId) => ({
    workspaceId: intent.workspaceId,
    mailboxId: intent.mailboxId,
    conversationId: intent.conversationId,
    messageId: intent.messageId,
    direction: "outbound" as const,
    origin: rfcMessageId === intent.suppliedRfcMessageId ? "radioso_generated" as const : "provider_delivered" as const,
    rfcMessageId,
    subject: intent.request?.subject ?? null,
    ccAddresses: [],
    attachments: [],
    inboundDeliveryId: null,
    sendIntentId: intent.id,
  }));

/**
 * Records a provider's acceptance through the fence, with the thread index rows its Message-IDs
 * are found by, in the same transaction. One recorder for every way an acceptance arrives: the
 * provider's response to a send or re-POST (`providerSendAttempt.ts`), and a delivery event matched
 * by the Message-ID the send carried (`providerDeliveryEvents.ts`, #1619). An acceptance that
 * reaches a send the outbox already gave up on as `uncertain` is recorded on it too (FR-036): its
 * later delivery or bounce then correlates, and a teammate is not left resending mail the provider
 * already holds without knowing it. That case is logged at info, by ids only.
 */
export const recordProviderAcceptance = async (
  deps: { writer: Pick<SendIntentWriter, "apply">; logger: EmailChannelJobLogger },
  intent: EmailSendIntentRecord,
  acceptance: ProviderAcceptance,
  options: { writer: SendIntentWriterName; attempt?: number | null },
): Promise<SendIntentWriteOutcome> => {
  const written = await deps.writer.apply(intent, { kind: "provider_accepted", ...acceptance }, {
    ...options,
    onApplied: async (scope, applied) => {
      const ids = [applied.suppliedRfcMessageId, ...(applied.deliveredRfcMessageId ? [applied.deliveredRfcMessageId] : [])];
      await scope.threads.insertIndexEntries(outboundIndexEntries(applied, ids));
    },
  });
  if (written.outcome === "applied" && written.previousState === "uncertain") {
    deps.logger.info(
      { sendIntentId: intent.id, workspaceId: intent.workspaceId, conversationId: intent.conversationId, attempt: options.attempt ?? null },
      "email_send_late_acceptance",
    );
  }
  return written;
};
