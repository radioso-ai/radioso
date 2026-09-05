import {
  OPERATOR_MCP_PROTOCOL_VERSION,
  OperatorMcpRequestSchema,
  digestOperatorMcpCall,
  isOperatorMcpMethod,
  type OperatorMcpProof,
} from "@radioso/operator-mcp-contract";
import { OperatorBackendAdapterError } from "./backendAdapter.js";
import { createOperatorInvocationId, sha256Digest } from "@radioso/operator-mcp-contract";
import type { OperatorMcpAuditObservation, OperatorMcpShape } from "./observability.js";
import { withLegacyOperatorMcpCompatibility } from "./legacyCompatibility.js";

export interface OperatorMcpAdmission {
  proof: OperatorMcpProof;
  requiredScope?: string;
}

export interface OperatorRequestReadiness { isReady(): boolean }
export interface OperatorRequestRateLimit { consume(input: { sourceDigest: string }): boolean | Promise<boolean> }

export interface OperatorMcpRequestHandlerDependencies {
  admit(input: {
    accessToken: string;
    method: "ping" | "tools/list" | "tools/call";
    descriptorName?: string;
    requestBody: unknown;
    bodyDigest: string;
    invocationId: string;
  }): Promise<OperatorMcpAdmission | null>;
  list(input: { proof: OperatorMcpProof }): Promise<{ tools: unknown[] }>;
  call(input: {
    proof: OperatorMcpProof;
    name: string;
    arguments: Record<string, unknown>;
    operationId?: string;
    bodyDigest: string;
  }): Promise<unknown>;
  principalRateLimit?: OperatorRequestRateLimit;
  resourceMetadataUrl?: string;
  readiness?: { isReady(): boolean };
  onOutcome?: (observation: OperatorMcpAuditObservation) => void | Promise<void>;
  rolloutWorkspaceIds?: ReadonlySet<string>;
}

const MAX_BODY_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = 256 * 1024;

const rpcError = (
  id: string | number | null,
  code: number,
  message: string,
  options: { status?: number } = {},
): Response => Response.json({
  error: { code, message },
  id,
  jsonrpc: "2.0",
}, { status: options.status ?? 200 });

const protocolError = (
  id: string | number | null,
  code: -32020 | -32022,
  message: string,
  data?: unknown,
): Response => Response.json({
  error: { code, message, ...(data === undefined ? {} : { data }) },
  id,
  jsonrpc: "2.0",
}, { status: 400 });

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/u.test(authorization)) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length <= 2048 && !/[\u0000-\u001f\u007f-\u009f]/u.test(token) ? token : null;
};

const unauthorized = (metadataUrl?: string, invalidToken = false): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (metadataUrl) {
    headers.set(
      "www-authenticate",
      `Bearer resource_metadata="${metadataUrl.replace(/[\\"]/gu, "\\$&")}"${invalidToken ? ', error="invalid_token"' : ""}`,
    );
  }
  return new Response(JSON.stringify({ error: "invalid_token" }), { headers, status: 401 });
};

const insufficientScope = (metadataUrl: string | undefined, scope: string | undefined): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (metadataUrl) headers.set("www-authenticate", `Bearer resource_metadata="${metadataUrl.replace(/[\\"]/gu, "\\$&")}", error="insufficient_scope"${scope ? `, scope="${scope}"` : ""}`);
  return new Response(JSON.stringify({ error: "insufficient_scope" }), { headers, status: 403 });
};

const throttled = (error: "budget_exhausted" | "rate_limit_exceeded"): Response =>
  new Response(JSON.stringify({ error }), { headers: { "content-type": "application/json" }, status: 429 });

const objectParams = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const requestId = (value: unknown): string | number | null =>
  typeof value === "string" || (typeof value === "number" && Number.isFinite(value)) ? value : null;

const supportedWireMethod = (value: string): boolean => value === "server/discover" || isOperatorMcpMethod(value);

const decodedHeaderValue = (value: string): string | null => {
  if (!value.startsWith("=?base64?") || !value.endsWith("?=")) return value;
  const encoded = value.slice("=?base64?".length, -"?=".length);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) return null;
  const decoded = Buffer.from(encoded, "base64");
  if (decoded.toString("base64") !== encoded) return null;
  try { return new TextDecoder("utf-8", { fatal: true }).decode(decoded); } catch { return null; }
};

const SERVER_INFO = { name: "radioso-operator-mcp", version: "0.1.0" } as const;
const resultMetadata = { "io.modelcontextprotocol/serverInfo": SERVER_INFO } as const;

const reportOutcome = (dependencies: OperatorMcpRequestHandlerDependencies, observation: OperatorMcpAuditObservation): void => {
  try { void Promise.resolve(dependencies.onOutcome?.(observation)).catch(() => undefined); } catch { /* telemetry cannot affect protocol */ }
};

const shapeForScope = (scope: string | undefined): OperatorMcpShape | undefined => {
  const shape = scope?.startsWith("operator:") ? scope.slice("operator:".length) : undefined;
  return shape === "read" || shape === "probe" || shape === "act" || shape === "propose" ? shape : undefined;
};

const isBackendInvalidParams = (error: OperatorBackendAdapterError): boolean =>
  error.status === 400 && (
    error.code === "invalid_arguments"
    || error.code === "operation_required"
    || error.code === "operation_conflict"
  );

const isBackendRateLimit = (error: OperatorBackendAdapterError): error is OperatorBackendAdapterError & { code: "budget_exhausted" | "rate_limit_exceeded" } =>
  error.status === 429 && (error.code === "budget_exhausted" || error.code === "rate_limit_exceeded");

const principalDigest = (proof: OperatorMcpProof): string => sha256Digest([
  proof.accountId,
  proof.workspaceId,
  proof.userId,
  proof.grantId,
].join(":"));

const responseIsBounded = (value: unknown): boolean => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_RESPONSE_BYTES; } catch { return false; }
};

const createModernOperatorMcpRequestHandler = (dependencies: OperatorMcpRequestHandlerDependencies) => async (request: Request): Promise<Response> => {
  if (dependencies.readiness && !dependencies.readiness.isReady()) return rpcError(null, -32002, "Operator MCP runtime is unavailable.");
  const token = bearerToken(request);
  if (!token) return unauthorized(dependencies.resourceMetadataUrl);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  const protocolVersionHeader = request.headers.get("mcp-protocol-version");
  const methodHeader = request.headers.get("mcp-method");
  if (!protocolVersionHeader || !methodHeader) {
    return protocolError(null, -32020, "Required MCP routing header is missing or malformed.");
  }
  if (protocolVersionHeader !== OPERATOR_MCP_PROTOCOL_VERSION) {
    return protocolError(null, -32022, "Unsupported protocol version.", {
      requested: protocolVersionHeader,
      supported: [OPERATOR_MCP_PROTOCOL_VERSION],
    });
  }
  if (!supportedWireMethod(methodHeader)) return rpcError(null, -32601, "Method not found", { status: 404 });
  const nameHeader = request.headers.get("mcp-name");
  if (methodHeader === "tools/call" && !nameHeader) {
    return protocolError(null, -32020, "Required Mcp-Name header is missing or malformed.");
  }

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return rpcError(null, -32600, "Invalid Request");

  let parsedBody: unknown;
  try { parsedBody = JSON.parse(body); } catch { return rpcError(null, -32700, "Parse error"); }

  const envelope = objectParams(parsedBody);
  const id = requestId(envelope?.id);
  const bodyMethod = envelope?.method;
  const parameterObject = objectParams(envelope?.params);
  const metadata = objectParams(parameterObject?._meta);
  const bodyProtocolVersion = metadata?.["io.modelcontextprotocol/protocolVersion"];
  if (typeof bodyProtocolVersion !== "string" || bodyProtocolVersion !== protocolVersionHeader) {
    return protocolError(id, -32020, "MCP-Protocol-Version header does not match request metadata.");
  }
  if (typeof bodyMethod !== "string" || bodyMethod !== methodHeader) {
    return protocolError(id, -32020, "Mcp-Method header does not match the JSON-RPC method.");
  }
  if (bodyMethod === "tools/call") {
    const bodyName = parameterObject?.name;
    if (typeof bodyName !== "string" || !nameHeader || decodedHeaderValue(nameHeader) !== bodyName) {
      return protocolError(id, -32020, "Mcp-Name header does not match the tool name.");
    }
  }

  const parsed = OperatorMcpRequestSchema.safeParse(parsedBody);
  if (!parsed.success) return rpcError(id, -32600, "Invalid Request");

  const { method, params } = parsed.data;
  if (method === "server/discover") {
    return Response.json({
      id,
      jsonrpc: "2.0",
      result: {
        _meta: resultMetadata,
        cacheScope: "public",
        capabilities: { tools: {} },
        resultType: "complete",
        supportedVersions: [OPERATOR_MCP_PROTOCOL_VERSION],
        ttlMs: 3_600_000,
      },
    });
  }

  let call: { name: string; arguments: Record<string, unknown>; operationId?: string } | null = null;
  if (method === "tools/call") {
    const callParams = objectParams(parameterObject);
    const argumentsValue = callParams?.arguments === undefined ? {} : objectParams(callParams.arguments);
    const operationId = callParams?.operationId;
    if (
      !callParams
      || typeof callParams.name !== "string"
      || callParams.name.length === 0
      || callParams.name.length > 128
      || !argumentsValue
      || (operationId !== undefined && (typeof operationId !== "string" || operationId.length === 0 || operationId.length > 256))
    ) {
      reportOutcome(dependencies, { method, outcome: "error", reason: "invalid_request" });
      return rpcError(id, -32602, "Invalid params");
    }
    call = { name: callParams.name, arguments: argumentsValue, ...(operationId === undefined ? {} : { operationId }) };
  }
  const descriptorName = call?.name;
  const bodyDigest = call ? digestOperatorMcpCall(call) : sha256Digest(body);
  try {
    const admission = await dependencies.admit({
      accessToken: token,
      descriptorName,
      bodyDigest,
      invocationId: createOperatorInvocationId(),
      method,
      requestBody: parsed.data,
    });
    if (!admission) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, reason: "invalid_token" });
      return unauthorized(dependencies.resourceMetadataUrl, true);
    }
    if (dependencies.rolloutWorkspaceIds !== undefined && !dependencies.rolloutWorkspaceIds.has(admission.proof.workspaceId)) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, reason: "workspace_not_in_rollout" });
      return unauthorized(dependencies.resourceMetadataUrl, true);
    }
    if (dependencies.principalRateLimit && !await dependencies.principalRateLimit.consume({ sourceDigest: principalDigest(admission.proof) })) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, shape: shapeForScope(admission.requiredScope), reason: "rate_limit_exceeded" });
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { headers: { "content-type": "application/json" }, status: 429 });
    }
    if (method === "ping") {
      reportOutcome(dependencies, { method, outcome: "success" });
      return Response.json({ id, jsonrpc: "2.0", result: { _meta: resultMetadata, resultType: "complete" } });
    }
    if (method === "tools/list") {
      const result = await dependencies.list({ proof: admission.proof });
      const responseResult = {
        ...result,
        _meta: resultMetadata,
        cacheScope: "private",
        resultType: "complete",
        ttlMs: 0,
      };
      if (!Array.isArray(result.tools) || result.tools.length > 128 || !responseIsBounded(responseResult)) {
        reportOutcome(dependencies, { method, outcome: "error", reason: "runtime_unavailable" });
        return rpcError(id, -32603, "Internal error");
      }
      reportOutcome(dependencies, { method, outcome: "success" });
      return Response.json({ id, jsonrpc: "2.0", result: responseResult });
    }

    const result = await dependencies.call({
      arguments: call!.arguments,
      name: call!.name,
      operationId: call!.operationId,
      proof: admission.proof,
      bodyDigest,
    });
    const resultObject = objectParams(result);
    const responseResult = resultObject
      ? { ...resultObject, _meta: resultMetadata, resultType: "complete" }
      : null;
    if (!responseResult || !responseIsBounded(responseResult)) {
      reportOutcome(dependencies, { method, outcome: "error", descriptorName, shape: shapeForScope(admission.requiredScope), reason: "runtime_unavailable" });
      return rpcError(id, -32603, "Internal error");
    }
    reportOutcome(dependencies, { method, outcome: "success", descriptorName, shape: shapeForScope(admission.requiredScope) });
    return Response.json({ id, jsonrpc: "2.0", result: responseResult });
  } catch (error) {
    // Never serialize dependency errors: they can contain credentials or
    // customer content from a misconfigured backend.
    if (error instanceof OperatorBackendAdapterError && error.status === 401) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, reason: "invalid_token" });
      return unauthorized(dependencies.resourceMetadataUrl, true);
    }
    if (error instanceof OperatorBackendAdapterError && error.status === 403) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, shape: shapeForScope(error.requiredScope), reason: "insufficient_scope" });
      return insufficientScope(dependencies.resourceMetadataUrl, error.requiredScope);
    }
    if (error instanceof OperatorBackendAdapterError && isBackendInvalidParams(error)) {
      reportOutcome(dependencies, { method, outcome: "error", descriptorName, reason: "invalid_request" });
      return rpcError(id, -32602, error.code);
    }
    if (error instanceof OperatorBackendAdapterError && isBackendRateLimit(error)) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, shape: shapeForScope(error.requiredScope), reason: "rate_limit_exceeded" });
      return throttled(error.code);
    }
    reportOutcome(dependencies, { method, outcome: "error", descriptorName, reason: "runtime_unavailable" });
    return rpcError(id, -32002, "Operator MCP runtime is unavailable.");
  }
};

export const createOperatorMcpRequestHandler = (dependencies: OperatorMcpRequestHandlerDependencies) =>
  withLegacyOperatorMcpCompatibility(createModernOperatorMcpRequestHandler(dependencies));
