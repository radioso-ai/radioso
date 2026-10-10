import { sendingStateOf } from "../domains/sendingState.js";
import type { EmailDomainRecord } from "../persistence/emailDomainRepository.js";
import type { EmailMailboxRecord } from "../persistence/emailMailboxRepository.js";

/** Why an operator-authorized send was halted before its first provider call (`email_send_intents.halt_reason`). */
export type SendHaltReason = "sending_not_verified" | "domain_removed" | "mailbox_removed";

type SendAuthorityVerdict = { verdict: "allow" } | { verdict: "halt"; haltReason: SendHaltReason };

interface OperatorSendAuthorityFacts {
  /** The intent's mailbox as it is now; null when it no longer exists. */
  mailbox: Pick<EmailMailboxRecord, "removedAt"> | null;
  /** The mailbox's sending domain as it is now; null when it no longer exists. */
  domain: Pick<EmailDomainRecord, "sendingStatus" | "removedAt"> | null;
}

const halt = (haltReason: SendHaltReason): SendAuthorityVerdict => ({ verdict: "halt", haltReason });

/**
 * Whether an operator-authorized send (`operator_reply`, `held_release`, `audited_resend`) may
 * still go out as the mailbox's address (research B6, FR-032). An operator authored or approved
 * the message, so only the channel's ability to send as that address is rechecked: the domain must
 * still exist and be verified for sending, and the mailbox must still exist. Engagement mode, the
 * enabled flag, ownership and the thread send budget govern automatic sends, which are authorized
 * when they materialize (research B9); an operator send renews the budget instead of spending it.
 *
 * The handler halts on a `halt` verdict before the first provider call. After an attempt with an
 * unknown outcome the same verdict only decides whether a re-POST is still authorized.
 */
export const operatorSendAuthority = (facts: OperatorSendAuthorityFacts): SendAuthorityVerdict => {
  const sending = sendingStateOf(facts.domain);
  if (sending === "domain_removed") return halt("domain_removed");
  if (!facts.mailbox || facts.mailbox.removedAt !== null) return halt("mailbox_removed");
  if (sending === "not_verified") return halt("sending_not_verified");
  return { verdict: "allow" };
};

/** Why an automatic send may no longer go out (FR-032, research B9). */
export type AutoSendAuthorityRefusal =
  | "mailbox_removed"
  | "policy_changed"
  | "mailbox_disabled"
  | "mode_not_auto"
  | "human_owned"
  | "ownership_changed"
  | "domain_removed"
  | "sending_not_verified"
  | "send_budget";

export type AutoSendVerdict = { authorized: true } | { authorized: false; code: AutoSendAuthorityRefusal };

/** The conversation's ownership as a send reads it; a conversation with no ownership row is the AI's, at version 0. */
export interface SendOwnershipFacts {
  state: "ai_owned" | "human_owned";
  version: number;
}

/** Reads a conversation's ownership for the send path; null while it has no ownership row. */
export interface EmailSendOwnershipReader {
  load(conversationId: string): Promise<SendOwnershipFacts | null>;
}

export const ownershipFactsOf = (record: SendOwnershipFacts | null): SendOwnershipFacts =>
  record ? { state: record.state, version: record.version } : { state: "ai_owned", version: 0 };

interface AutoSendAuthorityFacts {
  /** The mailbox as it is now; null when it no longer exists. */
  mailbox: Pick<EmailMailboxRecord, "removedAt" | "enabled" | "engagementMode" | "policyVersion"> | null;
  domain: Pick<EmailDomainRecord, "sendingStatus" | "removedAt"> | null;
  ownership: SendOwnershipFacts;
  /** The policy and ownership versions the review published the reply under. */
  bound: { policyVersion: number | null; ownershipVersion: number };
}

const refuse = (code: AutoSendAuthorityRefusal): AutoSendVerdict => ({ authorized: false, code });

/**
 * Whether an automatic send may still go out (FR-032, research B9): the mailbox exists, is enabled
 * and in `auto` at the policy version the reply was published under; the AI owns the conversation
 * at the ownership version it was published under; and the domain is verified for sending. Every
 * policy change writes a new version, so a downgrade or a disable since the publish refuses as
 * `policy_changed`, as does a send bound to no policy.
 */
export const autoSendAuthority = (facts: AutoSendAuthorityFacts): AutoSendVerdict => {
  const { mailbox } = facts;
  if (!mailbox || mailbox.removedAt !== null) return refuse("mailbox_removed");
  if (facts.bound.policyVersion !== mailbox.policyVersion) return refuse("policy_changed");
  if (!mailbox.enabled) return refuse("mailbox_disabled");
  if (mailbox.engagementMode !== "auto") return refuse("mode_not_auto");
  if (facts.ownership.state !== "ai_owned") return refuse("human_owned");
  if (facts.ownership.version !== facts.bound.ownershipVersion) return refuse("ownership_changed");
  const sending = sendingStateOf(facts.domain);
  if (sending === "domain_removed") return refuse("domain_removed");
  if (sending === "not_verified") return refuse("sending_not_verified");
  return { authorized: true };
};

interface AutoDispatchAuthorityFacts extends AutoSendAuthorityFacts {
  mailbox: (AutoSendAuthorityFacts["mailbox"] & Pick<EmailMailboxRecord, "threadSendBudget">) | null;
  /**
   * The thread's automatic sends since its budget was last renewed, this send's own reservation
   * among them; null when the thread has no budget to count against.
   */
  reservedAutoSends: number | null;
}

/**
 * Whether an automatic send may still go out as it is dispatched (FR-022, FR-032, research B8,
 * B9): its automatic authority still holds, and its reservation, counted with the thread's other
 * automatic sends, still fits the mailbox's `thread_send_budget` as it is now. A budget lowered
 * after the publish reserved the send refuses it as `send_budget`.
 */
export const autoDispatchAuthority = (facts: AutoDispatchAuthorityFacts): AutoSendVerdict => {
  const verdict = autoSendAuthority(facts);
  if (!verdict.authorized) return verdict;
  const budget = facts.mailbox?.threadSendBudget ?? 0;
  return facts.reservedAutoSends !== null && facts.reservedAutoSends <= budget ? verdict : refuse("send_budget");
};

/**
 * What a send is checked against before its request freezes (research B6, B9): an
 * operator-authorized send only against the mailbox's ability to send as its address; an automatic
 * one against that, and then against its automatic authority and the thread's budget, which a
 * recovered send must still hold however long ago it was materialized. `halt` stops a send the
 * channel cannot make; `revoked` an automatic send whose authority narrowed before it went out.
 */
export const firstAttemptAuthority = (
  intent: { trigger: string; authority: { policyVersion: number; ownershipVersion: number } },
  facts: Omit<AutoDispatchAuthorityFacts, "bound">,
): SendAuthorityVerdict | { verdict: "revoked"; code: AutoSendAuthorityRefusal } => {
  const operator = operatorSendAuthority(facts);
  if (operator.verdict === "halt" || intent.trigger !== "auto_reply") return operator;
  const automatic = autoDispatchAuthority({ ...facts, bound: intent.authority });
  return automatic.authorized ? operator : { verdict: "revoked", code: automatic.code };
};

/**
 * Whether a send whose earlier attempt has an unknown outcome may be re-POSTed under its key
 * (research B6): while the authority its trigger needs still holds. An automatic send needs the
 * automatic authority it was dispatched under; an operator-authorized one only the mailbox's
 * ability to send as its address. Otherwise it becomes `uncertain`, and is never queued again.
 */
export const repostAuthorized = (
  intent: { trigger: string; authority: { policyVersion: number; ownershipVersion: number } },
  facts: Omit<AutoSendAuthorityFacts, "bound">,
): boolean =>
  intent.trigger === "auto_reply"
    ? autoSendAuthority({ ...facts, bound: intent.authority }).authorized
    : operatorSendAuthority(facts).verdict === "allow";
