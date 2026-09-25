import { AppError } from "../../shared/domain/errors.js";

/**
 * How a proposal's version token encodes the target's version: the ISO form of the `updated_at`
 * the draft was made against. Shared by every adapter whose target is a stored row, so the token
 * a card carries decodes back into the same instant whichever adapter wrote it.
 */
export const versionToken = (updatedAt: Date): string => updatedAt.toISOString();

export const versionDate = (token: string): Date => new Date(token);

/**
 * The instant a token names, or null for one that names none. A create's token is a constant
 * rather than a version, so an adapter handing a token to a conditional write asks for this and
 * treats the absence as a target it can no longer address.
 */
export const versionInstant = (token: string): Date | null => {
  const instant = versionDate(token);
  return Number.isNaN(instant.getTime()) ? null : instant;
};

/**
 * Whether an owning service refused a write because the target moved or went away. Both mean the
 * card describes a world that no longer exists, which an operator resolves the same way: reload
 * and decide again.
 */
export const isStale = (error: unknown): boolean =>
  error instanceof AppError && (error.code === "conflict" || error.code === "not_found");

/**
 * Whether a throw is the owner's deliberate refusal to make the requested change, as opposed to an
 * infrastructure fault. An adapter may report this as a durable `failed` outcome only once it has
 * also proven structurally (never from the error) that the refusal happened before any write or
 * inside a single transaction that rolled it back. A plain `Error`, a database fault, or a 5xx must
 * stay `uncertain` on MCP: the routine, skill, and publication reconcile paths already answer
 * `not_applied` or replay their idempotency record for a receipt that landed, so retrying the same
 * execution receipt self-heals them without ever risking a false `failed`. 429s (`tooManyRequests`,
 * `usageLimitExceeded`) are excluded because they signal the caller should slow down and retry, not
 * that the owner rejected the request.
 */
export const isOwnerRefusal = (error: unknown): error is AppError =>
  error instanceof AppError
  && !isStale(error)
  && error.statusCode >= 400
  && error.statusCode < 500
  && error.statusCode !== 429;
