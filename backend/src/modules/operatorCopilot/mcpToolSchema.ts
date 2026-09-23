import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CopilotToolDescriptor } from "./contracts.js";

const COMPOSITE_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

const describesObject = (document: unknown): boolean =>
  typeof document === "object" && document !== null && (document as { type?: unknown }).type === "object";

/**
 * MCP requires a tool's input and output schema to be an object schema, and a client that validates
 * `tools/list` rejects the whole response when one tool omits `type: "object"` — so a single
 * union-typed descriptor hides the entire catalog rather than only itself. A zod union of object
 * variants serializes to a bare `anyOf`, which already admits nothing but those objects; declaring
 * the object type alongside it states that constraint rather than widening it.
 */
const operatorMcpToolSchema = (schema: ZodType<unknown>): Record<string, unknown> => {
  const document = zodToJsonSchema(schema, { target: "openApi3", $refStrategy: "none" }) as Record<string, unknown>;
  if (describesObject(document)) return document;
  const composite = document.type === undefined
    ? COMPOSITE_KEYWORDS.find((keyword) => Array.isArray(document[keyword]))
    : undefined;
  if (composite && (document[composite] as readonly unknown[]).every(describesObject)) {
    // `document.type` is absent on this branch, so the declaration leads rather than overrides.
    return { type: "object", ...document };
  }
  throw new Error(`Operator MCP tool schemas must describe an object: ${JSON.stringify(document).slice(0, 200)}`);
};

export const operatorMcpToolSchemas = (
  descriptor: CopilotToolDescriptor,
): { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> } => {
  try {
    return {
      inputSchema: operatorMcpToolSchema(descriptor.inputSchema),
      outputSchema: operatorMcpToolSchema(descriptor.outputSchema),
    };
  } catch (cause) {
    throw new Error(`Operator MCP tool schema is not object-shaped: ${descriptor.name}`, { cause });
  }
};

/**
 * Assembly is the last point where a schema no client can read is a code error rather than an empty
 * catalog: `tools/list` is all-or-nothing, so one malformed descriptor hides every other tool, and
 * the same projection also gates `tools/call`.
 */
export const assertOperatorMcpToolSchemas = (descriptors: ReadonlyArray<CopilotToolDescriptor>): void => {
  for (const descriptor of descriptors) {
    if (descriptor.mcpDisposition?.status === "eligible") operatorMcpToolSchemas(descriptor);
  }
};
