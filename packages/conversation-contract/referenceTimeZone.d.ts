// The zone a turn reads "today" in, carried on `TurnContext` and the engine's inputs.

/** Which input decided a turn's zone. Traces may record this; they never record the zone itself. */
export type ReferenceTimeZoneSource = "visitor" | "workspace" | "default";

/**
 * The zone a turn reads "today" in, so "tomorrow" means the visitor's tomorrow, and which input
 * decided it. The host validates `timeZone` before it rides on a turn.
 */
export interface ReferenceTimeZone {
  /** A canonical IANA zone name, such as `America/Los_Angeles`. */
  timeZone: string;
  source: ReferenceTimeZoneSource;
}
