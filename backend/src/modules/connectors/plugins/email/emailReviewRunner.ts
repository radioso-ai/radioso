import type { ConnectorChatPort, ConnectorTurnResult } from "@radioso/connector-api";

import {
  capToSupportedMode,
  effectiveEngagementMode,
  emailMailboxPolicyRef,
  requestDrainBestEffort,
  sendingStateOf,
  type EmailChannelDrainDispatcherPort,
  type EmailDomainRepository,
  type EmailMailboxRepository,
  type EmailThreadRepository,
  type EngagementMode,
} from "../../../emailChannel/public.js";
import type { HeldReplyService, HeldReplySupersedeScope } from "../../../handoff/public.js";
import type { MetricsRegistry } from "../../../../shared/observability/metrics/metricsRegistry.js";
import { traceOperation } from "../../../../shared/observability/tracing/operations.js";
import { decidePublication, type HoldReason, type PublicationDecision } from "./emailPublicationDecision.js";

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
/** No policy version is ever this: a removed mailbox's policy matches no bound version. */
const REMOVED_POLICY_VERSION = -1;
const RECEIPT_TO_HELD_REPLY_BUCKETS = [5, 10, 30, 60, 120, 300, 600, 1_800, 3_600];

type ClaimedReview = Awaited<ReturnType<EmailThreadRepository["claimDueReviews"]>>[number];
type Mailbox = NonNullable<Awaited<ReturnType<EmailMailboxRepository["findActiveById"]>>>;

type EmailReviewOutcome =
  | "held"
  | "already_held"
  | "no_draft"
  | "human_owned"
  | "not_runnable"
  | "retrying"
  | "failed"
  | "errored";

type EmailReviewDrainResult = { claimed: number } & Record<EmailReviewOutcome, number>;

/** What a finished revision asks of its completion: nothing more, or a fresh review under the new policy. */
interface RevisionResult {
  outcome: Exclude<EmailReviewOutcome, "retrying" | "failed" | "errored">;
  reviewAgainUnder: { policyVersion: number } | null;
}

/** The conversation as the review reads it, outside the transcript. */
interface EmailReviewConversationReader {
  /** The id of the conversation's newest customer message; null when it has none. */
  latestCustomerMessageId(conversationId: string): Promise<string | null>;
  /** The conversation's ownership version now; 0 while it has no ownership row. */
  ownershipVersionOf(conversationId: string): Promise<number>;
}

/** Hands the conversation to a person with the reason, recording it, when the AI owns it. */
interface EmailReviewHandoffPort {
  requestHumanOwnership(input: { workspaceId: string; conversationId: string; reason: string }): Promise<void>;
}

/** The held-reply ports a review produces through: the producer, and the supersede of the last draft. */
type EmailReviewHeldReplies = Pick<HeldReplyService, "hold" | "findByReviewRef">
  & Pick<HeldReplySupersedeScope, "supersedePendingForConversation">;

export interface EmailReviewRunnerDependencies {
  links: Pick<EmailThreadRepository, "claimDueReviews" | "scheduleReview" | "completeReview" | "releaseReview" | "retryReviewLater">;
  mailboxes: Pick<EmailMailboxRepository, "findActiveById" | "findPolicyVersion">;
  domains: Pick<EmailDomainRepository, "findById">;
  conversations: EmailReviewConversationReader;
  chat: Pick<ConnectorChatPort, "respond">;
  heldReplies: EmailReviewHeldReplies;
  handoffs: EmailReviewHandoffPort;
  drains: EmailChannelDrainDispatcherPort;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  /** Failure and degradation lines only, with ids and codes. */
  logger: { warn(fields: Record<string, unknown>, message: string): void };
  clock: () => Date;
  config: {
    /** The modes this deployment runs (plan, Questions settled, item 4). */
    supportedModes: readonly EngagementMode[];
    /** `EMAIL_CHANNEL_REVIEW_MAX_ATTEMPTS`: the claims a review gets before it goes to a person. */
    maxAttempts: number;
    leaseSeconds?: number;
  };
}

const emptyResult = (): EmailReviewDrainResult => ({
  claimed: 0,
  held: 0,
  already_held: 0,
  no_draft: 0,
  human_owned: 0,
  not_runnable: 0,
  retrying: 0,
  failed: 0,
  errored: 0,
});

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

/** The review's idempotency ref (research B17): one held reply per conversation and revision. */
const reviewRefOf = (conversationId: string, revision: number): string => `email:${conversationId}:${revision}`;

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
 * 3. supersedes the draft an earlier revision left pending, so the thread keeps one current draft;
 * 4. runs `respond` as a review of the newest customer message, within the mailbox's history window;
 * 5. decides publication: a draft is held bound to the policy and ownership the review ran under,
 *    a draftless turn hands off, and a person's conversation is left alone;
 * 6. completes revision R only, so mail that made R+1 meanwhile keeps its due time and runs next.
 *
 * A failure retries at a backoff, and the last attempt hands the thread off as `review_unavailable`.
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
    let revision: RevisionResult;
    try {
      revision = await this.runRevision(claim);
      await this.finish(claim, revision.reviewAgainUnder);
    } catch (error) {
      return this.fail(claim, error);
    }
    return revision.outcome;
  }

  private async runRevision(claim: ClaimedReview): Promise<RevisionResult> {
    const { conversationId } = claim;
    const reviewRef = reviewRefOf(conversationId, claim.reviewRevision);
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
    const respondToMessageId = await this.deps.conversations.latestCustomerMessageId(conversationId);
    if (respondToMessageId === null) {
      throw new Error("email_review_without_customer_message");
    }

    await this.deps.heldReplies.supersedePendingForConversation(conversationId, "newer_inbound");
    const turn = await this.respond(claim, mailbox.agentId, respondToMessageId, mailbox.threadContextMessages);
    const decision = await this.decide(claim, mailbox, mode, turn);
    if (turn.kind !== "draft") {
      if (decision.kind === "no_draft" && decision.handoffReason !== null) {
        await this.handOff(claim, decision.handoffReason);
      }
      return { outcome: turn.kind, reviewAgainUnder: null };
    }

    // Automatic publication arrives with the `auto` mode (research B9); the supported-mode cap keeps
    // every decision a hold until then, and a draft is never published from here.
    const holdReason: HoldReason = decision.kind === "hold" ? decision.reason : "draft_mode";
    const held = await this.deps.heldReplies.hold({
      workspaceId: claim.workspaceId,
      conversationId,
      agentId: mailbox.agentId,
      answersMessageId: respondToMessageId,
      ownershipVersion: turn.ownershipVersion,
      policy: { ref: emailMailboxPolicyRef(mailbox.id), version: mailbox.policyVersion },
      reviewRef,
      holdReason,
      facts: turn.facts,
      draft: turn.draft,
    });
    if (held.state === "pending" && !held.duplicate) this.observeReceiptToHeldReply(claim);
    // Born superseded because the policy moved under the review: it runs again under the new one.
    const reviewAgain = held.state === "superseded" && await this.policyMoved(mailbox);
    return {
      outcome: "held",
      reviewAgainUnder: reviewAgain ? { policyVersion: claim.reviewPolicyVersion ?? mailbox.policyVersion } : null,
    };
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
    maxMessages: number,
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
        historyWindow: { maxMessages },
      }),
      resultAttributes: (result) => ({ result: result.kind }),
    });
    this.count("email_review_turns_total", "Email review turns by result, grounding and coverage.", turn.kind === "human_owned"
      ? { result: "human_owned", grounding: "none", coverage: "none" }
      : { result: turn.kind === "draft" ? "reply" : "no_reply", grounding: turn.facts.grounding, coverage: turn.facts.coverage });
    return turn;
  }

  /** The publication decision on what the turn produced, against the ownership and policy as they are now. */
  private async decide(claim: ClaimedReview, mailbox: Mailbox, mode: EngagementMode, turn: ConnectorTurnResult): Promise<PublicationDecision> {
    const [mailboxNow, ownershipVersion, domain] = await Promise.all([
      this.deps.mailboxes.findActiveById(mailbox.id),
      this.deps.conversations.ownershipVersionOf(claim.conversationId),
      this.deps.domains.findById(mailbox.domainId),
    ]);
    const decision = await traceOperation({
      name: "email.review.publication",
      attributes: this.correlation(claim),
      run: () => decidePublication({
        effectiveMode: mode,
        turn,
        sendBudget: { used: claim.autoSendsSinceRenewal, limit: mailbox.threadSendBudget },
        bound: { ownershipVersion: turn.ownershipVersion, policyVersion: mailbox.policyVersion },
        current: { ownershipVersion, policyVersion: mailboxNow?.policyVersion ?? REMOVED_POLICY_VERSION },
        sendingReady: sendingStateOf(domain) === "ok",
      }),
      resultAttributes: (decided) => ({ decision: decided.kind, reason: decisionReason(decided) }),
    });
    if (turn.kind !== "human_owned") {
      this.count("email_publication_decisions_total", "Email publication decisions by decision and reason.", {
        decision: decision.kind === "no_draft" ? "no_reply" : decision.kind,
        reason: decisionReason(decision),
      });
    }
    return decision;
  }

  private async policyMoved(mailbox: Mailbox): Promise<boolean> {
    const now = await this.deps.mailboxes.findActiveById(mailbox.id);
    return now?.policyVersion !== mailbox.policyVersion;
  }

  /**
   * Completes revision R. A newer revision is left due: its claim is let go at once, with a drain
   * asked for, rather than waiting out the lease.
   */
  private async finish(claim: ClaimedReview, reviewAgainUnder: { policyVersion: number } | null): Promise<void> {
    const { conversationId } = claim;
    if (reviewAgainUnder) {
      await this.deps.links.scheduleReview(conversationId, { dueAt: this.deps.clock(), policyVersion: reviewAgainUnder.policyVersion });
    }
    if (await this.deps.links.completeReview(conversationId, claim.reviewRevision)) return;
    await this.deps.links.releaseReview(conversationId, claim.reviewAttempts);
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
    const returned = await this.deps.links.retryReviewLater(claim.conversationId, { attempt, nextAttemptAt, errorCode: REVIEW_FAILED });
    if (returned) {
      await requestDrainBestEffort(this.deps, { maxJobs: DRAIN_BATCH, stage: "review", scheduleAt: nextAttemptAt });
    }
    return "retrying";
  }

  private handOff(claim: ClaimedReview, reason: string): Promise<void> {
    return this.deps.handoffs.requestHumanOwnership({ workspaceId: claim.workspaceId, conversationId: claim.conversationId, reason });
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
