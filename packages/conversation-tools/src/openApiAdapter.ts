import type { ConversationToolDefinition, ToolCallInput, ToolCallResult, ToolService } from "./types.js";
import type { ToolFetch } from "./mcpAdapter.js";
import { isRecord } from "./typeGuards.js";

const HTTP_METHODS = ["get", "put", "post", "delete", "patch", "head", "options", "trace"] as const;

type HttpMethod = typeof HTTP_METHODS[number];

export interface OpenApiDocument {
  openapi: string;
  servers?: Array<{ url: string }>;
  paths: Record<string, OpenApiPathItem | undefined>;
}

export type OpenApiPathItem = Partial<Record<HttpMethod, OpenApiOperation>> & {
  parameters?: OpenApiParameter[];
};

export interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  parameters?: OpenApiParameter[];
  requestBody?: {
    content?: Record<string, { schema?: unknown }>;
  };
  responses?: Record<string, unknown>;
}

export interface OpenApiParameter {
  name: string;
  in: "path" | "query" | "header" | "cookie";
  required?: boolean;
  schema?: unknown;
}

export interface OpenApiToolServiceOptions {
  spec: OpenApiDocument;
  baseUrl?: string | URL;
  headers?: Record<string, string>;
  /**
   * Optional allowlist for resolved operation hosts. Entries may be either
   * hostname ("api.example.com") or host with port ("api.example.com:8443").
   */
  allowedHosts?: readonly string[];
  fetch?: ToolFetch;
}

interface OperationBinding {
  toolName: string;
  method: HttpMethod;
  path: string;
  operation: OpenApiOperation;
  parameters: OpenApiParameter[];
}

interface OpenApiToolInput {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

const SAFE_URL_PROTOCOLS = new Set(["http:", "https:"]);

const isHttpMethod = (value: string): value is HttpMethod =>
  (HTTP_METHODS as readonly string[]).includes(value);

const operationToolName = (method: HttpMethod, path: string, operation: OpenApiOperation): string =>
  operation.operationId ?? `${method}_${path.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")}`;

const requestBodySchema = (operation: OpenApiOperation): unknown => {
  const content = operation.requestBody?.content;
  if (!content) {
    return undefined;
  }
  return content["application/json"]?.schema ?? Object.values(content)[0]?.schema;
};

const parameterInputProperties = (parameters: OpenApiParameter[]): Record<string, unknown> =>
  Object.fromEntries(parameters.map((parameter) => [parameter.name, parameter.schema ?? {}]));

const toolInputSchema = (
  operation: OpenApiOperation,
  parameters: OpenApiParameter[],
): Record<string, unknown> => ({
  type: "object",
  additionalProperties: false,
  properties: {
    path: { type: "object", additionalProperties: true },
    query: { type: "object", additionalProperties: true },
    headers: { type: "object", additionalProperties: { type: "string" } },
    ...parameterInputProperties(parameters),
    ...(requestBodySchema(operation) ? { body: requestBodySchema(operation) } : {}),
  },
});

const mergeRecord = (
  existing: Record<string, unknown> | undefined,
  name: string,
  value: unknown,
): Record<string, unknown> => ({
  ...(existing ?? {}),
  [name]: value,
});

const appendCookieParameter = (
  headers: Record<string, string> | undefined,
  name: string,
  value: unknown,
): Record<string, string> => {
  const next = { ...(headers ?? {}) };
  const cookieHeader = Object.keys(next).find((key) => key.toLowerCase() === "cookie") ?? "cookie";
  const pair = `${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`;
  next[cookieHeader] = next[cookieHeader] ? `${next[cookieHeader]}; ${pair}` : pair;
  return next;
};

const applyFlatParameter = (
  normalized: OpenApiToolInput,
  parameter: OpenApiParameter,
  value: unknown,
): OpenApiToolInput => {
  if (value === undefined) {
    return normalized;
  }
  switch (parameter.in) {
    case "path":
      return { ...normalized, path: mergeRecord(normalized.path, parameter.name, value) };
    case "query":
      return { ...normalized, query: mergeRecord(normalized.query, parameter.name, value) };
    case "header":
      return {
        ...normalized,
        headers: {
          ...(normalized.headers ?? {}),
          [parameter.name]: String(value),
        },
      };
    case "cookie":
      return {
        ...normalized,
        headers: appendCookieParameter(normalized.headers, parameter.name, value),
      };
  }
};

const normalizeInput = (input: unknown, parameters: OpenApiParameter[]): OpenApiToolInput => {
  if (!isRecord(input)) {
    return { body: input };
  }
  let normalized: OpenApiToolInput = {
    path: isRecord(input.path) ? input.path : undefined,
    query: isRecord(input.query) ? input.query : undefined,
    headers: isRecord(input.headers)
      ? Object.fromEntries(Object.entries(input.headers).map(([key, value]) => [key, String(value)]))
      : undefined,
    body: "body" in input ? input.body : undefined,
  };
  for (const parameter of parameters) {
    if (parameter.name in input) {
      normalized = applyFlatParameter(normalized, parameter, input[parameter.name]);
    }
  }
  return normalized;
};

const appendQuery = (url: URL, query: Record<string, unknown> | undefined): void => {
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(value));
  }
};

const pathWithParams = (path: string, params: Record<string, unknown> | undefined): string =>
  path.replace(/\{([^}]+)\}/g, (_match, name: string) => {
    const value = params?.[name];
    if (value === undefined || value === null) {
      throw new Error(`Missing OpenAPI path parameter "${name}"`);
    }
    return encodeURIComponent(String(value));
  });

const parseResponseBody = async (response: Awaited<ReturnType<ToolFetch>>): Promise<unknown> => {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    return response.json();
  }
  return response.text();
};

const validateOperationUrl = (url: URL, allowedHosts: readonly string[] | undefined): void => {
  if (!SAFE_URL_PROTOCOLS.has(url.protocol)) {
    throw new Error(`OpenAPI operation URL must use http or https, got "${url.protocol}"`);
  }
  if (allowedHosts && allowedHosts.length > 0 && !allowedHosts.includes(url.host) && !allowedHosts.includes(url.hostname)) {
    throw new Error(`OpenAPI operation URL host "${url.host}" is not allowed`);
  }
};

export class OpenApiToolService implements ToolService {
  private readonly bindings = new Map<string, OperationBinding>();
  private readonly fetchImpl: ToolFetch;
  private readonly baseUrl: string | URL;

  constructor(private readonly options: OpenApiToolServiceOptions) {
    this.fetchImpl = options.fetch ?? (globalThis.fetch as unknown as ToolFetch);
    this.baseUrl = options.baseUrl ?? options.spec.servers?.[0]?.url ?? "http://localhost";
    for (const [path, pathItem] of Object.entries(options.spec.paths)) {
      if (!pathItem) {
        continue;
      }
      for (const method of HTTP_METHODS) {
        const operation = pathItem[method];
        if (!operation) {
          continue;
        }
        const toolName = operationToolName(method, path, operation);
        this.bindings.set(toolName, {
          toolName,
          method,
          path,
          operation,
          parameters: [
            ...(pathItem.parameters ?? []),
            ...(operation.parameters ?? []),
          ],
        });
      }
    }
  }

  async listTools(): Promise<ConversationToolDefinition[]> {
    return [...this.bindings.values()].map((binding) => ({
      name: binding.toolName,
      description: binding.operation.description ?? binding.operation.summary,
      inputSchema: toolInputSchema(binding.operation, binding.parameters),
      outputSchema: binding.operation.responses,
      metadata: {
        transport: "openapi",
        method: binding.method,
        path: binding.path,
        operationId: binding.operation.operationId,
      },
    }));
  }

  async callTool(input: ToolCallInput): Promise<ToolCallResult> {
    const binding = this.bindings.get(input.toolName);
    if (!binding) {
      throw new Error(`OpenAPI operation tool "${input.toolName}" is not registered`);
    }
    const normalized = normalizeInput(input.input, binding.parameters);
    const url = new URL(pathWithParams(binding.path, normalized.path), this.baseUrl);
    appendQuery(url, normalized.query);
    validateOperationUrl(url, this.options.allowedHosts);
    const response = await this.fetchImpl(url, {
      method: binding.method.toUpperCase(),
      headers: {
        ...(this.options.headers ?? {}),
        ...(normalized.headers ?? {}),
        ...(normalized.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: normalized.body !== undefined ? JSON.stringify(normalized.body) : undefined,
      signal: input.context?.signal,
    });
    const body = await parseResponseBody(response);
    const outputs = {
      status: response.status,
      body,
    };
    if (!response.ok) {
      return {
        status: "failed",
        outputs,
        error: {
          code: "openapi_http_error",
          message: `OpenAPI operation "${input.toolName}" returned HTTP ${response.status}`,
          retryable: response.status >= 500,
        },
        metadata: { transport: "openapi", method: binding.method, path: binding.path },
      };
    }
    return {
      status: "completed",
      outputs,
      metadata: { transport: "openapi", method: binding.method, path: binding.path },
    };
  }
}

export const createOpenApiToolService = (options: OpenApiToolServiceOptions): OpenApiToolService =>
  new OpenApiToolService(options);

export const openApiHttpMethods = HTTP_METHODS.filter(isHttpMethod);
