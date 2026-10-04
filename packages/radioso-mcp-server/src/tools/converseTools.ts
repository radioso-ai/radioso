import { z } from "zod";

import type { GenericToolDefinition } from "./common.js";

const askAgentSchema = z.object({
  message: z.string().trim().min(1),
});

/**
 * Used when the catalog could not be read. The composed description names the agent and its tools;
 * this one cannot, so it says only what is true of every Radioso agent.
 */
const GENERIC_ASK_AGENT_DESCRIPTION =
  "Hold a conversation with this Radioso agent. Runs the agent's full behavior — persona, directives, and multi-step routines — and continues the same conversation across calls (stateful). Use this for an interactive agent experience, not just a one-off fact lookup.";

export const createConverseToolDefinitions = (askAgentDescription?: string): GenericToolDefinition[] => [
  {
    description: askAgentDescription?.trim() || GENERIC_ASK_AGENT_DESCRIPTION,
    execute: async (args, context) => {
      if (!context.converseAdapter || !context.converseSessionToken) {
        throw new Error("No MCP converse session is bound to this request.");
      }
      const parsed = askAgentSchema.parse(args);
      const response = await context.converseAdapter.ask(context.converseSessionToken, {
        message: parsed.message,
      }, { sourceDigest: context.authInfo?.sourceDigest });
      return {
        data: response,
        summary: response.answer.text,
      };
    },
    inputSchema: askAgentSchema,
    name: "ask_agent",
  },
];
