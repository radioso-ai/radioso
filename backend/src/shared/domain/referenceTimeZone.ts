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
 * ICU's canonical name for `value`, or null when `value` is not a zone `Intl` knows. Never
 * throws, so a client can send anything and the turn falls back to the next source. ICU keeps
 * some older names as canonical (`Asia/Kolkata` resolves to `Asia/Calcutta`), which is fine for
 * reading today's date and keeps the zones a turn reads to a bounded set; a name to store and show
 * back is {@link chosenTimeZoneName}.
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

// The zones `Intl` lists, keyed by lower case, so a listed name written in another case is stored
// in its listed spelling. Read once: the runtime's zone data is fixed for the life of the process.
let listedTimeZones: ReadonlyMap<string, string> | undefined;

const listedSpelling = (name: string): string | undefined => {
  listedTimeZones ??= new Map(Intl.supportedValuesOf("timeZone").map((zone) => [zone.toLowerCase(), zone]));
  return listedTimeZones.get(name.toLowerCase());
};

/**
 * The name to store for a zone an operator chose: their own name for it, in the case `Intl`
 * spells it, or null when `Intl` does not know the zone. `america/los_angeles` is stored as
 * `America/Los_Angeles`, and `Asia/Kolkata` as `Asia/Kolkata`, though ICU resolves it to
 * `Asia/Calcutta`; so what the operator saved is what they read back.
 */
export const chosenTimeZoneName = (value: unknown): string | null => {
  const resolved = canonicalTimeZone(value);
  if (resolved === null || typeof value !== "string") return null;
  const chosen = value.trim();
  if (resolved.toLowerCase() === chosen.toLowerCase()) return resolved;
  return listedSpelling(chosen) ?? chosen;
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
