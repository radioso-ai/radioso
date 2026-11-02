import type { ReferenceTimeZone } from "@radioso/conversation-contract";

/** The zone relative dates resolve in when neither the visitor nor the workspace names one. */
export const DEFAULT_TIME_ZONE = "UTC";

/** Longest zone name read from a client or a setting; IANA names run to about 32 characters. */
export const TIME_ZONE_MAX_LENGTH = 64;

// The conversation contract owns the shape, so a chat turn hands its zone to the engine, routines
// and skills unchanged.
export type { ReferenceTimeZone };

// IANA names never start with a sign; `Intl` also accepts fixed offsets such as "+05:00",
// which carry no daylight-saving rules and which no browser reports as its zone.
const UTC_OFFSET_FORM = /^[+-]/;

/**
 * The canonical IANA name of `value`, or null when `value` is not a zone `Intl` knows. Never
 * throws, so a client can send anything and the turn falls back to the next source.
 */
export const canonicalTimeZone = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > TIME_ZONE_MAX_LENGTH) return null;
  try {
    const resolved = new Intl.DateTimeFormat("en-US", { timeZone: trimmed }).resolvedOptions().timeZone;
    return UTC_OFFSET_FORM.test(resolved) ? null : resolved;
  } catch {
    return null;
  }
};

/**
 * The one rule for a turn's zone: the visitor's zone when their client reports a valid one,
 * else the workspace's setting, else UTC. An invalid zone from either is ignored, not an error.
 */
export const resolveReferenceTimeZone = (input: {
  visitorTimeZone?: unknown;
  workspaceTimeZone?: unknown;
}): ReferenceTimeZone => {
  const visitor = canonicalTimeZone(input.visitorTimeZone);
  if (visitor) return { timeZone: visitor, source: "visitor" };
  const workspace = canonicalTimeZone(input.workspaceTimeZone);
  if (workspace) return { timeZone: workspace, source: "workspace" };
  return { timeZone: DEFAULT_TIME_ZONE, source: "default" };
};
