import { z } from "zod";

import { skillDataValueTypes, skillOutputsSchema } from "../../shared/domain/skillDataContract/index.js";
import { isPrototypeKey, isSkillPayloadKey, skillSlotBindingPattern } from "../../shared/domain/skillPayloadKey.js";

/**
 * API request skills: a workspace-owned API connection (base URL, auth, default headers) and
 * agent skills that send one HTTP request through it, returning only the response fields the
 * author declared as outputs.
 */

export const API_REQUEST_LIMITS = {
  /** One deadline over every redirect hop and the whole response body. */
  timeoutMs: 10_000,
  /** The response body is read up to this size and no further. */
  maxResponseBytes: 1_048_576,
  /** The declared outputs, serialized, may not pass this size. */
  maxOutputBytes: 16_384,
  /** The operator's test-request preview of the parsed body is cut down to this size. */
  maxPreviewBytes: 16_384,
} as const;

const CONNECTION_LIMITS = {
  name: 200,
  baseUrl: 2048,
  credential: 4096,
  headerName: 100,
  headerValue: 2000,
  defaultHeaders: 20,
} as const;

const SKILL_LIMITS = {
  path: 2048,
  params: 100,
} as const;

// ---------------------------------------------------------------------------------------------
// API connection
// ---------------------------------------------------------------------------------------------

export const apiConnectionAuthSchemes = ["none", "bearer", "header", "basic"] as const;
export type ApiConnectionAuthScheme = (typeof apiConnectionAuthSchemes)[number];

/** An RFC 9110 field-name token. */
const headerNamePattern = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/u;
const lineBreakOrNul = /[\r\n\0]/u;

/**
 * Header names a default header may not set: the transport owns framing and the target host, the
 * auth scheme owns credentials, and a cookie is session state no API connection carries.
 */
const reservedDefaultHeaderNames = new Set([
  "host",
  "content-length",
  "authorization",
  "proxy-authorization",
  "cookie",
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "te",
  "expect",
]);

const headerNameSchema = z.string().trim().min(1).max(CONNECTION_LIMITS.headerName).regex(headerNamePattern);
const headerValueSchema = z.string().max(CONNECTION_LIMITS.headerValue)
  .refine((value) => !lineBreakOrNul.test(value), "header value must be a single line");
const credentialSchema = z.string().min(1).max(CONNECTION_LIMITS.credential)
  .refine((value) => !lineBreakOrNul.test(value), "credential must be a single line");
const defaultHeadersSchema = z.record(headerNameSchema, headerValueSchema);

export const apiConnectionIdSchema = z.string().uuid();

/** The fields every connection must agree on, whether created whole or patched. */
interface ApiConnectionAuthState {
  authScheme: ApiConnectionAuthScheme;
  authHeaderName?: string | null;
  defaultHeaders?: Record<string, string>;
  /** Whether the connection holds a credential: one supplied now or one already stored. */
  hasCredential: boolean;
  /** The credential supplied now, when one is. */
  credential?: string;
}

/** The rules a connection's auth and headers meet; shared by create and by a patch merged onto a stored row. */
const validateApiConnectionAuthState = (state: ApiConnectionAuthState, ctx: z.RefinementCtx): void => {
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  if (state.authScheme === "none") {
    if (state.credential !== undefined) issue("credential", "a connection without auth takes no credential");
    if (state.authHeaderName) issue("authHeaderName", "a connection without auth takes no auth header name");
  } else if (!state.hasCredential) {
    issue("credential", `the ${state.authScheme} auth scheme needs a credential`);
  }
  if (state.authScheme === "header" && !state.authHeaderName) {
    issue("authHeaderName", "the header auth scheme needs an auth header name");
  }
  if (state.authScheme !== "header" && state.authHeaderName) {
    issue("authHeaderName", "only the header auth scheme takes an auth header name");
  }
  if (state.authScheme === "header" && state.authHeaderName) {
    const name = state.authHeaderName.toLowerCase();
    if (reservedDefaultHeaderNames.has(name) && name !== "authorization") {
      issue("authHeaderName", `"${state.authHeaderName}" cannot carry a credential`);
    }
  }
  if (state.authScheme === "basic" && state.credential !== undefined && !state.credential.includes(":")) {
    issue("credential", "a basic credential is written as username:password");
  }
  const headerNames = Object.keys(state.defaultHeaders ?? {});
  if (headerNames.length > CONNECTION_LIMITS.defaultHeaders) {
    issue("defaultHeaders", `at most ${CONNECTION_LIMITS.defaultHeaders} default headers`);
  }
  const seen = new Set<string>();
  for (const name of headerNames) {
    const lower = name.toLowerCase();
    if (reservedDefaultHeaderNames.has(lower)) issue("defaultHeaders", `default header "${name}" is not allowed`);
    if (state.authHeaderName && lower === state.authHeaderName.toLowerCase()) {
      issue("defaultHeaders", `default header "${name}" is the auth header`);
    }
    if (seen.has(lower)) issue("defaultHeaders", `default header "${name}" is set twice`);
    seen.add(lower);
  }
};

export const apiConnectionCreateSchema = z.object({
  name: z.string().trim().min(1).max(CONNECTION_LIMITS.name),
  baseUrl: z.string().trim().min(1).max(CONNECTION_LIMITS.baseUrl),
  authScheme: z.enum(apiConnectionAuthSchemes).default("none"),
  authHeaderName: headerNameSchema.optional(),
  credential: credentialSchema.optional(),
  defaultHeaders: defaultHeadersSchema.default({}),
}).strict().superRefine((value, ctx) => {
  validateApiConnectionAuthState({ ...value, hasCredential: value.credential !== undefined }, ctx);
});

export type ApiConnectionCreateInput = z.infer<typeof apiConnectionCreateSchema>;

/** A patch: an omitted credential keeps the stored one; `authHeaderName: null` clears it. */
export const apiConnectionUpdateSchema = z.object({
  name: z.string().trim().min(1).max(CONNECTION_LIMITS.name).optional(),
  baseUrl: z.string().trim().min(1).max(CONNECTION_LIMITS.baseUrl).optional(),
  authScheme: z.enum(apiConnectionAuthSchemes).optional(),
  authHeaderName: headerNameSchema.nullable().optional(),
  credential: credentialSchema.optional(),
  defaultHeaders: defaultHeadersSchema.optional(),
}).strict().refine((input) => Object.keys(input).length > 0, { message: "At least one field must be provided" });

export type ApiConnectionUpdateInput = z.infer<typeof apiConnectionUpdateSchema>;

/** A connection's auth and headers once a patch is merged onto the stored row, checked by the create rules. */
export const apiConnectionMergedStateSchema = z.object({
  authScheme: z.enum(apiConnectionAuthSchemes),
  authHeaderName: z.string().nullable(),
  defaultHeaders: z.record(z.string(), z.string()),
  hasCredential: z.boolean(),
  credential: z.string().optional(),
}).superRefine(validateApiConnectionAuthState);

export interface ApiConnectionRecord {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  authScheme: ApiConnectionAuthScheme;
  authHeaderName: string | null;
  credentialCiphertext: string | null;
  defaultHeaders: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

/** A connection as the operator reads it: the credential is never returned, only its masked tail. */
export interface ApiConnection {
  id: string;
  workspaceId: string;
  name: string;
  baseUrl: string;
  authScheme: ApiConnectionAuthScheme;
  authHeaderName: string | null;
  credentialMask: string | null;
  defaultHeaders: Record<string, string>;
  createdAt: Date;
  updatedAt: Date;
}

/** What a request needs from a connection: where it goes and how it authenticates. */
export interface ApiConnectionTarget {
  id: string;
  baseUrl: string;
  authScheme: ApiConnectionAuthScheme;
  authHeaderName: string | null;
  credential: string | null;
  defaultHeaders: Record<string, string>;
}

// ---------------------------------------------------------------------------------------------
// API request skill config
// ---------------------------------------------------------------------------------------------

export const apiRequestMethods = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
export type ApiRequestMethod = (typeof apiRequestMethods)[number];

/** Methods whose remaining params go into a JSON body; the others put them in the query string. */
export const isBodyMethod = (method: ApiRequestMethod): boolean =>
  method === "POST" || method === "PUT" || method === "PATCH";

export const apiRequestSkillOutcomes = [
  "completed",
  "not_found",
  "rejected",
  "missing_input",
  "invalid_input",
  "unverified",
  "failed",
] as const;
export type ApiRequestSkillOutcome = (typeof apiRequestSkillOutcomes)[number];

/** Why a request settled `failed`. Codes only: never a URL, a body, or a value. */
export type ApiRequestFailureReason =
  | "response_mismatch"
  | "outputs_too_large"
  | "non_json_response"
  | "timeout"
  | "network"
  | "upstream_error"
  | "auth_rejected"
  | "rate_limited"
  | "redirect_refused"
  | "connection_not_found"
  // The target resolved to a private address after it was saved.
  | "blocked"
  // The response body passed the 1 MB read cap.
  | "response_too_large"
  // The stored credential cannot be decrypted with the configured key.
  | "credential_unavailable"
  // The skill, its config, or the dispatch context could not be read.
  | "skill_not_found"
  | "invalid_config"
  | "context_missing";

const segmentsOf = (key: string): string[] => key.split(".");

/** A param name: the webhook payload-key rule, with every dotted segment non-empty and safe to nest. */
const paramKeySchema = z.string().max(200).refine(
  (key) => isSkillPayloadKey(key) && segmentsOf(key).every((segment) => segment.length > 0 && !isPrototypeKey(segment)),
  "param key is not supported",
);

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

export const apiRequestExposedParamSchema = z.object({
  /** The value is coerced to this type before it is placed; one that does not fit settles `invalid_input`. */
  type: z.enum(skillDataValueTypes),
  description: trimmedText(1000).optional(),
  slotBinding: trimmedText(120).regex(skillSlotBindingPattern).optional(),
  required: z.boolean().default(true),
  /** The value must come from a context variable the host verified; otherwise nothing is sent. */
  verifiedOnly: z.boolean().default(false),
}).strict();

export type ApiRequestExposedParam = z.infer<typeof apiRequestExposedParamSchema>;

const placeholderPattern = /\{([^{}]*)\}/gu;
const pathCharacterPattern = /^[^\s?#\\]+$/u;

/** The param names a path's `{placeholder}` segments name, or null when the path is malformed. */
export const pathPlaceholders = (path: string): string[] | null => {
  if (!path.startsWith("/") || path.startsWith("//") || !pathCharacterPattern.test(path)) return null;
  const names = [...path.matchAll(placeholderPattern)].map((match) => match[1]);
  const withoutPlaceholders = path.replace(placeholderPattern, "");
  if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) return null;
  if (names.some((name) => !paramKeySchema.safeParse(name).success)) return null;
  return names;
};

const apiRequestPathSchema = trimmedText(SKILL_LIMITS.path).refine(
  (path) => pathPlaceholders(path) !== null,
  "path must start with a single /, carry no query or fragment, and name each {placeholder} once",
);

const isScalar = (value: unknown): boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const validateApiRequestSkillConfig = (
  value: {
    method: ApiRequestMethod;
    path: string;
    boundParams: Record<string, unknown>;
    exposedParams: Record<string, unknown>;
    outputs: Record<string, unknown>;
  },
  ctx: z.RefinementCtx,
): void => {
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
  };
  const boundKeys = Object.keys(value.boundParams);
  const exposedKeys = Object.keys(value.exposedParams);
  const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
  if (overlap.length > 0) {
    issue("exposedParams", `bound and exposed params must be disjoint (overlap: ${overlap.join(", ")})`);
  }
  if (boundKeys.length + exposedKeys.length > SKILL_LIMITS.params) {
    issue("exposedParams", `at most ${SKILL_LIMITS.params} params`);
  }
  const declared = new Set([...boundKeys, ...exposedKeys]);
  for (const placeholder of pathPlaceholders(value.path) ?? []) {
    if (!declared.has(placeholder)) {
      issue("path", `path placeholder {${placeholder}} is not a declared param`);
    } else if (placeholder in value.boundParams && !isScalar(value.boundParams[placeholder])) {
      issue("boundParams", `path param "${placeholder}" must be a string, number or boolean`);
    }
  }
  if (isBodyMethod(value.method)) {
    for (const key of declared) {
      const parent = segmentsOf(key).slice(0, -1);
      for (let depth = 1; depth <= parent.length; depth += 1) {
        const prefix = parent.slice(0, depth).join(".");
        if (declared.has(prefix)) {
          issue("exposedParams", `body param "${prefix}" cannot also hold "${key}"`);
        }
      }
    }
  }
};

export const apiRequestSkillConfigSchema = z.object({
  method: z.enum(apiRequestMethods),
  path: apiRequestPathSchema,
  boundParams: z.record(paramKeySchema, z.unknown()).default({}),
  exposedParams: z.record(paramKeySchema, apiRequestExposedParamSchema).default({}),
  outputs: skillOutputsSchema.default({}),
}).strict().superRefine(validateApiRequestSkillConfig);

export type ApiRequestSkillConfig = z.infer<typeof apiRequestSkillConfigSchema>;

/** The operator's test request: one skill config's shape, with sample values for its exposed params. */
export const apiRequestTestSchema = z.object({
  method: z.enum(apiRequestMethods),
  path: apiRequestPathSchema,
  boundParams: z.record(paramKeySchema, z.unknown()).default({}),
  exposedSampleValues: z.record(paramKeySchema, z.unknown()).default({}),
  outputs: skillOutputsSchema.default({}),
}).strict();

export type ApiRequestTestInput = z.infer<typeof apiRequestTestSchema>;
