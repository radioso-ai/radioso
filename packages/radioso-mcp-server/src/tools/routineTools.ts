import type { AgentToolDescriptor } from "../converseApiAdapter.js";
import type { GenericToolDefinition } from "./common.js";
import { toRoutineToolInputSchema } from "./routineToolSchema.js";

/**
 * One MCP tool per exposed routine. Calling it starts that routine through the same ask
 * route `ask_agent` uses, with the arguments as the routine's slot values; the reply is the
 * agent reply envelope, forwarded unchanged as `structuredContent`. `onInputRejected` hears
 * of a call whose arguments miss the descriptor's schema — the SDK refuses those before the
 * handler runs, so nothing else can observe them.
 */
export const createRoutineToolDefinitions = (
  descriptors: AgentToolDescriptor[],
  hooks: { onInputRejected?: (tool: GenericToolDefinition) => Promise<void> } = {},
): GenericToolDefinition[] =>
  descriptors.map((descriptor): GenericToolDefinition => {
    const onInputRejected = hooks.onInputRejected;
    const tool: GenericToolDefinition = {
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
      inputSchema: toRoutineToolInputSchema(descriptor.inputSchema, {
        onInvalid: onInputRejected ? () => onInputRejected(tool) : undefined,
      }),
      name: descriptor.toolName,
    };
    return tool;
  });
