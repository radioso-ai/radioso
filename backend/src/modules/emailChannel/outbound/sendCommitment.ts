import { parseRfcMessageId, type RfcMessageId } from "../../mail/public.js";
import { traceOperation } from "../../../shared/observability/tracing/operations.js";
import type { EmailDomainRecord, EmailDomainRepository } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord, EmailMailboxRepository } from "../persistence/emailMailboxRepository.js";
import type {
  EmailSendIntentRecord,
  EmailSendIntentRepository,
  SendRequestSnapshot,
} from "../persistence/emailSendIntentRepository.js";
import type { EmailThreadLinkRecord, EmailThreadRepository } from "../persistence/emailThreadRepository.js";
import { buildOutboundHeaders, replySubject, replyToAddress } from "./outboundHeaders.js";
import { firstAttemptAuthority, ownershipFactsOf, type SendOwnershipFacts } from "./sendAuthority.js";

/** The message a send delivers: its author and its text, read when the intent materializes and freezes. */
export interface EmailSendMessageReader {
  findByIdAndWorkspaceId(
    workspaceId: string,
    messageId: string,
  ): Promise<{ id: string; conversationId: string; content: string; source?: string | null } | null>;
}

/**
 * What a send's commitment reads and writes, bound by composition to one transaction. Each read
 * that decides the send's authority locks its row until the transaction commits, in the
 * conversation lock protocol's order (`app/composition/conversationLockOrder.ts`):
 *
 * 1. an automatic send's conversation row, then its ownership row;
 * 2. the mailbox row, then its sending domain's row, each `FOR SHARE`;
 * 3. the thread's link row `FOR SHARE`, which carries the thread's send budget;
 * 4. the send intent, by the freeze's fenced update, the last write.
 */
export interface EmailSendCommitmentScope {
  conversations: {
    /** Steps 1 and 2 of the protocol: the conversation row, then its ownership row; the ownership as it now is, null while it has none. */
    lockOwnership(input: { workspaceId: string; conversationId: string }): Promise<SendOwnershipFacts | null>;
  };
  mailboxes: Pick<EmailMailboxRepository, "lockForSend">;
  domains: Pick<EmailDomainRepository, "lockForSend">;
  threads: Pick<EmailThreadRepository, "lockLinkForSend" | "findLatestInboundThreading">;
  messages: EmailSendMessageReader;
  intents: Pick<EmailSendIntentRepository, "freezeRequest">;
}

export interface EmailSendCommitmentUnitOfWork {
  run<T>(work: (scope: EmailSendCommitmentScope) => Promise<T>): Promise<T>;
}

/** Why a send was not committed: the mailbox can no longer send as its address (`halt`), or an automatic send's authority narrowed (`revoked`). */
export type SendRefusal = Exclude<ReturnType<typeof firstAttemptAuthority>, { verdict: "allow" }>;

type SendCommitmentOutcome =
  /** The request froze: the send is committed, and the claim that froze it makes the provider call. */
  | { outcome: "frozen"; intent: EmailSendIntentRecord }
  /** The authority the send's trigger needs no longer holds; nothing was written. */
  | { outcome: "refused"; refusal: SendRefusal }
  /** Another claim moved the intent after this claim read it; the intent as it now is. */
  | { outcome: "moved"; current: EmailSendIntentRecord }
  | { outcome: "not_found" };

type FrozenRequest = SendRequestSnapshot & { body: NonNullable<SendRequestSnapshot["body"]> };

interface LockedSendFacts {
  mailbox: EmailMailboxRecord | null;
  domain: EmailDomainRecord | null;
  link: EmailThreadLinkRecord | null;
  ownership: SendOwnershipFacts;
}

const isRfcMessageId = (value: RfcMessageId | null): value is RfcMessageId => value !== null;

/**
 * The send-commitment boundary (research B6, B9; FR-025, FR-032). A send's authority is checked
 * and its request frozen in one transaction, under the locks of every row the check reads, so the
 * freeze is the moment the send is committed. A revocation — a policy change, a takeover, a budget
 * lowered, a mailbox or domain removed, a domain no longer verified — that committed before it is
 * read here and refuses the send; one that commits after it waits until the freeze has committed,
 * and only affects sends after this one. An operator-authorized send's check reads only whether the
 * mailbox may still send as its address, so it locks no conversation. The provider call is made
 * after the transaction, never inside it.
 */
export class SendCommitment {
  constructor(private readonly deps: { unitOfWork: EmailSendCommitmentUnitOfWork }) {}

  /** Checks and freezes the send this claim read unfrozen, fenced on the version it read. */
  async commit(intent: EmailSendIntentRecord): Promise<SendCommitmentOutcome> {
    return this.deps.unitOfWork.run(async (scope) => {
      const { facts, verdict } = await traceOperation({
        name: "email.send.revalidate",
        attributes: { trigger: intent.trigger, "radioso.workspace_id": intent.workspaceId, "radioso.email.send_intent_id": intent.id },
        run: async () => {
          const locked = await lockFacts(scope, intent);
          return {
            facts: locked,
            verdict: firstAttemptAuthority(intent, { ...locked, reservedAutoSends: locked.link?.autoSendsSinceRenewal ?? null }),
          };
        },
        resultAttributes: ({ verdict: checked }) => ({
          result: checked.verdict === "allow" ? "allow" : checked.verdict === "halt" ? checked.haltReason : checked.code,
        }),
      });
      if (verdict.verdict !== "allow") return { outcome: "refused", refusal: verdict };
      const frozen = await scope.intents.freezeRequest(intent.id, intent.version, await requestOf(scope, intent, facts));
      if (frozen.outcome === "applied") return { outcome: "frozen", intent: frozen.intent };
      return frozen.outcome === "conflict" ? { outcome: "moved", current: frozen.current } : { outcome: "not_found" };
    });
  }
}

/** The rows the check reads, locked in the protocol's order; only an automatic send reads its conversation's ownership. */
const lockFacts = async (scope: EmailSendCommitmentScope, intent: EmailSendIntentRecord): Promise<LockedSendFacts> => {
  const ownership = intent.trigger === "auto_reply"
    ? await scope.conversations.lockOwnership({ workspaceId: intent.workspaceId, conversationId: intent.conversationId })
    : null;
  const mailbox = await scope.mailboxes.lockForSend(intent.mailboxId);
  const domain = mailbox ? await scope.domains.lockForSend(mailbox.domainId) : null;
  const link = await scope.threads.lockLinkForSend(intent.conversationId);
  return { mailbox, domain, link, ownership: ownershipFactsOf(ownership) };
};

/** The request the send freezes: the mailbox's real address, the thread's headers and the message's text. */
const requestOf = async (
  scope: Pick<EmailSendCommitmentScope, "threads" | "messages">,
  intent: EmailSendIntentRecord,
  facts: LockedSendFacts,
): Promise<FrozenRequest> => {
  const { mailbox, domain, link } = facts;
  if (!mailbox || !domain) throw new Error("email_send_mailbox_not_found");
  if (!link) throw new Error("email_send_thread_not_found");
  const [latest, message] = await Promise.all([
    scope.threads.findLatestInboundThreading(intent.conversationId),
    scope.messages.findByIdAndWorkspaceId(intent.workspaceId, intent.messageId),
  ]);
  if (!message) throw new Error("email_send_message_not_found");
  return {
    from: { email: mailbox.address, name: mailbox.displayName },
    to: link.participantAddress,
    replyTo: replyToAddress({ address: mailbox.address, plusAddressVerified: mailbox.plusAddressVerifiedAt !== null }, link.threadToken),
    subject: replySubject(link.latestSubject),
    threading: buildOutboundHeaders({
      sendingDomain: domain.domain,
      latestInbound: {
        rfcMessageId: latest ? parseRfcMessageId(latest.rfcMessageId) : null,
        references: (latest?.referenceIds ?? []).map((id) => parseRfcMessageId(id)).filter(isRfcMessageId),
      },
      authorKind: intent.authorKind,
      newMessageUuid: intent.id,
    }),
    body: { text: message.content, html: null },
  };
};
