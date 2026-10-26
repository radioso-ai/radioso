import { z, type ZodType } from "zod";

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Formats a client already understands; the regex Zod adds beside them only restates the format. */
const SELF_DESCRIBING_FORMATS = new Set(["uuid", "email", "date-time", "date", "time", "duration", "uri", "ipv4", "ipv6"]);
/** Zod names these checks as a `format` no JSON Schema vocabulary defines; the `pattern` carries them. */
const ZOD_ONLY_FORMATS = new Set(["starts_with", "ends_with", "includes"]);

/**
 * Holds what Zod's JSON Schema generator emits to the shape this catalog has always advertised, so
 * a client — and the model reading the tool list — sees the same contract it did. Each rule restates
 * what the schema already enforces in the form clients were sent; none of them loosens a check.
 */
const keepAdvertisedShape = ({ zodSchema, jsonSchema }: {
  zodSchema: z.core.$ZodTypes;
  jsonSchema: z.core.JSONSchema.BaseSchema;
}): void => {
  const def = zodSchema._zod.def;
  const json = jsonSchema as Record<string, unknown>;
  switch (def.type) {
    case "object": {
      // A stripping object drops unknown keys; input mode leaves that unsaid, so say it, as a
      // strict object does. A passthrough object admits any extra key, spelled `true`.
      if (def.catchall === undefined && json.additionalProperties === undefined) json.additionalProperties = false;
      if (isRecord(json.additionalProperties) && Object.keys(json.additionalProperties).length === 0) json.additionalProperties = true;
      return;
    }
    case "union":
      // A discriminated union's variants never overlap, so `anyOf` says the same as the `oneOf` Zod
      // writes — and `anyOf` is the combinator every tool-calling model provider accepts.
      if ("discriminator" in def && Array.isArray(json.oneOf)) {
        json.anyOf = json.oneOf;
        delete json.oneOf;
      }
      return;
    case "number":
      // `.int()` implies the safe-integer range; it is not a bound the tool chose.
      if (json.minimum === Number.MIN_SAFE_INTEGER) delete json.minimum;
      if (json.maximum === Number.MAX_SAFE_INTEGER) delete json.maximum;
      return;
    case "record":
      if (isRecord(json.propertyNames) && JSON.stringify(json.propertyNames) === '{"type":"string"}') delete json.propertyNames;
      return;
    case "string":
      if (typeof json.format === "string" && SELF_DESCRIBING_FORMATS.has(json.format)) delete json.pattern;
      if (typeof json.format === "string" && ZOD_ONLY_FORMATS.has(json.format)) delete json.format;
      return;
    case "default":
      // Input mode drops a default whose subtree transforms, as if the default were output-only;
      // the tool still fills it in when the key is absent, which is what a client needs to know.
      if (json.default === undefined) json.default = JSON.parse(JSON.stringify(def.defaultValue)) as unknown;
      return;
    default:
      return;
  }
};

const DEFINITION_REF_PREFIX = "#/definitions/";

/**
 * Zod lifts a recursive schema (a JSON value, say) into `definitions` and points at it with `$ref`.
 * Clients differ on resolving references, so the catalog inlines each one where it is used and
 * stops a second pass through the same definition at `{}` — any value — as it always has.
 */
const inlineDefinitions = (document: Record<string, unknown>): Record<string, unknown> => {
  const { definitions, ...rest } = document;
  if (!isRecord(definitions)) return document;
  const inline = (node: unknown, expanding: ReadonlySet<string>): unknown => {
    if (Array.isArray(node)) return node.map((member) => inline(member, expanding));
    if (!isRecord(node)) return node;
    const { $ref: ref, ...siblings } = node;
    if (typeof ref === "string" && ref.startsWith(DEFINITION_REF_PREFIX)) {
      const name = ref.slice(DEFINITION_REF_PREFIX.length);
      const target = expanding.has(name) ? {} : inline(definitions[name], new Set([...expanding, name]));
      return { ...(target as Record<string, unknown>), ...(inline(siblings, expanding) as Record<string, unknown>) };
    }
    return Object.fromEntries(Object.entries(node).map(([key, value]) => [key, inline(value, expanding)]));
  };
  return inline(rest, new Set()) as Record<string, unknown>;
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
  // as the 2020-12 the protocol names. Input mode describes what a caller sends: a defaulted key
  // stays optional, and a transform is described by what it accepts.
  const { $schema: _dialect, ...generated } = z.toJSONSchema(schema, {
    target: "draft-07",
    io: "input",
    reused: "inline",
    unrepresentable: "any",
    override: keepAdvertisedShape,
  }) as Record<string, unknown>;
  const document = inlineDefinitions(generated);
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
