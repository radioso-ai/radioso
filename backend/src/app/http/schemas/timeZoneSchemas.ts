import { z } from "zod";

import { TIME_ZONE_MAX_LENGTH } from "../../../shared/domain/referenceTimeZone.js";

/**
 * A caller-supplied visitor zone. Validated against the runtime's IANA zone data when the turn
 * resolves it, not here: an unknown zone is ignored and the workspace's zone applies.
 */
export const userTimeZoneSchema = z.string().trim().max(TIME_ZONE_MAX_LENGTH).describe(
  "The visitor's IANA time zone, such as America/Los_Angeles. Relative dates in the question (today, tomorrow, this weekend) resolve in it. An unknown zone is ignored and the workspace's time zone applies.",
);

/**
 * The browser's zone inside a page context. Capped by dropping (not `.max()`, which would reject
 * the whole message over one client-reported field), like the referrer beside it.
 */
export const browserTimeZoneSchema = z.string().trim().nullable().optional()
  .transform((value) => (value && value.length <= TIME_ZONE_MAX_LENGTH ? value : null));
