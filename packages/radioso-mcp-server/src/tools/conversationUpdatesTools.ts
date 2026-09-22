import { z } from "zod";

import type { GenericToolDefinition } from "./common.js";

/**
 * 25 s is the backend's ceiling. It sits far inside Node's default 300 s
 * `requestTimeout` and Cloud Run's default 300 s service timeout, so no deployment
 * setting has to change for a caller to use the whole window; `headersTimeout` (60 s)
 * bounds how long a client may take to send request headers, not how long the response
 * may take.
 */
const MAX_WAIT_MS = 25_000;

const conversationUpdatesSchema = z.object({
  cursor: z.string().trim().min(1).optional(),
  waitMs: z.number().int().min(0).max(MAX_WAIT_MS).optional(),
});

/**
 * Resumption: an agent that cannot sit in a chat comes back for what happened since
 * its cursor — including a human's reply after a handoff. The cursor is opaque and
 * comes from a previous response; with no cursor the call returns the conversation's
 * most recent page.
 */
export const createConversationUpdatesToolDefinitions = (): GenericToolDefinition[] => [
  {
    description:
      "Read what has happened in this conversation since a cursor, and optionally wait for "
      + "something to happen. Each message says whether a human or the agent wrote it, and the "
      + "reply carries the conversation's current ownership: `human_owned` means a person has "
      + "taken over and is answering. Use this after ask_agent hands off to a person — pass the "
      + "`cursor` from the previous reply and a `waitMs` up to 25000 to wait for the answer. "
      + "An empty list at the deadline means nothing new yet, not a failure.",
    execute: async (args, context) => {
      if (!context.converseAdapter || !context.converseSessionToken) {
        throw new Error("No MCP converse session is bound to this request.");
      }
      const parsed = conversationUpdatesSchema.parse(args);
      const response = await context.converseAdapter.messages(
        context.converseSessionToken,
        {
          ...(parsed.cursor ? { cursor: parsed.cursor } : {}),
          ...(parsed.waitMs === undefined ? {} : { waitMs: parsed.waitMs }),
        },
        { sourceDigest: context.authInfo?.sourceDigest },
      );
      return {
        data: response,
        summary: response.messages.length === 0
          ? `No new messages; the conversation is ${response.ownership.state}.`
          : `${response.messages.length} new message(s); the conversation is ${response.ownership.state}.`,
      };
    },
    inputSchema: conversationUpdatesSchema,
    name: "get_conversation_updates",
  },
];
