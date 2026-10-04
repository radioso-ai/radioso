import { fromJsonSchema, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

type RoutineToolInputSchema = StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>>;

/**
 * The descriptor's `inputSchema` is already JSON Schema (object, typed properties with
 * optional `email`/`date` formats, `required`, `additionalProperties: false`). The SDK
 * wraps it as-is: `tools/list` advertises exactly that document and `tools/call`
 * validates arguments against it before the handler runs. `onInvalid` runs when that
 * validation refuses a call, since no handler ever sees such a call.
 */
export const toRoutineToolInputSchema = (
  inputSchema: AgentToolDescriptor["inputSchema"],
  hooks: { onInvalid?: () => Promise<void> } = {},
): RoutineToolInputSchema => {
  const schema = fromJsonSchema<Record<string, unknown>>(inputSchema);
  const { onInvalid } = hooks;
  if (!onInvalid) {
    return schema;
  }
  const standard = schema["~standard"];
  return {
    ...schema,
    "~standard": {
      ...standard,
      validate: async (value) => {
        const result = await standard.validate(value);
        if (result.issues && result.issues.length > 0) {
          await onInvalid();
        }
        return result;
      },
    },
  };
};
