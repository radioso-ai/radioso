import { OperatorMcpRequestSchema, digestOperatorMcpCall, type OperatorMcpProof } from "@radioso/operator-mcp-contract";
import { OperatorBackendAdapterError } from "./backendAdapter.js";
import { createOperatorInvocationId, sha256Digest } from "@radioso/operator-mcp-contract";
import type { OperatorMcpAuditObservation, OperatorMcpShape } from "./observability.js";

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

const rpcError = (id: string | number | null, code: number, message: string): Response => Response.json({
  error: { code, message },
  id,
  jsonrpc: "2.0",
}, { status: 200 });

const bearerToken = (request: Request): string | null => {
  const authorization = request.headers.get("authorization");
  if (!authorization || !/^Bearer [^\s]+$/u.test(authorization)) return null;
  const token = authorization.slice("Bearer ".length);
  return token.length <= 2048 && !/[\u0000-\u001f\u007f-\u009f]/u.test(token) ? token : null;
};

const unauthorized = (metadataUrl?: string): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (metadataUrl) headers.set("www-authenticate", `Bearer resource_metadata="${metadataUrl.replace(/[\\"]/gu, "\\$&")}"`);
  return new Response(JSON.stringify({ error: "invalid_token" }), { headers, status: 401 });
};

const insufficientScope = (metadataUrl: string | undefined, scope: string | undefined): Response => {
  const headers = new Headers({ "content-type": "application/json" });
  if (metadataUrl) headers.set("www-authenticate", `Bearer resource_metadata="${metadataUrl.replace(/[\\"]/gu, "\\$&")}", error="insufficient_scope"${scope ? `, scope="${scope}"` : ""}`);
  return new Response(JSON.stringify({ error: "insufficient_scope" }), { headers, status: 403 });
};

const objectParams = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;

const reportOutcome = (dependencies: OperatorMcpRequestHandlerDependencies, observation: OperatorMcpAuditObservation): void => {
  try { void Promise.resolve(dependencies.onOutcome?.(observation)).catch(() => undefined); } catch { /* telemetry cannot affect protocol */ }
};

const shapeForScope = (scope: string | undefined): OperatorMcpShape | undefined => {
  const shape = scope?.startsWith("operator:") ? scope.slice("operator:".length) : undefined;
  return shape === "read" || shape === "probe" || shape === "act" || shape === "propose" ? shape : undefined;
};

const principalDigest = (proof: OperatorMcpProof): string => sha256Digest([
  proof.accountId,
  proof.workspaceId,
  proof.userId,
  proof.grantId,
].join(":"));

const responseIsBounded = (value: unknown): boolean => {
  try { return new TextEncoder().encode(JSON.stringify(value)).byteLength <= MAX_RESPONSE_BYTES; } catch { return false; }
};

export const createOperatorMcpRequestHandler = (dependencies: OperatorMcpRequestHandlerDependencies) => async (request: Request): Promise<Response> => {
  if (dependencies.readiness && !dependencies.readiness.isReady()) return rpcError(null, -32002, "Operator MCP runtime is unavailable.");
  const token = bearerToken(request);
  if (!token) return unauthorized(dependencies.resourceMetadataUrl);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { allow: "POST" } });

  const body = await request.text();
  if (new TextEncoder().encode(body).byteLength > MAX_BODY_BYTES) return rpcError(null, -32600, "Invalid Request");

  let parsedBody: unknown;
  try { parsedBody = JSON.parse(body); } catch { return rpcError(null, -32700, "Parse error"); }
  const parsed = OperatorMcpRequestSchema.safeParse(parsedBody);
  if (!parsed.success) return rpcError(null, -32600, "Invalid Request");

  const { id, method, params } = parsed.data;
  const parameterObject = params ?? {};
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
      return unauthorized(dependencies.resourceMetadataUrl);
    }
    if (dependencies.rolloutWorkspaceIds !== undefined && !dependencies.rolloutWorkspaceIds.has(admission.proof.workspaceId)) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, reason: "workspace_not_in_rollout" });
      return unauthorized(dependencies.resourceMetadataUrl);
    }
    if (dependencies.principalRateLimit && !await dependencies.principalRateLimit.consume({ sourceDigest: principalDigest(admission.proof) })) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, shape: shapeForScope(admission.requiredScope), reason: "rate_limit_exceeded" });
      return new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { headers: { "content-type": "application/json" }, status: 429 });
    }
    if (method === "ping") {
      reportOutcome(dependencies, { method, outcome: "success" });
      return Response.json({ id, jsonrpc: "2.0", result: {} });
    }
    if (method === "tools/list") {
      const result = await dependencies.list({ proof: admission.proof });
      if (!Array.isArray(result.tools) || result.tools.length > 128 || !responseIsBounded(result)) {
        reportOutcome(dependencies, { method, outcome: "error", reason: "runtime_unavailable" });
        return rpcError(id, -32603, "Internal error");
      }
      reportOutcome(dependencies, { method, outcome: "success" });
      return Response.json({ id, jsonrpc: "2.0", result });
    }

    const result = await dependencies.call({
      arguments: call!.arguments,
      name: call!.name,
      operationId: call!.operationId,
      proof: admission.proof,
      bodyDigest,
    });
    if (!responseIsBounded(result)) {
      reportOutcome(dependencies, { method, outcome: "error", descriptorName, shape: shapeForScope(admission.requiredScope), reason: "runtime_unavailable" });
      return rpcError(id, -32603, "Internal error");
    }
    reportOutcome(dependencies, { method, outcome: "success", descriptorName, shape: shapeForScope(admission.requiredScope) });
    return Response.json({ id, jsonrpc: "2.0", result });
  } catch (error) {
    // Never serialize dependency errors: they can contain credentials or
    // customer content from a misconfigured backend.
    if (error instanceof OperatorBackendAdapterError && error.status === 401) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, reason: "invalid_token" });
      return unauthorized(dependencies.resourceMetadataUrl);
    }
    if (error instanceof OperatorBackendAdapterError && error.status === 403) {
      reportOutcome(dependencies, { method, outcome: "denied", descriptorName, shape: shapeForScope(error.requiredScope), reason: "insufficient_scope" });
      return insufficientScope(dependencies.resourceMetadataUrl, error.requiredScope);
    }
    reportOutcome(dependencies, { method, outcome: "error", descriptorName, reason: "runtime_unavailable" });
    return rpcError(id, -32002, "Operator MCP runtime is unavailable.");
  }
};
