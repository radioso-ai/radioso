import type { InboundEmailMessage } from "../../../mail/public.js";

export type InboundClassification = "person" | "automated_sender" | "bounce" | "self_sender" | "spam";

interface InboundClassificationInput {
  message: Pick<InboundEmailMessage, "from" | "automation" | "report" | "spamVerdict">;
  /** Lowercase addresses of the workspace's mailboxes and their relay addresses. */
  ownAddresses: ReadonlySet<string>;
  isRadiosoOutboundId: (rfcMessageId: string) => boolean;
}

interface InboundClassificationResult {
  classification: InboundClassification;
  /** Radioso outbound Message-Ids a delivery status report names; empty unless `bounce`. */
  bouncedOutboundIds: readonly string[];
}

// RFC 2076 legacy `Precedence` values cited by RFC 3834 §3.1.8. Protocol tokens, not vocabulary.
const AUTOMATED_PRECEDENCE_TOKENS: ReadonlySet<string> = new Set(["bulk", "list", "junk"]);
// RFC 3834 §5: the one `Auto-Submitted` value that marks a message as not automatic.
const NOT_AUTO_SUBMITTED_TOKEN = "no";

/** The leading token of a structured header value: lowercase, parameters and comments dropped. */
const headerToken = (value: string): string => /^\s*([^\s;(]*)/.exec(value)?.[1]?.toLowerCase() ?? "";

const hasAutomationHeaders = (automation: InboundEmailMessage["automation"]): boolean =>
  (automation.autoSubmitted !== null && headerToken(automation.autoSubmitted) !== NOT_AUTO_SUBMITTED_TOKEN)
  || (automation.precedence !== null && AUTOMATED_PRECEDENCE_TOKENS.has(headerToken(automation.precedence)))
  || automation.autoResponseSuppress !== null
  || automation.listId !== null;

const result = (classification: InboundClassification, bouncedOutboundIds: readonly string[] = []): InboundClassificationResult =>
  ({ classification, bouncedOutboundIds });

/**
 * Structural classification of an inbound message (research A12, FR-015), in a fixed order:
 * self-sender, delivery status report, RFC 3834 automation headers, provider spam verdict.
 * Subjects, bodies and authentication results are never read; forwarding routinely breaks SPF.
 */
export const classifyInbound = (input: InboundClassificationInput): InboundClassificationResult => {
  const { message } = input;

  const sender = message.from?.address.trim().toLowerCase();
  if (sender !== undefined && input.ownAddresses.has(sender)) return result("self_sender");

  if (message.report !== null) {
    const bouncedOutboundIds = message.report.originalMessageIds.filter((id) => input.isRadiosoOutboundId(id));
    return bouncedOutboundIds.length > 0 ? result("bounce", bouncedOutboundIds) : result("automated_sender");
  }

  if (hasAutomationHeaders(message.automation)) return result("automated_sender");

  // Only an explicit verdict counts; `unknown` is not spam (Resend never reports one).
  if (message.spamVerdict === "spam") return result("spam");

  return result("person");
};
