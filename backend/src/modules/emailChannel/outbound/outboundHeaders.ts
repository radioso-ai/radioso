import {
  EmailHeaderValueError,
  headerSafeAddress,
  rfcMessageId,
  type HeaderSafeAddress,
  type OutboundThreadingHeaders,
  type RfcMessageId,
} from "../../mail/public.js";

interface OutboundHeadersInput {
  /** The mailbox's verified sending domain; the generated Message-ID lives on it (research A7). */
  sendingDomain: string;
  /** The customer message being answered, as committed in the thread index. */
  latestInbound: { rfcMessageId: RfcMessageId | null; references: readonly RfcMessageId[] };
  authorKind: "agent" | "operator";
  /** A UUID minted for this outbound message, unique per send intent. */
  newMessageUuid: string;
}

/**
 * The most ids `References` carries. A long thread keeps its root, which threads the reply under
 * the conversation's first message, and its newest ids, which carry the immediate parentage.
 */
export const REFERENCES_LIMIT = 20;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
/** Thread tokens are RFC 4648 base32 (`relayTokens.ts`), which is `atext` with no `+` of its own. */
const PLUS_TAG = /^[A-Za-z0-9]+$/u;
/**
 * RFC 5322 §3.6.5 reply marker. It is protocol syntax, not vocabulary: localized prefixes are
 * left as they are and gain a `Re:` of their own.
 */
const RFC_REPLY_PREFIX = /^re:/iu;
const BARE_REPLY_SUBJECT = "Re:";
const CONTROL_CHARACTERS = /\p{Cc}/gu;
const WHITESPACE_RUN = /\s+/gu;

const uniqueInOrder = (ids: readonly RfcMessageId[]): RfcMessageId[] => [...new Set(ids)];

const trimReferences = (ids: readonly RfcMessageId[]): RfcMessageId[] => {
  if (ids.length <= REFERENCES_LIMIT) return [...ids];
  const [root] = ids;
  return root === undefined ? [] : [root, ...ids.slice(ids.length - (REFERENCES_LIMIT - 1))];
};

/**
 * Threading headers for one outbound email (FR-033, FR-034): a fresh Message-ID on the sending
 * domain, `In-Reply-To` the latest inbound message, `References` its chain plus that message
 * (RFC 5322 §3.6.4), and `Auto-Submitted: auto-generated` on agent-authored mail only (RFC 3834).
 */
export const buildOutboundHeaders = (input: OutboundHeadersInput): OutboundThreadingHeaders => {
  if (!UUID.test(input.newMessageUuid)) {
    throw new Error("The new outbound message identifier must be a UUID.");
  }
  const parent = input.latestInbound.rfcMessageId;
  const chain = parent === null ? input.latestInbound.references : [...input.latestInbound.references, parent];
  return {
    messageId: rfcMessageId(`<${input.newMessageUuid}@${input.sendingDomain.toLowerCase()}>`),
    inReplyTo: parent,
    references: trimReferences(uniqueInOrder(chain)),
    autoSubmitted: input.authorKind === "agent" ? "auto-generated" : null,
  };
};

/**
 * The subject continuing the thread: the latest subject on one header line, with the RFC `Re:`
 * prefix added unless it already starts with one.
 */
export const replySubject = (latestSubject: string | null): string => {
  const subject = (latestSubject ?? "").replace(CONTROL_CHARACTERS, " ").replace(WHITESPACE_RUN, " ").trim();
  if (subject === "") return BARE_REPLY_SUBJECT;
  return RFC_REPLY_PREFIX.test(subject) ? subject : `${BARE_REPLY_SUBJECT} ${subject}`;
};

/**
 * `Reply-To` for an outbound email: the mailbox's real address, carrying the conversation's thread
 * token as a plus tag only once the setup check has proven plus-addressed mail reaches the relay
 * (research A9). Until then the bare address keeps a tenant without plus addressing from bouncing
 * the customer's reply, and threading rests on Message-IDs alone.
 */
export const replyToAddress = (
  mailbox: { address: string; plusAddressVerified: boolean },
  threadToken: string,
): HeaderSafeAddress => {
  const address = headerSafeAddress(mailbox.address);
  if (!mailbox.plusAddressVerified) return address;
  if (!PLUS_TAG.test(threadToken)) {
    throw new EmailHeaderValueError("address", "malformed");
  }
  const at = address.lastIndexOf("@");
  return headerSafeAddress(`${address.slice(0, at)}+${threadToken}${address.slice(at)}`);
};
