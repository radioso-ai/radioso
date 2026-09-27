import { createHash } from "node:crypto";

/**
 * Renders a JSON-compatible value into one deterministic string: object keys are sorted, so the
 * same logical content hashes identically regardless of insertion order or how a store (Postgres
 * `jsonb` does not preserve object key order) chooses to return it. Deliberately strict about
 * what counts as a JSON value (no `Date`, `Map`, or other object with a non-plain prototype): a
 * caller with a live domain object round-trips it through `JSON.parse(JSON.stringify(...))`
 * first, so the hash commits to what actually gets serialized rather than to a type this function
 * would otherwise have to guess how to render.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical content hash accepts only finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Canonical content hash accepts JSON values only");
    }
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.some(([, item]) => item === undefined || typeof item === "function" || typeof item === "symbol")) {
      throw new TypeError("Canonical content hash accepts JSON values only");
    }
    return `{${entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  throw new TypeError("Canonical content hash accepts JSON values only");
};

/** sha256 over {@link canonicalJson}, unpadded base64url. Shared by any module that must hash structured content stably. */
export const canonicalContentHash = (value: unknown): string =>
  createHash("sha256").update(canonicalJson(value)).digest("base64url");
