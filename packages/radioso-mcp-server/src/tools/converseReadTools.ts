import { z } from "zod";

import type { GenericToolDefinition } from "./common.js";
import type { ToolExecutionContext } from "../types.js";

const answerGroundedSchema = z.object({
  query: z.string().trim().min(1),
  maxResults: z.number().int().min(1).max(20).optional(),
});

const requireConverse = (context: ToolExecutionContext) => {
  if (!context.converseAdapter || !context.converseSessionToken) {
    throw new Error("No MCP converse session is bound to this request.");
  }
  return {
    adapter: context.converseAdapter,
    sessionToken: context.converseSessionToken,
  };
};

export const createConverseReadToolDefinitions = (): GenericToolDefinition[] => [
  {
    accessMode: "read",
    description: "Answer a question using the bound Radioso agent's grounded retrieval configuration.",
    execute: async (args, context) => {
      const { adapter, sessionToken } = requireConverse(context);
      const parsed = answerGroundedSchema.parse(args);
      const response = await adapter.answerGrounded(sessionToken, parsed);
      return {
        data: response,
        summary: response.answer,
      };
    },
    inputSchema: answerGroundedSchema,
    name: "answer_grounded",
  },
];

export const readConverseResource = async (context: ToolExecutionContext, uri: string) => {
  const { adapter, sessionToken } = requireConverse(context);
  const prefix = "radioso://agent-resource/";
  if (!uri.startsWith(prefix)) {
    throw new Error("Unsupported Radioso converse resource URI.");
  }
  return adapter.readResource(sessionToken, uri.slice(prefix.length));
};

export const listConverseResources = async (context: ToolExecutionContext) => {
  const { adapter, sessionToken } = requireConverse(context);
  return adapter.listResources(sessionToken);
};
