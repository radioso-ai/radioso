import type { ConnectorChatPort, ConnectorTurnResult } from "@radioso/connector-api";

import type { ConversationActivityWriter } from "../../../conversationActivity/contracts/index.js";
import {
  capToSupportedMode,
  effectiveEngagementMode,
  emailMailboxPolicyRef,
  requestDrainBestEffort,
  sendingStateOf,
  type EmailChannelDrainDispatcherPort,
  type EmailDomainRepository,
  type EmailInboundRepository,
  type EmailMailboxRepository,
  type EmailThreadRepository,
  type EngagementMode,
} from "../../../emailChannel/public.js";
import type { HeldReplyProducerPort, QueueAutoInput } from "../../../handoff/public.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";
import { decidePublication, type HoldReason, type PublicationDecision } from "./emailPublicationDecision.js";
import { factsWithCompleteness, type EmailReplyCompletenessPort, type ReplyCompleteness } from "./emailReplyCompleteness.js";
import type { EmailReplyTriagePort } from "./emailReplyTriage.js";
import type { EmailReviewSubject } from "./emailReviewChecks.js";

/** Waits before attempts 2, 3 and 4 of a failed review (research B7); later ones wait the longest. */
const RETRY_DELAYS_SECONDS: readonly number[] = [30, 120, 600];
const DEFAULT_LEASE_SECONDS = 300;
/** Reviews one pushed drain asks the worker to claim. */
const DRAIN_BATCH = 5;
const REVIEW_FAILED = "review_failed";
/** The hand-off when no review could produce a reply (research B3, B7). */
const REVIEW_UNAVAILABLE = "review_unavailable";
/** The hand-off when the mailbox no longer lets the agent answer, as at ingest (FR-018). */
const OPERATOR_ONLY_MAILBOX = "operator_only_mailbox";
/** The hand-off when the mailbox's hourly generation budget is spent, as at ingest (FR-023). */
const GENERATION_BUDGET = "generation_budget";
/** The thread note when the reply triage found that the customer's mail needs no reply (FR-017a). */
const NO_REPLY_NEEDED = "no_reply_needed";
/** No policy version is ever this: a removed mailbox's policy matches no bound version. */
const REMOVED_POLICY_VERSION = -1;
const RECEIPT_TO_HELD_REPLY_BUCKETS = [5, 10, 30, 60, 120, 300, 600, 1_800, 3_600];
/**
 * The thread's newest messages a review turn reads, the answered one included (FR-024). The turn's
 * history window counts only the messages before the answered one, so it asks for one fewer.
 */
const EMAIL_REVIEW_THREAD_MESSAGES = 10;
const EMAIL_REVIEW_PRECEDING_MESSAGES = EMAIL_REVIEW_THREAD_MESSAGES - 1;
/** The claims a review gets before its conversation goes to a person with `review_unavailable`. */
export const EMAIL_REVIEW_MAX_ATTEMPTS = 4;

type ClaimedReview = Awaited<ReturnType<EmailThreadRepository["claimDueReviews"]>>[number];
type ReviewClaim = Parameters<EmailThreadRepository["releaseReview"]>[0];
type Mailbox = NonNullable<Awaited<ReturnType<EmailMailboxRepository["findActiveById"]>>>;

type EmailReviewOutcome =
  | "held"
  | "queued_auto"
  | "already_held"
  | "no_reply_needed"
  | "no_draft"
  | "human_owned"
  | "not_runnable"
  | "budget_exhausted"
  | "retrying"
  | "failed"
  /** Another worker took the claim over after this one's lease ran out; this one did nothing more. */
  | "reclaimed"
  | "errored";

type EmailReviewDrainResult = { claimed: number } & Record<EmailReviewOutcome, number>;

/**
 * What a finished revision asks of its completion: nothing more, or a fresh review under the new
 * policy; `completed` when the revision was already completed with what it decided.
 */
interface RevisionResult {
  outcome: Exclude<EmailReviewOutcome, "retrying" | "failed" | "reclaimed" | "errored">;
  reviewAgainUnder: { policyVersion: number } | null;
  completed?: boolean;
}

/** The conversation as the review reads it, outside the transcript. */
interface EmailReviewConversationReader {
  /** The id of the conversation's newest customer message; null when it has none. */
  latestCustomerMessageId(conversationId: string): Promise<string | null>;
  /** The conversation's ownership version now; 0 while it has no ownership row. */
  ownershipVersionOf(conversationId: string): Promise<number>;
  /** Whether a person owns the conversation now. */
  humanOwned(conversationId: string): Promise<boolean>;
}

/** Hands the conversation to a person with the reason, recording it, when the AI owns it. */
interface EmailReviewHandoffPort {
  requestHumanOwnership(input: { workspaceId: string; conversationId: string; reason: string }): Promise<void>;
}

/**
 * The model checks around a review turn, read on each call: whether the customer's mail calls for a
 * reply at all, and whether a reply about to be sent automatically answers everything asked.
 */
export interface EmailReviewChecks {
  replyTriage: EmailReplyTriagePort;
  replyCompleteness: EmailReplyCompletenessPort;
}

/**
 * The writes a revision decided without a turn that must commit together (research B17): its
 * completion under the claim, and the note on the thread that says why the customer's newest email
 * was set aside, named by the delivery it came in on.
 */
export interface EmailReviewRevisionScope {
  threads: Pick<EmailThreadRepository, "completeReview">;
  inbound: Pick<EmailInboundRepository, "findDeliveryIdForMessage">;
  activity: ConversationActivityWriter;
}

/** One revision's writes in one transaction, bound by composition. */
export interface EmailReviewRevisionUnitOfWork {
  run<T>(work: (scope: EmailReviewRevisionScope) => Promise<T>): Promise<T>;
}

/**
 * The held-reply producer a review publishes through. It supersedes nothing: the host's ingest
 * supersedes a draft a newer customer message made stale, and a held reply answering an older
 * message is born superseded, so a review never touches another claim's result.
 */
type EmailReviewHeldReplies = Pick<HeldReplyProducerPort, "hold" | "queueAuto" | "findByReviewRef">;

/** This worker's claim was taken over after its lease ran out: it stops, doing nothing more. */
class ReviewClaimLost extends Error {
  constructor() {
    super("email_review_claim_lost");
    this.name = "ReviewClaimLost";
  }
}

/** Why queueing was refused when the claim still holds: the result is then held for a teammate. */
type QueueAutoRefusal = Exclude<Extract<Awaited<ReturnType<HeldReplyProducerPort["queueAuto"]>>, { ok: false }>["refused"], "claim_lost">;

/**
 * Why an answer the decision published waits for a teammate once queueing it was refused (research
 * B9, B16): the ownership or the policy it was bound to moved, a newer customer message replaced
 * it, or the thread's sends were spent meanwhile. The hold records it under the same binding, so a
 * moved binding is born superseded and a moved policy is reviewed again.
 */
const HOLD_REASON_FOR_REFUSAL: Record<QueueAutoRefusal, HoldReason> = {
  ownership_changed: "authority_changed",
  policy_changed: "authority_changed",
  superseded: "authority_changed",
  send_budget: "send_budget",
};

export interface EmailReviewRunnerDependencies {
  links: Pick<
    EmailThreadRepository,
    "claimDueReviews" | "holdsReviewClaim" | "scheduleReview" | "completeReview" | "releaseReview" | "retryReviewLater"
  >;
  mailboxes: Pick<EmailMailboxRepository, "findActiveById" | "findPolicyVersion" | "reserveGeneration">;
  domains: Pick<EmailDomainRepository, "findById">;
  conversations: EmailReviewConversationReader;
  chat: Pick<ConnectorChatPort, "respond">;
  heldReplies: EmailReviewHeldReplies;
  handoffs: EmailReviewHandoffPort;
  checks: EmailReviewChecks;
  /** A set-aside revision's note and completion, together. */
  revisions: EmailReviewRevisionUnitOfWork;
  drains: EmailChannelDrainDispatcherPort;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  /** A line per completed review, and failure and degradation lines; ids and codes only. */
  logger: {
    info(fields: Record<string, unknown>, message: string): void;
    warn(fields: Record<string, unknown>, message: string): void;
  };
  clock: () => Date;
  config: {
    /** The modes this deployment runs (plan, Questions settled, item 4). */
    supportedModes: readonly EngagementMode[];
    /** The claims a review gets before it goes to a person: `EMAIL_REVIEW_MAX_ATTEMPTS` in a deployment. */
    maxAttempts: number;
    leaseSeconds?: number;
  };
}

const emptyResult = (): EmailReviewDrainResult => ({
  claimed: 0,
  held: 0,
  queued_auto: 0,
  already_held: 0,
  no_reply_needed: 0,
  no_draft: 0,
  human_owned: 0,
  not_runnable: 0,
  budget_exhausted: 0,
  retrying: 0,
  failed: 0,
  reclaimed: 0,
  errored: 0,
});

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The review's idempotency ref (research B17): one held reply per conversation and revision. */
const reviewRefOf = (conversationId: string, revision: number): string => `email:${conversationId}:${revision}`;

const reviewClaimOf = (claim: ClaimedReview): ReviewClaim => ({
  conversationId: claim.conversationId,
  attempt: claim.reviewAttempts,
  leaseUntil: claim.reviewLeaseUntil,
});

/** The claim a review's result is published under: email's scope checks it in the publishing transaction. */
const publicationClaimOf = (claim: ClaimedReview): NonNullable<QueueAutoInput["reviewClaim"]> => ({
  attempt: claim.reviewAttempts,
  leaseUntil: claim.reviewLeaseUntil,
});

const decisionReason = (decision: PublicationDecision): string => {
  if (decision.kind === "hold") return decision.reason;
  return decision.kind === "no_draft" ? decision.handoffReason ?? "human_owned" : "none";
};

/**
 * Stage 2 of the email channel (research B7, B17): one coalesced review per thread revision. For
 * each thread whose review is due it claims the link under a lease and reads revision R, then:
 *
 * 1. finishes at once when R's review ref is already held, because an earlier claim got that far;
 * 2. hands the thread to a person, running nothing, when the mailbox no longer lets the agent
 *    answer — the lower-autonomy mode of the accepted and the current policy (research B16);
 * 3. leaves a conversation a person owns to them, running and charging nothing;
 * 4. charges revision R to the mailbox's generation budget, once across attempts, and hands the
 *    thread to a person as `generation_budget`, running nothing, when the budget is spent (B8);
 * 5. asks the reply triage whether the customer's unanswered mail calls for a reply; a clear `no`
 *    runs no turn, holds nothing and asks no teammate, and leaves a note on the thread (FR-017a),
 *    committed with R's completion, so a retry finds R done rather than judging it again;
 * 6. runs `respond` as a review of the newest customer message, within the mailbox's history window;
 * 7. decides publication: a draft is queued for an automatic send or held, either bound to the
 *    policy and ownership the review ran under; a draftless turn hands off, and a person's
 *    conversation is left alone. A draft every other gate would publish is first checked for
 *    completeness, once, and held as `incomplete_answer` unless it answers everything asked. A
 *    queued send writes no message: it is materialized at dispatch (research B9), and a send the
 *    held-reply service refuses to queue is held instead;
 * 8. completes revision R only, so mail that made R+1 meanwhile keeps its due time and runs next.
 *
 * Every write is the claim's: a worker whose lease ran out and was claimed over checks its claim
 * before it charges or hands off, publishes only while the held-reply transaction finds the claim
 * still holding under the thread's lock, and its completion, release and retry are fenced on the
 * claim, so it stops without touching what the claim that took over decided. A failure retries
 * at a backoff, and the last attempt hands the thread off as `review_unavailable`.
 */
export class EmailReviewRunner {
  constructor(private readonly deps: EmailReviewRunnerDependencies) {}

  /** Claims up to `maxJobs` due reviews and runs each. */
  async runDue(request: { maxJobs: number }): Promise<EmailReviewDrainResult> {
    const result = emptyResult();
    const claims = await this.deps.links.claimDueReviews({
      limit: request.maxJobs,
      leaseSeconds: this.deps.config.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
    });
    for (const claim of claims) {
      result.claimed += 1;
      try {
        result[await this.review(claim)] += 1;
      } catch (error) {
        // Not even the failure could be recorded; the lease runs out and a later claim retries.
        result.errored += 1;
        this.deps.logger.warn(
          { ...this.ids(claim), attempt: claim.reviewAttempts, errorName: errorName(error) },
          "email_review_errored",
        );
      }
    }
    return result;
  }

  private async review(claim: ClaimedReview): Promise<EmailReviewOutcome> {
    try {
      return await this.reviewClaimed(claim);
    } catch (error) {
      if (!(error instanceof ReviewClaimLost)) throw error;
      this.deps.logger.warn({ ...this.ids(claim), revision: claim.reviewRevision, attempt: claim.reviewAttempts }, "email_review_claim_lost");
      return "reclaimed";
    }
  }

  private async reviewClaimed(claim: ClaimedReview): Promise<EmailReviewOutcome> {
    let revision: RevisionResult;
    try {
      revision = await this.runRevision(claim);
      if (!revision.completed) await this.finish(claim, revision.reviewAgainUnder);
    } catch (error) {
      if (error instanceof ReviewClaimLost) throw error;
      return this.fail(claim, error);
    }
    this.deps.logger.info(
      {
        ...this.ids(claim),
        mailboxId: claim.mailboxId,
        revision: claim.reviewRevision,
        attempt: claim.reviewAttempts,
        outcome: revision.outcome,
        reviewAgain: revision.reviewAgainUnder !== null,
      },
      "email_review_completed",
    );
    return revision.outcome;
  }

  private async runRevision(claim: ClaimedReview): Promise<RevisionResult> {
    const { conversationId } = claim;
    const reviewRef = reviewRefOf(conversationId, claim.reviewRevision);
    // An earlier claim got as far as R's result: R only needs completing, and nothing is redone.
    if (await this.deps.heldReplies.findByReviewRef(conversationId, reviewRef)) {
      return { outcome: "already_held", reviewAgainUnder: null };
    }
    const mailbox = await this.deps.mailboxes.findActiveById(claim.mailboxId);
    if (!mailbox) {
      await this.handOff(claim, REVIEW_UNAVAILABLE);
      return { outcome: "not_runnable", reviewAgainUnder: null };
    }
    const mode = await this.effectiveMode(mailbox, claim.reviewPolicyVersion);
    if (mode === "operator_only" || mailbox.agentId === null) {
      await this.handOff(claim, OPERATOR_ONLY_MAILBOX);
      return { outcome: "not_runnable", reviewAgainUnder: null };
    }
    // A person's conversation needs no triage and no turn, so it spends none of the mailbox's
    // generation budget; a takeover after this check is still caught by the host's turn.
    if (await this.deps.conversations.humanOwned(conversationId)) {
      return { outcome: "human_owned", reviewAgainUnder: null };
    }
    const respondToMessageId = await this.deps.conversations.latestCustomerMessageId(conversationId);
    if (respondToMessageId === null) {
      throw new Error("email_review_without_customer_message");
    }
    await this.ensureClaimed(claim);
    if (!(await this.reserveGeneration(claim))) {
      await this.handOff(claim, GENERATION_BUDGET);
      return { outcome: "budget_exhausted", reviewAgainUnder: null };
    }
    const subject = this.subjectOf(claim, mailbox.agentId);
    const setAside = await this.setAsideWithoutReply(claim, subject, respondToMessageId);
    if (setAside !== null) {
      return { outcome: "no_reply_needed", reviewAgainUnder: null, completed: setAside.completed };
    }

    await this.ensureClaimed(claim);
    const turn = await this.respond(claim, mailbox.agentId, respondToMessageId);
    // The turn takes the longest: a claim taken over meanwhile publishes and hands off nothing.
    await this.ensureClaimed(claim);
    const { decision, completeness } = await this.decide(claim, mailbox, mode, turn, subject);
    if (turn.kind !== "draft") {
      if (decision.kind === "no_draft" && decision.handoffReason !== null) {
        await this.handOff(claim, decision.handoffReason);
      }
      return { outcome: turn.kind, reviewAgainUnder: null };
    }

    const result: QueueAutoInput = {
      workspaceId: claim.workspaceId,
      conversationId,
      agentId: mailbox.agentId,
      answersMessageId: respondToMessageId,
      ownershipVersion: turn.ownershipVersion,
      policy: { ref: emailMailboxPolicyRef(mailbox.id), version: mailbox.policyVersion },
      reviewRef,
      reviewClaim: publicationClaimOf(claim),
      // An incomplete verdict shows as the held reply's coverage, so a teammate reads why it waits.
      facts: factsWithCompleteness(turn.facts, completeness),
      draft: turn.draft,
    };
    if (decision.kind === "publish") {
      const queued = await this.deps.heldReplies.queueAuto(result);
      if (queued.ok) return { outcome: "queued_auto", reviewAgainUnder: null };
      if (queued.refused === "claim_lost") throw new ReviewClaimLost();
      this.count("email_auto_queue_refusals_total", "Automatic sends the held-reply service refused to queue, by refusal.", {
        refused: queued.refused,
      });
      return this.holdResult(claim, mailbox, result, HOLD_REASON_FOR_REFUSAL[queued.refused]);
    }
    // A draft always decides publish or hold; anything else fails closed as a hold.
    return this.holdResult(claim, mailbox, result, decision.kind === "hold" ? decision.reason : "outcome_not_publishable");
  }

  /**
   * Sets the customer's mail aside when the reply triage finds it needs no reply; null when it does
   * not. Only a clear `no` silences: `unsure` and a failed triage run the review. The verdict is
   * committed as R's completion and the thread's note in one unit, under the claim, so a retry finds
   * R done instead of judging it again, and nothing is noted unless R completes. A revision newer
   * mail overtook is not completed and gets no note: the newer one judges all of the mail.
   */
  private async setAsideWithoutReply(
    claim: ClaimedReview,
    subject: EmailReviewSubject,
    messageId: string,
  ): Promise<{ completed: boolean } | null> {
    if ((await this.deps.checks.replyTriage.assess(subject)) !== "no") return null;
    const completed = await this.deps.revisions.run(async (scope) => {
      if (!(await scope.threads.completeReview({ ...reviewClaimOf(claim), revision: claim.reviewRevision }))) return false;
      const deliveryId = await scope.inbound.findDeliveryIdForMessage(subject.conversationId, messageId);
      if (!deliveryId) throw new Error("email_review_note_without_delivery");
      await scope.activity.record({
        conversationId: subject.conversationId,
        workspaceId: subject.workspaceId,
        kind: "channel_exception",
        actorUserId: null,
        detail: { code: NO_REPLY_NEEDED, deliveryId },
      });
      return true;
    });
    return { completed };
  }

  /** Holds the review's result for a teammate, and asks for a fresh review when its policy moved under it. */
  private async holdResult(
    claim: ClaimedReview,
    mailbox: Mailbox,
    result: QueueAutoInput,
    holdReason: HoldReason,
  ): Promise<RevisionResult> {
    const held = await this.deps.heldReplies.hold({ ...result, holdReason });
    if ("refused" in held) throw new ReviewClaimLost();
    if (held.state === "pending" && !held.duplicate) this.observeReceiptToHeldReply(claim);
    // Born superseded because the policy moved under the review: it runs again under the new one.
    const reviewAgain = held.state === "superseded" && await this.policyMoved(mailbox);
    return {
      outcome: "held",
      reviewAgainUnder: reviewAgain ? { policyVersion: claim.reviewPolicyVersion ?? mailbox.policyVersion } : null,
    };
  }

  /** Charges revision R to the mailbox's generation budget (research B8); false when the budget is spent. */
  private async reserveGeneration(claim: ClaimedReview): Promise<boolean> {
    const reservation = await this.deps.mailboxes.reserveGeneration({
      mailboxId: claim.mailboxId,
      conversationId: claim.conversationId,
      revision: claim.reviewRevision,
      at: this.deps.clock(),
    });
    if (reservation !== "exhausted") return true;
    this.count("email_budget_hits_total", "Automatic email behavior a budget stopped, by budget.", { budget: "mailbox_generation" });
    return false;
  }

  /** The accepted policy of the newest coalesced delivery against the current one, capped to the deployment's modes. */
  private async effectiveMode(mailbox: Mailbox, acceptedVersion: number | null): Promise<EngagementMode> {
    const accepted = acceptedVersion === null ? null : await this.deps.mailboxes.findPolicyVersion(mailbox.id, acceptedVersion);
    const current = { mode: mailbox.engagementMode, enabled: mailbox.enabled };
    const effective = effectiveEngagementMode(accepted ? { mode: accepted.engagementMode, enabled: accepted.enabled } : current, current);
    return effective.enabled ? capToSupportedMode(effective.mode, this.deps.config.supportedModes) : "operator_only";
  }

  private async respond(
    claim: ClaimedReview,
    agentId: string,
    respondToMessageId: string,
  ): Promise<ConnectorTurnResult> {
    const turn = await traceOperation({
      name: "email.review.turn",
      attributes: { ...this.correlation(claim), execution_mode: "review" },
      run: () => this.deps.chat.respond({
        workspaceId: claim.workspaceId,
        agentId,
        conversationId: claim.conversationId,
        respondToMessageId,
        executionMode: "review",
        historyWindow: { maxMessages: EMAIL_REVIEW_PRECEDING_MESSAGES },
      }),
      resultAttributes: (result) => ({ result: result.kind }),
    });
    this.count("email_review_turns_total", "Email review turns by result, grounding and coverage.", turn.kind === "human_owned"
      ? { result: "human_owned", grounding: "none", coverage: "none" }
      : { result: turn.kind === "draft" ? "reply" : "no_reply", grounding: turn.facts.grounding, coverage: turn.facts.coverage });
    return turn;
  }

  /**
   * The publication decision on what the turn produced, against the ownership and policy as they
   * are now. A draft every other gate would publish is checked for completeness, at most once, and
   * decided again on the verdict; no other draft is checked.
   */
  private async decide(
    claim: ClaimedReview,
    mailbox: Mailbox,
    mode: EngagementMode,
    turn: ConnectorTurnResult,
    subject: EmailReviewSubject,
  ): Promise<{ decision: PublicationDecision; completeness: ReplyCompleteness | null }> {
    const [mailboxNow, ownershipVersion, domain] = await Promise.all([
      this.deps.mailboxes.findActiveById(mailbox.id),
      this.deps.conversations.ownershipVersionOf(claim.conversationId),
      this.deps.domains.findById(mailbox.domainId),
    ]);
    const decideWith = (completeness: ReplyCompleteness | null) => traceOperation({
      name: "email.review.publication",
      attributes: this.correlation(claim),
      run: () => decidePublication({
        effectiveMode: mode,
        turn,
        sendBudget: { used: claim.autoSendsSinceRenewal, limit: mailbox.threadSendBudget },
        bound: { ownershipVersion: turn.ownershipVersion, policyVersion: mailbox.policyVersion },
        current: { ownershipVersion, policyVersion: mailboxNow?.policyVersion ?? REMOVED_POLICY_VERSION },
        sendingReady: sendingStateOf(domain) === "ok",
        completeness,
      }),
      resultAttributes: (decided) => ({ decision: decided.kind, reason: decisionReason(decided) }),
    });
    let completeness: ReplyCompleteness | null = null;
    let decision = await decideWith(null);
    if (decision.kind === "check_completeness" && turn.kind === "draft") {
      ({ completeness } = await this.deps.checks.replyCompleteness.assess({ ...subject, draft: turn.draft }));
      decision = await decideWith(completeness);
    }
    if (turn.kind !== "human_owned") {
      this.count("email_publication_decisions_total", "Email publication decisions by decision and reason.", {
        decision: decision.kind === "no_draft" ? "no_reply" : decision.kind,
        reason: decisionReason(decision),
      });
    }
    return { decision, completeness };
  }

  private async policyMoved(mailbox: Mailbox): Promise<boolean> {
    const now = await this.deps.mailboxes.findActiveById(mailbox.id);
    return now?.policyVersion !== mailbox.policyVersion;
  }

  /**
   * Completes revision R under the claim. A newer revision is left due: its claim is let go at once,
   * with a drain asked for, rather than waiting out the lease. A claim taken over does neither.
   */
  private async finish(claim: ClaimedReview, reviewAgainUnder: { policyVersion: number } | null): Promise<void> {
    const { conversationId } = claim;
    if (reviewAgainUnder) {
      await this.ensureClaimed(claim);
      await this.deps.links.scheduleReview(conversationId, { dueAt: this.deps.clock(), policyVersion: reviewAgainUnder.policyVersion });
    }
    if (await this.deps.links.completeReview({ ...reviewClaimOf(claim), revision: claim.reviewRevision })) return;
    if (!(await this.deps.links.releaseReview(reviewClaimOf(claim)))) throw new ReviewClaimLost();
    await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "review" });
  }

  private async fail(claim: ClaimedReview, error: unknown): Promise<EmailReviewOutcome> {
    const attempt = claim.reviewAttempts;
    this.deps.logger.warn({ ...this.ids(claim), attempt, errorName: errorName(error) }, "email_review_turn_failed");
    this.count("email_review_turns_total", "Email review turns by result, grounding and coverage.", {
      result: "error",
      grounding: "none",
      coverage: "none",
    });
    if (attempt >= this.deps.config.maxAttempts) {
      await this.handOff(claim, REVIEW_UNAVAILABLE);
      await this.finish(claim, null);
      return "failed";
    }
    const delaySeconds = RETRY_DELAYS_SECONDS[attempt - 1] ?? RETRY_DELAYS_SECONDS[RETRY_DELAYS_SECONDS.length - 1];
    const nextAttemptAt = new Date(this.deps.clock().getTime() + delaySeconds * 1000);
    const returned = await this.deps.links.retryReviewLater(reviewClaimOf(claim), { nextAttemptAt, errorCode: REVIEW_FAILED });
    if (!returned) throw new ReviewClaimLost();
    await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "review", scheduleAt: nextAttemptAt });
    return "retrying";
  }

  /** Hands the thread to a person, only while this worker still holds its claim. */
  private async handOff(claim: ClaimedReview, reason: string): Promise<void> {
    await this.ensureClaimed(claim);
    await this.deps.handoffs.requestHumanOwnership({ workspaceId: claim.workspaceId, conversationId: claim.conversationId, reason });
  }

  /** Stops this worker when another claimed its review after its lease ran out. */
  private async ensureClaimed(claim: ClaimedReview): Promise<void> {
    if (!(await this.deps.links.holdsReviewClaim(reviewClaimOf(claim)))) throw new ReviewClaimLost();
  }

  private observeReceiptToHeldReply(claim: ClaimedReview): void {
    if (!claim.latestInboundAt) return;
    this.deps.metrics?.observeHistogram("email_receipt_to_held_reply_seconds", {
      help: "Seconds from the newest customer email to its held reply.",
      labels: {},
      value: Math.max(0, (this.deps.clock().getTime() - claim.latestInboundAt.getTime()) / 1000),
      buckets: RECEIPT_TO_HELD_REPLY_BUCKETS,
    });
  }

  private subjectOf(claim: ClaimedReview, agentId: string): EmailReviewSubject {
    return {
      workspaceId: claim.workspaceId,
      agentId,
      conversationId: claim.conversationId,
      revision: claim.reviewRevision,
      attempt: claim.reviewAttempts,
    };
  }

  private ids(claim: ClaimedReview): { conversationId: string; workspaceId: string } {
    return { conversationId: claim.conversationId, workspaceId: claim.workspaceId };
  }

  private correlation(claim: ClaimedReview): Record<string, string> {
    return { "radioso.workspace_id": claim.workspaceId, "radioso.conversation_id": claim.conversationId };
  }

  private count(name: string, help: string, labels: Record<string, string>): void {
    this.deps.metrics?.incrementCounter(name, { help, labels });
  }
}
