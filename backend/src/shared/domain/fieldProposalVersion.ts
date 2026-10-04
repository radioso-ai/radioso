import { createHash } from "node:crypto";

/** Opaque version for the exact values a field-scoped proposal depends on. */
export const fieldProposalVersion = (fields: Record<string, unknown>): string => `fields:${createHash("sha256")
  .update(JSON.stringify(Object.entries(fields).sort(([left], [right]) => left.localeCompare(right))))
  .digest("base64url")}`;
