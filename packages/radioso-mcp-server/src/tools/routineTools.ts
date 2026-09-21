import type { AgentToolDescriptor } from "../converseApiAdapter.js";
import type { GenericToolDefinition } from "./common.js";
import { toRoutineToolInputSchema } from "./routineToolSchema.js";

/**
 * One MCP tool per exposed routine. Calling it starts that routine through the same ask
 * route `ask_agent` uses, with the arguments as the routine's slot values; the reply is the
 * agent reply envelope, forwarded unchanged as `structuredContent`.
 */
export const createRoutineToolDefinitions = (descriptors: AgentToolDescriptor[]): GenericToolDefinition[] =>
  descriptors.map((descriptor) => ({
    description: descriptor.description,
    execute: async (args, context) => {
      if (!context.converseAdapter || !context.converseSessionToken) {
        throw new Error("No MCP converse session is bound to this request.");
      }
      const response = await context.converseAdapter.ask(
        context.converseSessionToken,
        { routine: { toolName: descriptor.toolName, input: args } },
        { sourceDigest: context.authInfo?.sourceDigest },
      );
      return {
        data: response,
        summary: response.answer.text,
      };
    },
    inputSchema: toRoutineToolInputSchema(descriptor.inputSchema),
    name: descriptor.toolName,
  }));
