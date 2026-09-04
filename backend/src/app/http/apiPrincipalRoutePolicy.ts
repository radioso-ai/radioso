import type { AuthenticatedPrincipal } from "../../modules/account/public.js";
import type { RequestHandler, Router } from "express";

export type ApiPrincipalAuthenticationMode = "machine_eligible" | "machine_required" | "session_only";

const apiPrincipalAuthenticator = Symbol("apiPrincipalAuthenticator");
const apiPrincipalRouteMount = Symbol("apiPrincipalRouteMount");

/**
 * Marks the authenticators whose routes must have a principal policy. The mark is
 * intentionally carried by the runtime handler, so route inventory can inspect
 * router stacks without parsing TypeScript source or depending on where auth is
 * attached (`router.get` versus `router.use`).
 */
export const markApiPrincipalAuthenticator = <T extends RequestHandler>(
  handler: T,
  mode: ApiPrincipalAuthenticationMode,
): T => Object.assign(handler, { [apiPrincipalAuthenticator]: mode });

export const apiPrincipalAuthenticationMode = (handler: unknown): ApiPrincipalAuthenticationMode | null => {
  if (typeof handler !== "function") return null;
  const mode = (handler as RequestHandler & { [apiPrincipalAuthenticator]?: unknown })[apiPrincipalAuthenticator];
  return mode === "machine_eligible" || mode === "machine_required" || mode === "session_only" ? mode : null;
};

/** Declares a nested router's path for the structural policy inventory. */
export const markApiPrincipalRouteMount = <T extends Router>(router: T, path: string): T =>
  Object.assign(router, { [apiPrincipalRouteMount]: path });

export const apiPrincipalRouteMountPath = (router: unknown): string | null => {
  if ((typeof router !== "object" && typeof router !== "function") || router === null) return null;
  const path = (router as Router & { [apiPrincipalRouteMount]?: unknown })[apiPrincipalRouteMount];
  return typeof path === "string" ? path : null;
};

/**
 * Narrow host capability for application modules that authenticate their own
 * routes. It keeps optional modules structurally compatible without importing
 * HTTP internals, while giving the host inventory the same runtime mark it
 * uses for first-party middleware.
 */
export interface ApiPrincipalRouteInventory {
  markAuthenticator<T extends RequestHandler>(handler: T, mode: ApiPrincipalAuthenticationMode): T;
  markRouteMount<T extends Router>(router: T, path: string): T;
}

export const apiPrincipalRouteInventory: ApiPrincipalRouteInventory = {
  markAuthenticator: markApiPrincipalAuthenticator,
  markRouteMount: markApiPrincipalRouteMount,
};

export type ApiPrincipalRouteEligibility = {
  allowedPrincipalKinds: readonly AuthenticatedPrincipal["type"][];
  permission: string;
  sessionOnly: boolean;
};

const machinePrincipalKinds = ["personal_api_credential", "service_account_credential"] as const;
const ordinaryPrincipalKinds = ["session_user", ...machinePrincipalKinds] as const;
const sessionPrincipalKinds = ["session_user"] as const;

type PolicyDeclaration = readonly [method: string, pathPattern: string, permission: string, sessionOnly?: boolean];
const allow = (method: string, pathPattern: string, permission: string): PolicyDeclaration =>
  [method, pathPattern, permission];
const sessionOnly = (method: string, pathPattern: string, permission = "session"): PolicyDeclaration =>
  [method, pathPattern, permission, true];

/**
 * Exhaustive machine-credential coverage map for the initially supported API.
 * Patterns are exact: `:name` matches one non-empty path segment, and there are
 * no prefix wildcards. New child routes remain denied until declared here.
 */
const declarations: readonly PolicyDeclaration[] = [
  sessionOnly("GET", "/api/v1/workspace", "workspace.list"),
  allow("GET", "/api/v1/workspace/summary", "workspace.summary.read"),
  sessionOnly("GET", "/api/v1/workspace/resolve/:workspaceKey", "workspace.resolve"),
  sessionOnly("POST", "/api/v1/workspace", "workspace.create"),
  sessionOnly("PATCH", "/api/v1/workspace/:workspaceId", "workspace.rename"),
  sessionOnly("DELETE", "/api/v1/workspace/:workspaceId", "workspace.delete"),

  // Account identity and organization administration authenticate exclusively
  // with the account session; machine credentials are workspace-scoped.
  sessionOnly("GET", "/api/v1/account/users", "account.users.manage"),
  sessionOnly("GET", "/api/v1/account/accounts", "account.membership.read"),
  sessionOnly("POST", "/api/v1/account/accounts", "account.organization.create"),
  sessionOnly("POST", "/api/v1/account/invitations", "account.users.manage"),
  sessionOnly("DELETE", "/api/v1/account/invitations/:invitationId", "account.users.manage"),
  sessionOnly("POST", "/api/v1/account/switch", "account.membership.read"),
  sessionOnly("DELETE", "/api/v1/account", "account.organization.delete"),
  sessionOnly("PATCH", "/api/v1/account", "account.organization.rename"),
  sessionOnly("PATCH", "/api/v1/account/users/:membershipId", "account.membership.role.update"),
  sessionOnly("PUT", "/api/v1/account/workspaces/:workspaceId/grants/:userId", "account.membership.role.update"),
  sessionOnly("DELETE", "/api/v1/account/workspaces/:workspaceId/grants/:userId", "account.membership.role.update"),
  sessionOnly("DELETE", "/api/v1/account/users/:membershipId", "account.membership.remove"),
  sessionOnly("GET", "/api/v1/account/usage-trends", "workspace.usage.read"),
  sessionOnly("GET", "/api/v1/account/usage/messages", "workspace.usage.read"),
  sessionOnly("GET", "/api/v1/account/usage/internal-operations", "workspace.usage.read"),
  ...[
    ["GET", "/api/v1/ee/usage-limits/me", "workspace.usage.read"],
    ["GET", "/api/v1/ee/usage-limits/profiles", "workspace.usage.manage"],
    ["PUT", "/api/v1/ee/usage-limits/profiles/:profileKey", "workspace.usage.manage"],
    ["PUT", "/api/v1/ee/usage-limits/accounts/:accountId", "workspace.usage.manage"],
    ["GET", "/api/v1/ee/usage-limits/accounts/:accountId/usage", "workspace.usage.read"],
    ["GET", "/api/v1/ee/usage-limits/org-creation/users/:userId", "workspace.usage.manage"],
    ["PUT", "/api/v1/ee/usage-limits/org-creation/users/:userId", "workspace.usage.manage"],
    ["DELETE", "/api/v1/ee/usage-limits/org-creation/users/:userId", "workspace.usage.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  allow("POST", "/api/v1/assistant/chat", "workspace.chat.use"),
  allow("POST", "/api/v1/retrieval/search", "workspace.retrieval.query"),
  allow("POST", "/api/v1/retrieval/answer", "workspace.retrieval.query"),

  ...["", "/chat", "/search", "/contact"].map((path) =>
    allow("GET", `/api/v1/history${path}`, "workspace.history.read")),
  ...["/contact/:requestId", "/search/:searchId", "/chat/:conversationId", "/chat/:conversationId/tail", "/:conversationId"]
    .map((path) => allow("GET", `/api/v1/history${path}`, "workspace.history.read")),

  ...["", "/sources", "/sources/:sourceId/documents", "/search/history", "/search/history/:searchId", "/:documentId", "/:documentId/chunks", "/:documentId/chunks/:chunkId"]
    .map((path) => allow("GET", `/api/v1/document${path}`, "workspace.documents.read")),
  allow("POST", "/api/v1/document/search", "workspace.documents.read"),
  ...["", "/import", "/sources/:sourceId/recrawl", "/sources/:sourceId/pause-crawl", "/sources/:sourceId/resume-crawl", "/sources/:sourceId/reprocess", "/:documentId/reprocess"]
    .map((path) => allow("POST", `/api/v1/document${path}`, "workspace.documents.manage")),
  ...["/sources/:sourceId", "/:documentId"].map((path) =>
    allow("PATCH", `/api/v1/document${path}`, "workspace.documents.manage")),
  allow("PUT", "/api/v1/document/:documentId", "workspace.documents.manage"),
  ...["/sources/:sourceId", "/:documentId"].map((path) =>
    allow("DELETE", `/api/v1/document${path}`, "workspace.documents.manage")),
  allow("GET", "/api/v1/document/crawl/jobs", "workspace.documents.read"),
  allow("POST", "/api/v1/document/crawl", "workspace.documents.manage"),
  allow("DELETE", "/api/v1/document/crawl/jobs/:jobId", "workspace.documents.manage"),

  // Agent authoring remains available to machine principals. The HTTP routes redact
  // public-launch values from those responses and reject machine launch-surface input.
  ...["", "/:agentId"]
    .map((path) => allow("GET", `/api/v1/agents${path}`, "workspace.agents.read")),
  ...["/:agentId/channels/lifecycle", "/:agentId/directives", "/:agentId/routine-skill-catalog", "/:agentId/routines", "/:agentId/routines/:routineId", "/:agentId/bundle"]
    .map((path) => allow("GET", `/api/v1/agents${path}`, "workspace.agents.read")),
  allow("POST", "/api/v1/agents", "workspace.agents.manage"),
  // Importing a bundle creates an agent, so it sits with agent creation rather than
  // with the per-agent authoring routes below.
  allow("POST", "/api/v1/agents/bundle", "workspace.agents.manage"),
  ...["/:agentId/directives", "/:agentId/directives/draft", "/:agentId/routines", "/:agentId/routines/draft-assist"]
    .map((path) => allow("POST", `/api/v1/agents${path}`, "workspace.agents.manage")),
  allow("POST", "/api/v1/agents/:agentId/routines/:routineId/validate", "workspace.agents.read"),
  ...["/:agentId/routines/:routineId/publish", "/:agentId/routines/:routineId/revise", "/:agentId/routines/:routineId/archive", "/:agentId/routines/:routineId/restore", "/:agentId/assistant-logo", "/:agentId/default"]
    .map((path) => allow("POST", `/api/v1/agents${path}`, "workspace.agents.manage")),
  allow("PUT", "/api/v1/agents/:agentId", "workspace.agents.manage"),
  ...["/:agentId/directives/:directiveId", "/:agentId/routines/:routineId"]
    .map((path) => allow("PATCH", `/api/v1/agents${path}`, "workspace.agents.manage")),
  ...["/:agentId", "/:agentId/directives/:directiveId", "/:agentId/routines/:routineId", "/:agentId/assistant-logo"]
    .map((path) => allow("DELETE", `/api/v1/agents${path}`, path === "/:agentId" ? "workspace.agents.delete" : "workspace.agents.manage")),

  allow("POST", "/api/v1/context-variables", "workspace.agents.manage"),
  ...["/api/v1/context-variables", "/api/v1/context-variables/:id", "/api/v1/context-variables/:id/values", "/api/v1/agents/:agentId/context-variables"]
    .map((path) => allow("GET", path, "workspace.agents.read")),
  allow("PATCH", "/api/v1/context-variables/:id", "workspace.agents.manage"),
  allow("DELETE", "/api/v1/context-variables/:id", "workspace.agents.manage"),
  allow("PUT", "/api/v1/agents/:agentId/context-variables/:variableId", "workspace.agents.manage"),
  allow("DELETE", "/api/v1/agents/:agentId/context-variables/:variableId", "workspace.agents.manage"),
  allow("PUT", "/api/v1/context-variables/:id/values", "workspace.agents.manage"),
  allow("DELETE", "/api/v1/context-variables/:id/values", "workspace.agents.manage"),

  allow("GET", "/api/v1/skills", "workspace.skills.read"),
  allow("GET", "/api/v1/skills/:skillName", "workspace.skills.read"),
  allow("GET", "/api/v1/quality/turns", "workspace.quality.read"),
  allow("GET", "/api/v1/quality/stats", "workspace.quality.read"),
  allow("PUT", "/api/v1/quality/turns/:assistantMessageId/triage", "workspace.quality.manage"),
  sessionOnly("GET", "/api/v1/quality/audience-pulse", "workspace.quality.read"),
  sessionOnly("GET", "/api/v1/quality/audience-pulse/refresh-status", "workspace.quality.read"),
  sessionOnly("POST", "/api/v1/quality/audience-pulse/evidence-anchor", "workspace.history.read"),
  sessionOnly("POST", "/api/v1/quality/audience-pulse", "workspace.quality.read"),

  ...["/snapshots", "/cases", "/cases/run", "/cases/:id/runs", "/runs"]
    .map((path) => allow("POST", `/api/v1/evals${path}`, "workspace.retrieval.query")),
  ...["/snapshots/:id", "/cases", "/cases/:id", "/cases/by-source-message/:assistantMessageId"]
    .map((path) => allow("GET", `/api/v1/evals${path}`, "workspace.retrieval.query")),
  allow("PUT", "/api/v1/evals/cases/by-source-message/:assistantMessageId", "workspace.retrieval.query"),
  allow("PUT", "/api/v1/evals/cases/:id/assertions", "workspace.retrieval.query"),
  // Enabling real external skill effects is an interactive, deliberately confirmed operator decision.
  sessionOnly("PUT", "/api/v1/evals/cases/:id/execution-mode", "workspace.retrieval.query"),
  allow("PATCH", "/api/v1/evals/cases/:id", "workspace.retrieval.query"),
  allow("DELETE", "/api/v1/evals/cases/:id", "workspace.retrieval.query"),

  ...["/retrieval-defaults", "/ingestion", "/ingestion/embedding-coverage", "/document-types"]
    .map((path) => allow("GET", `/api/v1/settings${path}`, "workspace.settings.read")),
  ...["/ingestion", "/document-types"]
    .map((path) => allow("PUT", `/api/v1/settings${path}`, "workspace.settings.manage")),
  allow("POST", "/api/v1/settings/ingestion/embedding-model/cancel", "workspace.settings.manage"),
  allow("POST", "/api/v1/settings/ingestion/reprocess", "workspace.documents.manage"),
  sessionOnly("GET", "/api/v1/settings", "workspace.settings.read"),
  sessionOnly("PUT", "/api/v1/settings", "workspace.settings.manage"),
  sessionOnly("GET", "/api/v1/settings/general", "workspace.settings.read"),
  sessionOnly("PUT", "/api/v1/settings/general", "workspace.settings.manage"),
  sessionOnly("POST", "/api/v1/settings/general/assistant-logo", "workspace.settings.manage"),
  sessionOnly("DELETE", "/api/v1/settings/general/assistant-logo", "workspace.settings.manage"),

  sessionOnly("POST", "/api/v1/settings/general/anonymous-chat-token/rotate"),
  sessionOnly("POST", "/api/v1/settings/general/website-embed-token/rotate"),
  sessionOnly("POST", "/api/v1/agents/:agentId/anonymous-chat-token/rotate"),
  sessionOnly("POST", "/api/v1/agents/:agentId/website-embed-token/rotate"),
  sessionOnly("POST", "/api/v1/agents/:agentId/assistant-logo", "workspace.agents.manage"),
  sessionOnly("DELETE", "/api/v1/agents/:agentId/assistant-logo", "workspace.agents.manage"),
  sessionOnly("POST", "/api/v1/agents/:agentId/default", "workspace.agents.manage"),
  sessionOnly("GET", "/api/v1/agents/:agentId/context-variables/signing-key"),
  sessionOnly("POST", "/api/v1/agents/:agentId/channel-credentials", "workspace.agents.manage"),
  sessionOnly("GET", "/api/v1/agents/:agentId/channel-credentials", "workspace.agents.manage"),
  sessionOnly("POST", "/api/v1/agents/:agentId/channel-credentials/:credentialId/rotate", "workspace.agents.manage"),
  sessionOnly("POST", "/api/v1/agents/:agentId/channel-credentials/:credentialId/revoke", "workspace.agents.manage"),

  // Credential-management and operator surfaces intentionally have an explicit
  // session-only policy rather than relying on default denial. This makes new
  // mounted routes fail the route-inventory contract until their decision is made.
  ...[
    ["GET", "/api/v1/account/workspaces/:workspaceId/api-access", "workspace.api_access.personal.manage"],
    ["GET", "/api/v1/account/workspaces/:workspaceId/api-access/personal-tokens", "workspace.api_access.personal.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/personal-tokens", "workspace.api_access.personal.manage"],
    ["PATCH", "/api/v1/account/workspaces/:workspaceId/api-access/personal-tokens/:credentialId", "workspace.api_access.personal.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/personal-tokens/:credentialId/rotate", "workspace.api_access.personal.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/personal-tokens/:credentialId/revoke", "workspace.api_access.personal.manage"],
    ["GET", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts", "workspace.api_access.service.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts", "workspace.api_access.service.manage"],
    ["GET", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId", "workspace.api_access.service.manage"],
    ["PATCH", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId", "workspace.api_access.service.manage"],
    ...["disable", "enable", "archive"].map((action) => ["POST", `/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/${action}`, "workspace.api_access.service.manage"] as const),
    ["GET", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials", "workspace.api_access.service.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials", "workspace.api_access.service.manage"],
    ["PATCH", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId", "workspace.api_access.service.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId/rotate", "workspace.api_access.service.manage"],
    ["POST", "/api/v1/account/workspaces/:workspaceId/api-access/service-accounts/:serviceAccountId/credentials/:credentialId/revoke", "workspace.api_access.service.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  ...[
    ["GET", "/api/v1/settings/credentials", "workspace.settings.read"],
    ["PUT", "/api/v1/settings/credentials/:provider", "workspace.credentials.manage"],
    ["DELETE", "/api/v1/settings/credentials/:provider", "workspace.credentials.manage"],
    ["GET", "/api/v1/settings/llm-models", "workspace.settings.read"],
    ["PUT", "/api/v1/settings/llm-models", "workspace.llm-models.manage"],
    ["GET", "/api/v1/settings/webhook-destinations", "workspace.settings.read"],
    ["POST", "/api/v1/settings/webhook-destinations", "workspace.settings.manage"],
    ["GET", "/api/v1/settings/webhook-destinations/:id", "workspace.settings.read"],
    ["PUT", "/api/v1/settings/webhook-destinations/:id", "workspace.settings.manage"],
    ["POST", "/api/v1/settings/webhook-destinations/:id/rotate-secret", "workspace.settings.manage"],
    ["DELETE", "/api/v1/settings/webhook-destinations/:id", "workspace.settings.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  ...[
    ["GET", "/api/v1/agents/:agentId/mcp-connections", "workspace.agents.read"],
    ["POST", "/api/v1/agents/:agentId/mcp-connections", "workspace.agents.manage"],
    ["POST", "/api/v1/agents/:agentId/mcp-connections/:connectionId/discover", "workspace.agents.manage"],
    ["POST", "/api/v1/agents/:agentId/mcp-connections/:connectionId/oauth/authorize", "workspace.agents.manage"],
    ["POST", "/api/v1/agents/:agentId/mcp-connections/:connectionId/oauth/complete", "workspace.agents.manage"],
    ["GET", "/api/v1/agents/:agentId/mcp-connections/:connectionId", "workspace.agents.read"],
    ["PATCH", "/api/v1/agents/:agentId/mcp-connections/:connectionId", "workspace.agents.manage"],
    ["DELETE", "/api/v1/agents/:agentId/mcp-connections/:connectionId", "workspace.agents.manage"],
    ...["external-skills", "email-skills", "webhook-skills", "slack-skills"].flatMap((resource) => [
      ["GET", `/api/v1/agents/:agentId/${resource}`, "workspace.agents.read"],
      ["POST", `/api/v1/agents/:agentId/${resource}`, "workspace.agents.manage"],
      ["GET", `/api/v1/agents/:agentId/${resource}/:skillId`, "workspace.agents.read"],
      ["PATCH", `/api/v1/agents/:agentId/${resource}/:skillId`, "workspace.agents.manage"],
      ["DELETE", `/api/v1/agents/:agentId/${resource}/:skillId`, "workspace.agents.manage"],
    ] as const),
    ["GET", "/api/v1/agents/:agentId/skill-capabilities", "workspace.agents.read"],
    ["GET", "/api/v1/agents/:agentId/skills", "workspace.agents.read"],
    ["POST", "/api/v1/agents/:agentId/skills", "workspace.agents.manage"],
    ["PATCH", "/api/v1/agents/:agentId/skills/:skillId", "workspace.agents.manage"],
    ["DELETE", "/api/v1/agents/:agentId/skills/:skillId", "workspace.agents.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  ...[
    ["POST", "/api/v1/conversations/:conversationId/takeover"],
    ["POST", "/api/v1/conversations/:conversationId/reply"],
    ["POST", "/api/v1/conversations/:conversationId/transfer"],
    ["POST", "/api/v1/conversations/:conversationId/handback"],
    ["POST", "/api/v1/conversations/:conversationId/fork"],
    ["POST", "/api/v1/agents/:agentId/decisions/:handle/resolve"],
    ["GET", "/api/v1/decisions"],
  ].map(([method, path]) => sessionOnly(method, path, "workspace.conversation.takeover")),
  ...[
    ["GET", "/api/v1/connectors", "workspace.settings.read"],
    ["GET", "/api/v1/connectors/:connectorId", "workspace.credentials.manage"],
    ["PUT", "/api/v1/connectors/:connectorId", "workspace.credentials.manage"],
    ["POST", "/api/v1/connectors/:connectorId/enable", "workspace.credentials.manage"],
    ["POST", "/api/v1/connectors/:connectorId/disable", "workspace.credentials.manage"],
    ["POST", "/api/v1/connectors/:connectorId/sync", "workspace.credentials.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  ...[
    ["GET", "/api/v1/copilot/availability", "workspace.agents.read"],
    ["GET", "/api/v1/copilot/conversations", "workspace.agents.read"],
    ["GET", "/api/v1/copilot/conversations/:conversationId", "workspace.agents.read"],
    ["DELETE", "/api/v1/copilot/conversations/:conversationId", "workspace.agents.read"],
    ["GET", "/api/v1/copilot/proposals/:proposalId", "workspace.agents.read"],
    ["POST", "/api/v1/copilot/proposals/:proposalId/apply", "workspace.agents.manage"],
    ["POST", "/api/v1/copilot/proposals/:proposalId/dismiss", "workspace.agents.read"],
    ["POST", "/api/v1/copilot/turns", "workspace.chat.use"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
  ...["/analyze-website", "/analyze-website/stream", "/create"]
    .map((path) => sessionOnly("POST", `/api/v1/agent-wizard${path}`, "workspace.agents.manage")),
  ...["PUT", "DELETE"].map((method) =>
    sessionOnly(method, "/api/v1/answer-feedback/messages/:assistantMessageId", "workspace.chat.use")),
  ...[
    ["POST", "/api/v1/workspaces/:workspaceId/oauth-connections", "workspace.settings.manage"],
    ["GET", "/api/v1/workspaces/:workspaceId/oauth-connections", "workspace.settings.read"],
    ["GET", "/api/v1/workspaces/:workspaceId/oauth-connections/:connectionId", "workspace.settings.read"],
    ["POST", "/api/v1/workspaces/:workspaceId/oauth-connections/:connectionId/reauthorize", "workspace.settings.manage"],
    ["GET", "/api/v1/workspaces/:workspaceId/email-connections", "workspace.settings.read"],
    ["GET", "/api/v1/workspaces/:workspaceId/email-oauth-connections", "workspace.settings.read"],
    ["POST", "/api/v1/workspaces/:workspaceId/email-connections", "workspace.settings.manage"],
    ["PATCH", "/api/v1/workspaces/:workspaceId/email-connections/:connectionId", "workspace.settings.manage"],
    ["POST", "/api/v1/workspaces/:workspaceId/email-connections/:connectionId/health-check", "workspace.settings.manage"],
    ["DELETE", "/api/v1/workspaces/:workspaceId/email-connections/:connectionId", "workspace.settings.manage"],
    ["GET", "/api/v1/workspaces/:workspaceId/email-skill-activity", "workspace.settings.read"],
    ["POST", "/api/v1/workspaces/:workspaceId/slack/install/start", "workspace.agents.manage"],
    ["GET", "/api/v1/workspaces/:workspaceId/slack/install/status", "workspace.agents.read"],
    ["GET", "/api/v1/workspaces/:workspaceId/slack/manifest", "workspace.agents.read"],
    ["GET", "/api/v1/workspaces/:workspaceId/slack/binding", "workspace.agents.read"],
    ["GET", "/api/v1/workspaces/:workspaceId/slack/bindings", "workspace.agents.read"],
    ["PUT", "/api/v1/workspaces/:workspaceId/slack/binding", "workspace.agents.manage"],
    ["DELETE", "/api/v1/workspaces/:workspaceId/slack/binding", "workspace.agents.manage"],
    ["DELETE", "/api/v1/workspaces/:workspaceId/slack/installation", "workspace.agents.manage"],
  ].map(([method, path, permission]) => sessionOnly(method, path, permission)),
];

export const apiPrincipalRoutePolicy: Readonly<Record<string, ApiPrincipalRouteEligibility>> =
  Object.freeze(Object.fromEntries(declarations.map(([method, pathPattern, permission, interactiveOnly]) => [
    `${method} ${pathPattern}`,
    {
      permission,
      allowedPrincipalKinds: interactiveOnly ? sessionPrincipalKinds : ordinaryPrincipalKinds,
      sessionOnly: interactiveOnly ?? false,
    },
  ])));

const machineKinds = new Set<AuthenticatedPrincipal["type"]>(machinePrincipalKinds);
const pathMatches = (pattern: string, path: string): boolean => {
  const expected = pattern.split("/").filter(Boolean);
  const actual = path.split("/").filter(Boolean);
  return expected.length === actual.length && expected.every((segment, index) =>
    segment.startsWith(":") ? actual[index]?.length > 0 : segment === actual[index]);
};

export const allowsMachinePrincipal = (method: string, path: string, principal: AuthenticatedPrincipal): boolean => {
  if (!machineKinds.has(principal.type)) return true;
  const normalizedMethod = method.toUpperCase();
  const candidates = Object.entries(apiPrincipalRoutePolicy)
    .filter(([key]) => {
      const separator = key.indexOf(" ");
      return key.slice(0, separator) === normalizedMethod && pathMatches(key.slice(separator + 1), path);
    })
    .sort(([left], [right]) => {
      const literalCount = (key: string) => key.split("/").filter((part) => part && !part.startsWith(":" )).length;
      return literalCount(right) - literalCount(left);
    });
  const rule = candidates[0]?.[1];
  return rule?.allowedPrincipalKinds.includes(principal.type) ?? false;
};
