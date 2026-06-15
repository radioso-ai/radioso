import { z } from "zod";

/**
 * Domain schemas for the External Skills via MCP capability (feature 087).
 *
 * This module owns the validation surface for MCP **connections** and **skill
 * definitions**. It is pure: no transport, no persistence, no MCP client. The
 * conversation engine/contract packages and chat route stay MCP-agnostic; this
 * module is the only place that models the connection/skill-definition data.
 */

export const EXTERNAL_SKILLS_LIMITS = {
  displayName: 200,
  serverUrl: 2048,
  skillName: 120,
  toolName: 200,
  paramKey: 200,
  outcomeName: 120,
} as const;

/**
 * Front-end page that providers redirect to after consent. The page reads the
 * `code`/`state` query params and POSTs them to the completion endpoint. The full
 * redirect URI (APP_BASE_URL + this path) must be registered with the provider.
 */
export const MCP_OAUTH_CALLBACK_PATH = "/oauth/mcp-callback";

export const mcpAuthMethods = ["access_token", "oauth"] as const;
export type McpAuthMethod = (typeof mcpAuthMethods)[number];

export const mcpConnectionStatuses = ["unconfigured", "authorized", "needs_reauth", "error"] as const;
export type McpConnectionStatus = (typeof mcpConnectionStatuses)[number];

// Skill names are the routine `@mention` identifiers: lower-case, snake_case.
const skillNamePattern = /^[a-z][a-z0-9_]*$/u;
// Tool input keys and named outcomes follow a permissive identifier shape.
const paramKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const outcomeNamePattern = /^[a-z][a-z0-9_]*$/u;

const trimmedText = (maxLength: number) => z.string().trim().min(1).max(maxLength);

/**
 * Server URL validation at the schema layer: a well-formed https URL with no
 * embedded credentials (userinfo). Rejecting `user:pass@host` keeps secrets out
 * of this non-secret column. Network-level SSRF protection (private IP / loopback
 * rejection) is enforced at the service layer via the shared URL policy, since it
 * requires DNS resolution.
 */
/**
 * A well-formed https URL with no embedded credentials (userinfo). Shared by the
 * MCP server address and the OAuth authorization/token endpoints. Network-level
 * SSRF protection is enforced at the service layer via the shared URL policy.
 */
const httpsUrlSchema = (maxLength: number, field: string) =>
  trimmedText(maxLength).superRefine((value, ctx) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must be a valid URL` });
      return;
    }
    if (url.protocol !== "https:") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must use https` });
    }
    if (url.username !== "" || url.password !== "") {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${field} must not embed credentials (userinfo)` });
    }
  });

const serverUrlSchema = httpsUrlSchema(EXTERNAL_SKILLS_LIMITS.serverUrl, "serverUrl");

/**
 * OAuth authorization-code configuration an author supplies when connecting a
 * hosted MCP server (US2). Endpoints may be entered explicitly. The client
 * secret is optional (public PKCE clients omit it) and, like all secrets, is
 * encrypted at rest and never returned by the API.
 */
export const oauthConfigInputSchema = z
  .object({
    authorizationEndpoint: httpsUrlSchema(EXTERNAL_SKILLS_LIMITS.serverUrl, "authorizationEndpoint"),
    tokenEndpoint: httpsUrlSchema(EXTERNAL_SKILLS_LIMITS.serverUrl, "tokenEndpoint"),
    clientId: trimmedText(2048),
    clientSecret: trimmedText(4096).optional(),
    scopes: z.array(trimmedText(512)).max(50).optional(),
  })
  .strict();

export type OauthConfigInput = z.infer<typeof oauthConfigInputSchema>;

/** Body of the OAuth completion call: the provider's authorization code + state. */
export const oauthCompleteInputSchema = z
  .object({
    code: trimmedText(8192),
    state: trimmedText(2048),
  })
  .strict();

export type OauthCompleteInput = z.infer<typeof oauthCompleteInputSchema>;

export const mcpConnectionInputSchema = z
  .object({
    displayName: trimmedText(EXTERNAL_SKILLS_LIMITS.displayName),
    serverUrl: serverUrlSchema,
    authMethod: z.enum(mcpAuthMethods),
    accessToken: trimmedText(4096).optional(),
    oauth: oauthConfigInputSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.authMethod === "access_token" && !value.accessToken) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["accessToken"],
        message: "accessToken is required when authMethod is access_token",
      });
    }
    if (value.authMethod === "oauth" && !value.oauth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oauth"],
        message: "oauth config is required when authMethod is oauth",
      });
    }
    if (value.authMethod === "access_token" && value.oauth) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["oauth"],
        message: "oauth config is only valid when authMethod is oauth",
      });
    }
  });

export type McpConnectionInput = z.infer<typeof mcpConnectionInputSchema>;

/**
 * Persisted (encrypted) OAuth client config. Endpoints + clientId are not strictly
 * secret, but the whole record — including the client secret — is encrypted as one
 * blob in `oauth_client_ciphertext` to keep secret handling uniform.
 */
export interface StoredOauthClientConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  clientSecret?: string;
  scopes?: string[];
}

/** Persisted (encrypted) OAuth tokens stored in `credential_ciphertext`. */
export interface StoredOauthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Absolute expiry in epoch milliseconds, when the server returned `expires_in`. */
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
}

/** Transient PKCE/state for an in-flight authorization, stored in `oauth_flow_ciphertext`. */
export interface StoredOauthFlow {
  state: string;
  codeVerifier: string;
  redirectUri: string;
}

/** Specification of an input the conversation fills at run time. */
export const exposedParamSpecSchema = z
  .object({
    description: trimmedText(1000).optional(),
    // Optional explicit binding to a named routine slot; default = LLM-filled.
    slotBinding: trimmedText(EXTERNAL_SKILLS_LIMITS.paramKey).regex(paramKeyPattern).optional(),
  })
  .strict();

export const boundParamsSchema = z.record(z.unknown());
export const exposedParamsSchema = z.record(exposedParamSpecSchema);

export const skillDefinitionInputSchema = z
  .object({
    skillName: trimmedText(EXTERNAL_SKILLS_LIMITS.skillName).regex(skillNamePattern),
    connectionId: z.string().uuid(),
    toolName: trimmedText(EXTERNAL_SKILLS_LIMITS.toolName),
    boundParams: boundParamsSchema.default({}),
    exposedParams: exposedParamsSchema.default({}),
    // P3 fields (optional): named outcomes a routine may branch on + an optional
    // deterministic result->status map. Default branching is coarse completed/failed.
    declaredOutcomes: z
      .array(trimmedText(EXTERNAL_SKILLS_LIMITS.outcomeName).regex(outcomeNamePattern))
      .optional(),
    outcomeMap: z.record(trimmedText(EXTERNAL_SKILLS_LIMITS.outcomeName).regex(outcomeNamePattern)).optional(),
    enabled: z.boolean().default(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    const boundKeys = Object.keys(value.boundParams);
    const exposedKeys = Object.keys(value.exposedParams);
    const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
    if (overlap.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exposedParams"],
        message: `bound and exposed params must be disjoint (overlap: ${overlap.join(", ")})`,
      });
    }

    const dangerous = [...boundKeys, ...exposedKeys].filter(
      (key) => key === "__proto__" || key === "constructor" || key === "prototype",
    );
    if (dangerous.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundParams"],
        message: `param keys are not allowed: ${dangerous.join(", ")}`,
      });
    }
  });

export type SkillDefinitionInput = z.infer<typeof skillDefinitionInputSchema>;

const dangerousParamKey = (key: string): boolean =>
  key === "__proto__" || key === "constructor" || key === "prototype";

/** PATCH body for a connection: rename and/or rotate the access token. */
export const mcpConnectionUpdateSchema = z
  .object({
    displayName: trimmedText(EXTERNAL_SKILLS_LIMITS.displayName).optional(),
    accessToken: trimmedText(4096).optional(),
  })
  .strict();

export type McpConnectionUpdateInput = z.infer<typeof mcpConnectionUpdateSchema>;

/** PATCH body for a skill definition: toggle enabled and/or update its bindings. */
export const skillDefinitionUpdateSchema = z
  .object({
    boundParams: boundParamsSchema.optional(),
    exposedParams: exposedParamsSchema.optional(),
    declaredOutcomes: z
      .array(trimmedText(EXTERNAL_SKILLS_LIMITS.outcomeName).regex(outcomeNamePattern))
      .optional(),
    outcomeMap: z.record(trimmedText(EXTERNAL_SKILLS_LIMITS.outcomeName).regex(outcomeNamePattern)).optional(),
    enabled: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const boundKeys = value.boundParams ? Object.keys(value.boundParams) : [];
    const exposedKeys = value.exposedParams ? Object.keys(value.exposedParams) : [];
    if (value.boundParams && value.exposedParams) {
      const overlap = boundKeys.filter((key) => exposedKeys.includes(key));
      if (overlap.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["exposedParams"],
          message: `bound and exposed params must be disjoint (overlap: ${overlap.join(", ")})`,
        });
      }
    }
    const dangerous = [...boundKeys, ...exposedKeys].filter(dangerousParamKey);
    if (dangerous.length > 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["boundParams"],
        message: `param keys are not allowed: ${dangerous.join(", ")}`,
      });
    }
  });

export type SkillDefinitionUpdateInput = z.infer<typeof skillDefinitionUpdateSchema>;

/** Minimal JSON-Schema shape we read for coverage validation. */
interface ToolInputSchemaShape {
  properties?: Record<string, unknown>;
  required?: string[];
}

export interface ParamCoverageResult {
  ok: boolean;
  /** Required tool inputs that are neither bound nor exposed. */
  missingRequired: string[];
  /** Bound/exposed keys that are not properties of the tool's input schema. */
  unknownParams: string[];
}

/**
 * Validate a skill definition's param bindings against the bound tool's live
 * input schema (from discovery): every required input must be bound or exposed,
 * and every bound/exposed key must exist on the tool. Pure — used by the
 * skill-definition service and resolver.
 */
export const validateParamCoverage = (
  toolInputSchema: unknown,
  boundKeys: string[],
  exposedKeys: string[],
): ParamCoverageResult => {
  const schema = (toolInputSchema ?? {}) as ToolInputSchemaShape;
  const properties = schema.properties ?? {};
  const propertyNames = new Set(Object.keys(properties));
  const required = Array.isArray(schema.required) ? schema.required : [];
  const provided = new Set([...boundKeys, ...exposedKeys]);

  const missingRequired = required.filter((key) => !provided.has(key));
  const unknownParams = [...boundKeys, ...exposedKeys].filter((key) => !propertyNames.has(key));

  return {
    ok: missingRequired.length === 0 && unknownParams.length === 0,
    missingRequired,
    unknownParams,
  };
};
