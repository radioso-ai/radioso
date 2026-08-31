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
