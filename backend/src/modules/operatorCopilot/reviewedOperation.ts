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
