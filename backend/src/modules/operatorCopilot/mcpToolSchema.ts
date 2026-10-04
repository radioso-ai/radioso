import type { ZodType } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import type { CopilotToolDescriptor } from "./contracts.js";

const COMPOSITE_KEYWORDS = ["anyOf", "oneOf", "allOf"] as const;

const describesObject = (document: unknown): boolean =>
  typeof document === "object" && document !== null && (document as { type?: unknown }).type === "object";

/**
 * Draft 7 spells a positional array as an array-valued `items`, which 2020-12 renamed to
 * `prefixItems` and redefined as a schema applied to every element — so a client reading the
 * advertised schema in the dialect MCP names either rejects it or silently validates the wrong
 * thing. Nothing in the catalog emits one today; this keeps the first one a boot failure.
 */
const assertDialectAgnostic = (document: unknown, path: string): void => {
  if (Array.isArray(document)) {
    document.forEach((member, index) => assertDialectAgnostic(member, `${path}/${index}`));
    return;
  }
  if (typeof document !== "object" || document === null) return;
  for (const [keyword, value] of Object.entries(document)) {
    if (keyword === "items" && Array.isArray(value)) {
      throw new Error(`Operator MCP tool schemas must avoid draft-7-only positional items: ${path}/items`);
    }
    assertDialectAgnostic(value, `${path}/${keyword}`);
  }
};

/**
 * MCP requires a tool's input and output schema to be an object schema, and a client that validates
 * `tools/list` rejects the whole response when one tool omits `type: "object"` — so a single
 * union-typed descriptor hides the entire catalog rather than only itself. A zod union of object
 * variants serializes to a bare `anyOf`, which already admits nothing but those objects; declaring
 * the object type alongside it states that constraint rather than widening it.
 */
const operatorMcpToolSchema = (schema: ZodType<unknown>): Record<string, unknown> => {
  // MCP advertises schemas in JSON Schema, not OpenAPI 3.0: that dialect writes a non-inclusive
  // bound as `exclusiveMinimum: true` alongside `minimum`, and a client that checks the advertised
  // schema against the metaschema rejects the whole `tools/list` over the type mismatch. Draft 7
  // is the dialect-compatible subset here; the declared `$schema` is dropped so the document reads
  // as the 2020-12 the protocol names.
  const { $schema: _dialect, ...document } = zodToJsonSchema(schema, {
    target: "jsonSchema7",
    $refStrategy: "none",
  }) as Record<string, unknown>;
  assertDialectAgnostic(document, "");
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
    throw new Error(`Operator MCP tool schema cannot be advertised: ${descriptor.name}`, { cause });
  }
};

/**
 * Assembly is the last point where a schema no client can read is a code error rather than an empty
 * catalog: `tools/list` is all-or-nothing, so one malformed descriptor hides every other tool, and
 * the same projection also gates `tools/call`. This covers the shape rules stated above; the full
 * metaschema check a client runs lives in `operator-mcp-schema-dialect.test.ts`, which validates
 * every eligible descriptor's projection with the 2020-12 validator.
 */
export const assertOperatorMcpToolSchemas = (descriptors: ReadonlyArray<CopilotToolDescriptor>): void => {
  for (const descriptor of descriptors) {
    if (descriptor.mcpDisposition?.status === "eligible") operatorMcpToolSchemas(descriptor);
  }
};
