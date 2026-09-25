import { createHash } from "node:crypto";

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

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Reviewed operation digest accepts only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Reviewed operation digest accepts JSON values only");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, item]) => item === undefined || typeof item === "function" || typeof item === "symbol")) {
      throw new TypeError("Reviewed operation digest accepts JSON values only");
    }
    return `{${entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Reviewed operation digest accepts JSON values only");
};

export const canonicalReviewedOperationDigest = (review: unknown): string =>
  createHash("sha256").update(canonicalJson(review)).digest("base64url");
