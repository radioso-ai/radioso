/**
 * Flattens an OpenAPI document into one ingestible markdown document per tag.
 * The docs-portal API reference is a client-side Stoplight widget over the same
 * spec, so this is the only way to make the REST contract answerable: we render
 * each tag's operations (method, path, params, request/response schema) as prose.
 */
export interface OpenApiDocument {
  tag: string;
  title: string;
  markdown: string;
  sourceUrl: string;
}

export interface ConvertOpenApiOptions {
  /** Absolute base for the public docs site, e.g. `https://docs.radioso.ai`. */
  citationBase: string;
}

// Narrow structural views of the parts of the spec we read.
interface OpenApiSpec {
  tags?: Array<{ name: string; description?: string }>;
  paths?: Record<string, PathItem>;
  components?: { schemas?: Record<string, Schema> };
}

type PathItem = Record<string, Operation>;

interface Operation {
  tags?: string[];
  summary?: string;
  description?: string;
  security?: SecurityRequirement[];
  parameters?: Parameter[];
  requestBody?: { description?: string; content?: Record<string, { schema?: Schema }> };
  responses?: Record<string, { description?: string; content?: Record<string, { schema?: Schema }> }>;
}

type SecurityRequirement = Record<string, string[]>;

interface Parameter {
  name?: string;
  in?: string;
  required?: boolean;
  description?: string;
  schema?: Schema;
}

interface Schema {
  $ref?: string;
  type?: string;
  format?: string;
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, Schema>;
  additionalProperties?: Schema | boolean;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete"] as const;

export function convertOpenApiToDocuments(spec: OpenApiSpec, options: ConvertOpenApiOptions): OpenApiDocument[] {
  const citationBase = options.citationBase.replace(/\/+$/, "");
  const schemas = spec.components?.schemas ?? {};
  const byTag = groupOperationsByTag(spec);

  const orderedTags = orderTags(spec, byTag);

  return orderedTags.map((tag) => {
    const operations = byTag.get(tag) ?? [];
    const body = operations.map((entry) => renderOperation(entry, schemas)).join("\n\n");
    const markdown = `# ${tag} API\n\n${body}`.trim();
    return {
      tag,
      title: `${tag} API reference`,
      markdown,
      sourceUrl: `${citationBase}/api-reference#tag/${encodeURIComponent(tag)}`,
    };
  });
}

interface OperationEntry {
  method: string;
  path: string;
  operation: Operation;
}

function groupOperationsByTag(spec: OpenApiSpec): Map<string, OperationEntry[]> {
  const byTag = new Map<string, OperationEntry[]>();
  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item[method];
      if (!operation) {
        continue;
      }
      const tags = operation.tags?.length ? operation.tags : ["Untagged"];
      for (const tag of tags) {
        const entries = byTag.get(tag) ?? [];
        entries.push({ method, path, operation });
        byTag.set(tag, entries);
      }
    }
  }
  return byTag;
}

function orderTags(spec: OpenApiSpec, byTag: Map<string, OperationEntry[]>): string[] {
  const declared = (spec.tags ?? []).map((tag) => tag.name).filter((name) => byTag.has(name));
  const declaredSet = new Set(declared);
  const remaining = [...byTag.keys()].filter((tag) => !declaredSet.has(tag));
  return [...declared, ...remaining];
}

function renderOperation(entry: OperationEntry, schemas: Record<string, Schema>): string {
  const { method, path, operation } = entry;
  const lines: string[] = [`## ${method.toUpperCase()} ${path}`];

  if (operation.summary) {
    lines.push("", operation.summary);
  }
  if (operation.description) {
    lines.push("", operation.description);
  }

  lines.push("", `Auth: ${renderAuth(operation.security)}`);

  const params = operation.parameters ?? [];
  if (params.length > 0) {
    lines.push("", "### Parameters");
    for (const param of params) {
      const required = param.required ? ", required" : "";
      const description = param.description ? ` — ${param.description}` : "";
      lines.push(`- \`${param.name}\` (${param.in}, ${schemaType(param.schema, schemas)}${required})${description}`);
    }
  }

  const requestSchema = firstSchema(operation.requestBody?.content);
  if (requestSchema) {
    lines.push("", "### Request body", renderSchema(requestSchema, schemas));
  }

  const responses = operation.responses ?? {};
  if (Object.keys(responses).length > 0) {
    lines.push("", "### Responses");
    for (const [status, response] of Object.entries(responses)) {
      const description = response.description ? ` — ${response.description}` : "";
      lines.push(`- \`${status}\`${description}`);
      const responseSchema = firstSchema(response.content);
      if (responseSchema) {
        lines.push(indent(renderSchema(responseSchema, schemas)));
      }
    }
  }

  return lines.join("\n");
}

function firstSchema(content: Record<string, { schema?: Schema }> | undefined): Schema | undefined {
  if (!content) {
    return undefined;
  }
  for (const media of Object.values(content)) {
    if (media.schema) {
      return media.schema;
    }
  }
  return undefined;
}

function renderSchema(schema: Schema, schemas: Record<string, Schema>): string {
  const resolved = normalizeSchema(schema, schemas);
  if (resolved.properties) {
    const required = new Set(resolved.required ?? []);
    const lines = Object.entries(resolved.properties).map(([name, prop]) => {
      const flag = required.has(name) ? ", required" : "";
      return `- \`${name}\` (${schemaType(prop, schemas)}${flag})`;
    });
    return lines.join("\n");
  }
  return `- type: ${schemaType(resolved, schemas)}`;
}

function renderAuth(security: SecurityRequirement[] | undefined): string {
  if (!security?.length) {
    return "none";
  }
  return security.map(renderSecurityRequirement).join(" or ");
}

function renderSecurityRequirement(requirement: SecurityRequirement): string {
  const schemes = Object.keys(requirement);
  return schemes.length > 0 ? schemes.join(" + ") : "none";
}

function normalizeSchema(schema: Schema, schemas: Record<string, Schema>, visitedRefs: Set<string> = new Set()): Schema {
  const resolved = resolveRef(schema, schemas, visitedRefs);
  if (!resolved.allOf) {
    return resolved;
  }

  const mergedProperties: Record<string, Schema> = {};
  const mergedRequired = new Set<string>();

  for (const part of resolved.allOf) {
    const normalizedPart = normalizeSchema(part, schemas, new Set(visitedRefs));
    Object.assign(mergedProperties, normalizedPart.properties ?? {});
    for (const required of normalizedPart.required ?? []) {
      mergedRequired.add(required);
    }
  }

  Object.assign(mergedProperties, resolved.properties ?? {});
  for (const required of resolved.required ?? []) {
    mergedRequired.add(required);
  }

  const normalized: Schema = { ...resolved, type: resolved.type ?? "object" };
  delete normalized.allOf;
  normalized.properties = mergedProperties;
  normalized.required = [...mergedRequired];
  return normalized;
}

function schemaType(schema: Schema | undefined, schemas: Record<string, Schema>): string {
  if (!schema) {
    return "unknown";
  }
  if (schema.$ref) {
    return refName(schema.$ref);
  }
  if (schema.enum) {
    return `enum(${schema.enum.map((value) => JSON.stringify(value)).join(" | ")})`;
  }
  if (schema.anyOf || schema.oneOf) {
    const variants = (schema.anyOf ?? schema.oneOf ?? []).map((variant) => schemaType(variant, schemas));
    return [...new Set(variants)].join(" | ");
  }
  if (schema.type === "array") {
    return `array<${schemaType(schema.items, schemas)}>`;
  }
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) {
    return `map<${additionalPropertiesType(schema.additionalProperties, schemas)}>`;
  }
  return schema.format ? `${schema.type ?? "object"}<${schema.format}>` : schema.type ?? "object";
}

function additionalPropertiesType(additionalProperties: Schema | true, schemas: Record<string, Schema>): string {
  if (additionalProperties === true) {
    return "unknown";
  }
  if (Object.keys(additionalProperties).length === 0) {
    return "unknown";
  }
  return schemaType(additionalProperties, schemas);
}

function resolveRef(schema: Schema, schemas: Record<string, Schema>, visitedRefs: Set<string> = new Set()): Schema {
  if (!schema.$ref) {
    return schema;
  }
  if (visitedRefs.has(schema.$ref)) {
    return schema;
  }
  visitedRefs.add(schema.$ref);
  return schemas[refName(schema.$ref)] ?? schema;
}

function refName(ref: string): string {
  return ref.split("/").pop() ?? ref;
}

function indent(block: string): string {
  return block
    .split("\n")
    .map((line) => (line ? `  ${line}` : line))
    .join("\n");
}
