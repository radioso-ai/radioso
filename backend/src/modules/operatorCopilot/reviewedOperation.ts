import { z } from "zod";
import type { ReviewedChangeEffect } from "../../shared/domain/reviewedChangeEffect.js";
import { canonicalContentHash } from "../../shared/domain/canonicalContentHash.js";

export type ReviewedConfirmationRequirement = "conversation" | "signed_in_approval";
export const reviewedChangeEffectSchema = z.object({
  exposure: z.enum(["draft", "live"]),
  reversibility: z.enum(["reversible", "irreversible"]),
  metered: z.boolean(),
}).strict();
export const reviewedConfirmationSchema = z.object({
  requirement: z.enum(["conversation", "signed_in_approval"]),
  effect: reviewedChangeEffectSchema,
  approvalUrl: z.string().url().max(2048).optional(),
}).strict();
export const reviewedApprovalStateSchema = z.object({
  requirement: z.enum(["conversation", "signed_in_approval"]),
  state: z.enum(["not_required", "awaiting", "approved"]),
  approvedAt: z.string().datetime().nullable(),
}).strict();

export const reviewedConfirmationRequirement = (effect: ReviewedChangeEffect): ReviewedConfirmationRequirement =>
  effect.exposure === "live" || effect.reversibility === "irreversible" || effect.metered
    ? "signed_in_approval"
    : "conversation";

/** The stored full review stays available only through the bounded, paged outcome surface. */
export const presentReviewedOperationSnapshot = (value: unknown): { readonly visible: unknown; readonly full: unknown } | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  if (!("fullReview" in snapshot)) return null;
  const { fullReview, ...visible } = snapshot;
  return { visible, full: fullReview };
};

/** sha256's unpadded base64url encoding; shared by prepare output and execute input validation. */
export const reviewedOperationDigestPattern = /^[A-Za-z0-9_-]{43}$/;

/** How long an accepted URL-elicitation retry waits for its approval before `execute_reviewed_proposal` answers (design §6 flow B). */
export const REVIEWED_APPROVAL_ACCEPT_WAIT_MS = 25_000;
/** How often the wait below re-reads the proposal's own approval state. */
export const REVIEWED_APPROVAL_POLL_INTERVAL_MS = 1_000;

/**
 * Whether a reviewed operation's own row still lacks the signed-in approval its
 * `confirmationRequirement` demands for the exact digest an execution attempt presented. Mirrors
 * `claimMcpReviewedProposalApply`'s own condition exactly (§5.3). This predicate never gates
 * anything itself -- the claim stays the only place that enforces the approval requirement; it
 * exists only so {@link awaitReviewedApproval} knows when to stop polling early.
 */
export const reviewedApprovalOutstanding = (
  proposal: {
    readonly confirmationRequirement?: ReviewedConfirmationRequirement | null;
    readonly approvedAt?: Date | null;
    readonly approvalDigest?: string | null;
  },
  reviewDigest: string,
): boolean => proposal.confirmationRequirement === "signed_in_approval"
  && (proposal.approvedAt == null || proposal.approvalDigest !== reviewDigest);

export type ReviewedApprovalPollState = "approved" | "pending" | "declined" | "expired";
export type ReviewedApprovalWaitOutcome = "approved" | "declined" | "expired" | "timed_out" | "aborted";
export interface ReviewedApprovalWaitResult {
  readonly outcome: ReviewedApprovalWaitOutcome;
  readonly waitedMs: number;
}

/**
 * Bounded, read-only poll for a reviewed operation's own approval state, used only when an MCP
 * client's accepted URL-elicitation retry asks execution to wait briefly instead of relaying
 * `approval_required` immediately (design §6 flow B: "open URL -> approve" should usually resolve
 * in the retry that follows). It never writes and never decides authorization -- the approval gate
 * stays solely inside `claimMcpReviewedProposalApply`; this only decides how long to wait before
 * that single claim attempt, never how many times to attempt it. Bounded by whichever comes first:
 * `timeoutMs`, the operation's own expiry, or `signal` aborting.
 */
export const awaitReviewedApproval = async (
  input: {
    readonly checkApproval: () => Promise<ReviewedApprovalPollState>;
    readonly timeoutMs: number;
    readonly pollIntervalMs: number;
    readonly expiresAt: Date | null;
    readonly signal?: AbortSignal;
  },
  deps: {
    readonly now: () => Date;
    readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  },
): Promise<ReviewedApprovalWaitResult> => {
  const startedAt = deps.now().getTime();
  const deadline = Math.min(
    startedAt + Math.max(0, input.timeoutMs),
    input.expiresAt ? input.expiresAt.getTime() : Infinity,
  );
  const waitedMs = () => deps.now().getTime() - startedAt;
  for (;;) {
    if (input.signal?.aborted) return { outcome: "aborted", waitedMs: waitedMs() };
    const state = await input.checkApproval();
    if (state === "approved") return { outcome: "approved", waitedMs: waitedMs() };
    if (state === "declined") return { outcome: "declined", waitedMs: waitedMs() };
    if (state === "expired") return { outcome: "expired", waitedMs: waitedMs() };
    const remaining = deadline - deps.now().getTime();
    if (remaining <= 0) return { outcome: "timed_out", waitedMs: waitedMs() };
    await deps.sleep(Math.min(input.pollIntervalMs, remaining), input.signal);
  }
};

/**
 * A proposal id alone never grants access, so one sentence answers "no such id", "not bound to this
 * grant and client", and a propose_* proposal (no review digest) alike.
 */
export const REVIEWED_OPERATION_NOT_FOUND =
  "No reviewed operation with this id is bound to this MCP connection. These tools address operations a prepare_* tool created; a proposal from a propose_* tool is approved or dismissed by a person in the dashboard.";

export const REVIEWED_OPERATION_NOT_CANCELLABLE =
  "Only a pending reviewed operation that has not started executing can be cancelled. Read its outcome with reviewed_proposal_outcome.";

export const canonicalReviewedOperationDigest = (review: unknown): string => canonicalContentHash(review);

/**
 * The non-secret join key shown to a person (as "review code") and the only digest-derived value
 * audit metadata may carry (design §5.6/§14: "no full digests"). A reviewer can match an audit
 * entry to what the approver saw without the record ever holding the full, replayable digest.
 */
export const reviewCodeFor = (reviewDigest: string): string => reviewDigest.slice(0, 8);
