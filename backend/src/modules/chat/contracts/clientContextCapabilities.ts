import { z } from "zod";

import { REPLY_BLOCK_LAYOUTS } from "./replyBlocks.js";

/**
 * The field schemas of `clientContextCapabilities`: what a client declares about the page it runs
 * on and what it renders. Each request schema assembles the fields it accepts and keeps its own
 * strictness.
 */

/** `page.read`: whether the client can hand the turn the page it runs on, and how much of it. */
export const pageReadCapabilitySchema = z.object({
  available: z.boolean(),
  mode: z.enum(["metadata", "content"]).nullable(),
  supportedOperations: z.array(z.enum(["metadata", "lookup", "summarize"])).max(3),
});

/**
 * `reply.blocks`: the reply block kinds the client renders, each with the layouts it draws. A
 * layout this server does not know is dropped rather than rejected, so a newer client keeps
 * working; a block kind it does not know is dropped by the request schema.
 */
export const replyBlocksCapabilitySchema = z.object({
  item_list: z.object({
    layouts: z.array(z.string().max(32)).max(16).describe(
      `The layouts the client draws an item list in: ${REPLY_BLOCK_LAYOUTS.map((layout) => `\`${layout}\``).join(", ")}. A layout left out reaches the client as \`list\`.`,
    ),
  }).optional(),
});
