import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys in sorted order, arrays in the order given.
 *
 * Two identities in this module are content-addressed — a release's manifest digest and
 * an installation plan's checksum — and both must survive a round trip through Postgres
 * `jsonb`, which does not preserve key order. Sorting keys is what makes "the same
 * manifest" and "the same approved plan" answerable at all.
 */
const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(",")}}`;
};

/** `sha256:<64 hex>`, the digest form `@radioso/app-contract` validates. */
export const canonicalDigest = (value: unknown): string =>
  `sha256:${createHash("sha256").update(canonicalJson(value), "utf8").digest("hex")}`;
