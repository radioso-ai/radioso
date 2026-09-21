import { fromJsonSchema, type StandardSchemaWithJSON } from "@modelcontextprotocol/server";

import type { AgentToolDescriptor } from "../converseApiAdapter.js";

/**
 * The descriptor's `inputSchema` is already JSON Schema (object, typed properties with
 * optional `email`/`date` formats, `required`, `additionalProperties: false`). The SDK
 * wraps it as-is: `tools/list` advertises exactly that document and `tools/call`
 * validates arguments against it before the handler runs.
 */
export const toRoutineToolInputSchema = (
  inputSchema: AgentToolDescriptor["inputSchema"],
): StandardSchemaWithJSON<Record<string, unknown>, Record<string, unknown>> =>
  fromJsonSchema<Record<string, unknown>>(inputSchema);
