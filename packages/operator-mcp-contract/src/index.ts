import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const OPERATOR_MCP_PROTOCOL_VERSION = "2026-07-28" as const;
/** Backend tool execution ceiling; edge transports must allow additional response overhead. */
export const OPERATOR_MCP_EXECUTION_TIMEOUT_MS = 60_000;
export const OPERATOR_MCP_RESOURCE_PATH = "/operator/mcp" as const;
export const OPERATOR_MCP_PROTECTED_RESOURCE_METADATA_PATH =
  "/.well-known/oauth-protected-resource/operator/mcp" as const;
export const OPERATOR_MCP_SCOPES = [
  "operator:read",
  "operator:probe",
  "operator:act",
  "operator:propose",
] as const;
export const OPERATOR_MCP_LIFECYCLE_SCOPE = "offline_access" as const;
export const OPERATOR_MCP_SHAPES = ["read", "probe", "act", "propose"] as const;

export type OperatorMcpScope = (typeof OPERATOR_MCP_SCOPES)[number];
export type OperatorMcpShape = (typeof OPERATOR_MCP_SHAPES)[number];
export type OperatorMcpMethod = "ping" | "tools/list" | "tools/call";
export type OperatorMcpWireMethod = "server/discover" | OperatorMcpMethod;

const digestPattern = /^[A-Za-z0-9_-]{43}$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const boundedText = (max: number) => z.string().min(1).max(max).refine((value) => !/[\u0000-\u001f\u007f-\u009f]/u.test(value));
const digest = z.string().regex(digestPattern);
const uuid = z.string().regex(uuidPattern);
const canonicalDecimal = z.string().regex(/^(?:0|[1-9]\d*)$/u);
const method = z.enum(["ping", "tools/list", "tools/call"]);
const wireMethod = z.enum(["server/discover", "ping", "tools/list", "tools/call"]);
const shape = z.enum(OPERATOR_MCP_SHAPES);
const scope = z.enum(OPERATOR_MCP_SCOPES);
const jsonSchema = z.record(z.string(), z.unknown());

export const OperatorMcpRequestMetadataSchema = z.object({
  "io.modelcontextprotocol/protocolVersion": z.literal(OPERATOR_MCP_PROTOCOL_VERSION),
  "io.modelcontextprotocol/clientCapabilities": z.record(z.string(), z.unknown()),
  "io.modelcontextprotocol/clientInfo": z.object({
    name: boundedText(256),
    version: boundedText(256),
  }).passthrough().optional(),
}).passthrough();

export const OperatorMcpRequestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(256), z.number().finite()]),
  method: wireMethod,
  params: z.object({
    _meta: OperatorMcpRequestMetadataSchema,
  }).passthrough(),
}).strict();
export type OperatorMcpRequest = z.infer<typeof OperatorMcpRequestSchema>;

export const OperatorProtectedResourceMetadataSchema = z.object({
  resource: z.string().url(),
  authorization_servers: z.array(z.string().url()).min(1),
  scopes_supported: z.array(scope).min(1),
  bearer_methods_supported: z.array(z.literal("header")).min(1),
}).passthrough();

export const OperatorToolDescriptorSchema = z.object({
  name: boundedText(128),
  description: boundedText(2_048),
  inputSchema: jsonSchema,
  outputSchema: jsonSchema.optional(),
  shape,
  requiredScope: scope,
}).strict();
export type OperatorToolDescriptor = z.infer<typeof OperatorToolDescriptorSchema>;

export const OperatorAdmissionRequestSchema = z.object({
  accessToken: boundedText(2_048),
  invocationId: uuid,
  method,
  descriptorName: boundedText(128).optional(),
  resource: z.string().url().max(2_048),
  timestamp: boundedText(32),
  nonce: boundedText(256),
  bodyDigest: digest,
}).strict();
export type OperatorAdmissionRequest = z.infer<typeof OperatorAdmissionRequestSchema>;

export const OperatorMcpProofSchema = z.object({
  version: z.literal(1),
  credentialId: uuid,
  credentialEpoch: canonicalDecimal,
  grantId: uuid,
  grantVersion: canonicalDecimal,
  accountId: uuid,
  workspaceId: uuid,
  userId: uuid,
  clientId: boundedText(2_048),
  clientVersion: canonicalDecimal,
  clientMetadataSnapshotId: uuid,
  resource: z.string().url().max(2_048),
  method,
  descriptorName: boundedText(128).optional(),
  invocationId: uuid,
  bodyDigest: digest,
  issuedToolScopes: z.array(scope).min(1).max(OPERATOR_MCP_SCOPES.length).refine((values) => new Set(values).size === values.length),
  issuedOfflineAccess: z.boolean(),
  issuedAt: z.number().int(),
  expiresAt: z.number().int(),
  nonce: boundedText(256),
  signature: digest,
}).strict();
export type OperatorMcpProof = z.infer<typeof OperatorMcpProofSchema>;

export const OperatorAdmissionResponseSchema = z.object({
  proof: OperatorMcpProofSchema,
  requiredScope: scope.optional(),
}).strict();
export type OperatorAdmissionResponse = z.infer<typeof OperatorAdmissionResponseSchema>;

export const OperatorCatalogRequestSchema = z.object({ proof: OperatorMcpProofSchema }).strict();
export const OperatorCatalogResponseSchema = z.object({
  tools: z.array(OperatorToolDescriptorSchema).max(128),
}).strict();
export type OperatorCatalogResponse = z.infer<typeof OperatorCatalogResponseSchema>;

export const OperatorInvocationRequestSchema = z.object({
  proof: OperatorMcpProofSchema,
  name: boundedText(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
  operationId: boundedText(256).optional(),
  bodyDigest: digest,
}).strict();
export type OperatorInvocationRequest = z.infer<typeof OperatorInvocationRequestSchema>;

export const OperatorInvocationResponseSchema = z.object({
  structuredContent: z.record(z.string(), z.unknown()).optional(),
  content: z.array(z.record(z.string(), z.unknown())).max(128).default([]),
  isError: z.boolean().optional(),
  safeOutcomeCode: boundedText(128).optional(),
  resultReference: boundedText(256).optional(),
}).strict();
export type OperatorInvocationResponse = z.infer<typeof OperatorInvocationResponseSchema>;

export const OperatorMcpErrorResponseSchema = z.object({
  code: boundedText(128),
  message: boundedText(512),
  requiredScope: scope.optional(),
}).strict();

export const OPERATOR_SERVICE_AUTH_HEADERS = {
  service: "x-radioso-operator-service",
  timestamp: "x-radioso-operator-timestamp",
  nonce: "x-radioso-operator-nonce",
  bodyDigest: "x-radioso-operator-body-digest",
  signature: "x-radioso-operator-signature",
} as const;

const PROOF_CONTEXT = "radioso:operator-mcp:proof:v1";
const REQUEST_CONTEXT = "radioso:operator-mcp:request:v1";
const INPUT_CONTEXT = "radioso:operator-mcp:input:v1";

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
};

export const sha256Digest = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("base64url");

export const digestOperatorMcpCall = (input: {
  name: string;
  arguments: Record<string, unknown>;
  operationId?: string;
}): string => sha256Digest(canonicalJson({
  arguments: input.arguments,
  method: "tools/call",
  name: input.name,
  operationId: input.operationId ?? null,
}));

const signature = (context: string, secret: string, payload: string): string =>
  createHmac("sha256", secret).update(`${context}\n${payload}`).digest("base64url");

const proofPayload = (proof: Omit<OperatorMcpProof, "signature">): string => canonicalJson(proof);

export const createOperatorMcpProof = (
  input: Omit<OperatorMcpProof, "signature"> & { secret: string },
): OperatorMcpProof => {
  const { secret, ...unsigned } = input;
  const parsed = OperatorMcpProofSchema.omit({ signature: true }).parse(unsigned);
  return { ...parsed, signature: signature(PROOF_CONTEXT, secret, proofPayload(parsed)) };
};

export const verifyOperatorMcpProof = (input: {
  proof: OperatorMcpProof;
  secret: string;
  now?: number;
  clockSkewMs?: number;
}): boolean => {
  const parsed = OperatorMcpProofSchema.safeParse(input.proof);
  if (!parsed.success) return false;
  const { signature: presented, ...unsigned } = parsed.data;
  const expected = signature(PROOF_CONTEXT, input.secret, proofPayload(unsigned));
  const now = input.now ?? Date.now();
  const skew = input.clockSkewMs ?? 30_000;
  if (unsigned.expiresAt < unsigned.issuedAt || unsigned.expiresAt - unsigned.issuedAt > 30_000) return false;
  if (now < unsigned.issuedAt - skew || now > unsigned.expiresAt + skew) return false;
  const actualBytes = Buffer.from(presented, "base64url");
  const expectedBytes = Buffer.from(expected, "base64url");
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export const createOperatorMcpRequestSignature = (input: {
  secret: string;
  service: string;
  method: string;
  path: string;
  timestamp: string;
  nonce: string;
  bodyDigest: string;
}): string => signature(
  REQUEST_CONTEXT,
  input.secret,
  [input.service, input.timestamp, input.nonce, input.method.toUpperCase(), input.path, input.bodyDigest].join("\n"),
);

export const digestOperatorMcpInput = (input: {
  secret: string;
  descriptorName: string;
  descriptorVersion: string;
  value: unknown;
}): string => signature(
  INPUT_CONTEXT,
  input.secret,
  `${input.descriptorVersion}\n${input.descriptorName}\n${canonicalJson(input.value)}`,
);

export const createOperatorInvocationId = (): string => randomUUID();

export const operatorScopeForShape = (value: OperatorMcpShape): OperatorMcpScope => `operator:${value}` as OperatorMcpScope;
export const isOperatorMcpScope = (value: string): value is OperatorMcpScope => (OPERATOR_MCP_SCOPES as readonly string[]).includes(value);
export const isOperatorMcpMethod = (value: string): value is OperatorMcpMethod => ["ping", "tools/list", "tools/call"].includes(value);

export const canonicalizeOperatorResource = (resource: string): string | null => {
  try {
    const url = new URL(resource);
    if (url.hash || url.search || url.pathname !== OPERATOR_MCP_RESOURCE_PATH) return null;
    return url.toString();
  } catch {
    return null;
  }
};
