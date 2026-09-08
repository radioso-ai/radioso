import { badRequest } from "../../shared/domain/errors.js";
import { splitRetrievalAnswerEnvelope } from "../agents/public.js";
import type { AgentConfig, AgentInput } from "../agents/public.js";
import type { AgentBundleUnresolvedReference } from "./domain.js";

/**
 * Turns an exported `AgentConfig` back into the input a new agent can be created
 * with, and names everything it had to drop.
 *
 * The export replaced non-portable values with `{ __ref }` / `{ __redacted }`
 * placeholders. Import must not write a placeholder into a real column, and — the
 * point of this file — it must not resolve one in the *permissive* direction
 * either. A selected source scope whose ids cannot be matched imports as
 * selected-and-empty, never as `all`: widening what an agent may read is the one
 * failure mode an operator would not notice.
 */

const requireConfigSection = <T>(value: T, path: string): NonNullable<T> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw badRequest(`Bundle agent config is missing ${path}; this is not an exported agent bundle.`);
  }
  return value;
};

const isPlaceholder = (value: unknown): boolean =>
  typeof value === "object"
  && value !== null
  && !Array.isArray(value)
  && ("__ref" in (value as Record<string, unknown>) || "__redacted" in (value as Record<string, unknown>));


export interface AgentConfigImportProjection {
  input: AgentInput;
  unresolved: AgentBundleUnresolvedReference[];
}

export const projectAgentConfigForImport = (config: AgentConfig): AgentConfigImportProjection => {
  const unresolved: AgentBundleUnresolvedReference[] = [];

  if (config.contactRequestsEnabled) {
    unresolved.push({
      kind: "contact_delivery_unbound",
      element: "contactRequestDelivery",
      detail: "Contact requests are on, but the recipients and webhook stay in the source workspace — an imported agent must not deliver to another workspace's people. Set a destination under the agent's contact settings.",
    });
  }

  if (config.logo) {
    unresolved.push({
      kind: "asset_not_portable",
      element: `logo:${config.logo.filename}`,
      detail: "The logo image lives in object storage, not in the bundle. Re-upload it on the imported agent.",
    });
  }

  const sourceScope = projectSourceScope(config, unresolved);
  const surfaceSettings = projectSurfaceSettings(config, unresolved);
  // The projection wraps the default retrieve skill in an envelope carrying
  // agent-level fields; the stored agent keeps them flat. Splitting it with the
  // agents module's own helper is what keeps export and import from disagreeing.
  const retrieval = splitRetrievalAnswerEnvelope(
    stripPlaceholders(config.skillSettings) as never,
  );

  // The bundle carries MCP connections and external skills (the export already
  // projects them, credentials placeheld). Re-creating them on import is deferred:
  // a connection needs its credential re-entered or its OAuth flow re-run before it
  // can serve, so it always needs the operator anyway. They are reported one by one
  // rather than dropped, so nobody discovers a missing tool at answer time.
  for (const connection of config.externalSkills?.connections ?? []) {
    unresolved.push({
      kind: "mcp_connection_unbound",
      element: `mcpConnection:${connection.displayName}`,
      detail: `Reconnect ${connection.displayName} (${connection.serverUrl}) under External skills; its credential is not part of the bundle.`,
    });
  }
  for (const skill of config.externalSkills?.skills ?? []) {
    unresolved.push({
      kind: "mcp_connection_unbound",
      element: `externalSkill:${skill.skillName}`,
      detail: `Re-create the external skill "${skill.skillName}" (tool ${skill.toolName}) once its MCP connection is reconnected.`,
    });
  }

  return {
    input: {
      name: config.name,
      internalName: config.internalName ?? undefined,
      customInstruction: config.customInstruction,
      handoffOnRetrievalMiss: config.handoffOnRetrievalMiss ?? false,
      retrievalEnabled: retrieval.retrievalEnabled,
      suggestedQuestionsEnabled: retrieval.suggestedQuestionsEnabled,
      assistantLinkUtmEnabled: retrieval.assistantLinkUtmEnabled,
      citationDisplayEnabled: retrieval.citationDisplayEnabled,
      contactRequestsEnabled: config.contactRequestsEnabled,
      webhookExportsEnabled: config.webhookExportsEnabled,
      // Cleared, never carried: keeping the source workspace's recipients or webhook
      // would have the imported agent quietly deliver contact requests to another
      // workspace's people. Contact requests still collect; they just have nowhere to
      // go until the operator sets a destination here.
      contactRequestDelivery: { recipientEmails: [], webhook: null },
      // The logo is the only behavior-settings field the bundle cannot carry.
      logo: null,
      theme: config.theme,
      branding: config.branding,
      greetingInstruction: config.greetingInstruction,
      assistantDefaultLocale: config.assistantDefaultLocale,
      proactiveGreetingEnabled: config.proactiveGreetingEnabled,
      sourceScope,
      skillSettings: retrieval.skillSettings,
      chatModelOverride: config.chatModelOverride,
      surfaceSettings,
    },
    unresolved,
  };
};

const retrievalDefaults = (config: AgentConfig) =>
  config.skillSettings?.["retrieval.answer"]?.settings?.__agentRetrievalDefaults;

const projectSourceScope = (
  config: AgentConfig,
  unresolved: AgentBundleUnresolvedReference[],
): AgentInput["sourceScope"] => {
  const scope = retrievalDefaults(config)?.sourceScope;
  if (!scope || scope.mode === "all") {
    return { mode: "all" };
  }
  if (scope.sourceIds.length > 0) {
    unresolved.push({
      kind: "document_source_unresolved",
      element: "sourceScope",
      detail: `The source agent answered from ${scope.sourceIds.length} selected source(s). Document ids do not travel, so the imported agent starts with none selected — pick its sources under Knowledge.`,
    });
  }
  return { mode: "selected", sourceIds: [] };
};

/**
 * A surface whose token was redacted imports disabled. Enabling a chat surface
 * with no credential would either mint a new token silently — publishing an agent
 * the importer never asked to publish — or serve a broken surface.
 */
const projectSurfaceSettings = (
  config: AgentConfig,
  unresolved: AgentBundleUnresolvedReference[],
): AgentInput["surfaceSettings"] => {
  // The transport schema decides whether a body is a bundle, not what one contains,
  // so a body shallow enough to be missing these reaches this far. Reading through
  // it would be an unhandled TypeError — a 500 for a malformed request. Rejecting is
  // also the only safe answer: defaulting an absent surface section would create an
  // agent whose surfaces nobody described, and getting that wrong in the permissive
  // direction is what this file exists to prevent.
  const surfaces = requireConfigSection(config.surfaceSettings, "surfaceSettings");
  requireConfigSection(surfaces.authenticatedChat, "surfaceSettings.authenticatedChat");
  requireConfigSection(surfaces.anonymousChat, "surfaceSettings.anonymousChat");
  requireConfigSection(surfaces.websiteEmbed, "surfaceSettings.websiteEmbed");
  const anonymousBlocked = surfaces.anonymousChat.enabled && isPlaceholder(surfaces.anonymousChat.token);
  const embedBlocked = surfaces.websiteEmbed.enabled && isPlaceholder(surfaces.websiteEmbed.token);

  if (anonymousBlocked) {
    unresolved.push({
      kind: "surface_credential_unbound",
      element: "surfaceSettings.anonymousChat",
      detail: "Public chat was on. Its access token does not travel, so the surface imports off — turn it on to mint a new one.",
    });
  }
  if (embedBlocked) {
    unresolved.push({
      kind: "surface_credential_unbound",
      element: "surfaceSettings.websiteEmbed",
      detail: "The website embed was on. Its token and allowed origins do not travel, so the surface imports off — turn it on and re-add the origins.",
    });
  }

  return {
    authenticatedChat: { enabled: surfaces.authenticatedChat.enabled },
    anonymousChat: { enabled: surfaces.anonymousChat.enabled && !anonymousBlocked },
    websiteEmbed: {
      ...stripPlaceholders(surfaces.websiteEmbed),
      enabled: surfaces.websiteEmbed.enabled && !embedBlocked,
      allowedOrigins: [],
    },
    extensions: stripPlaceholders(surfaces.extensions),
  } as AgentInput["surfaceSettings"];
};

/**
 * Drops any subtree still holding a placeholder. Deliberately generic: a
 * placeholder kind added later is dropped by default rather than written into a
 * column as `{"__ref":"..."}` because nobody remembered this function.
 */
const stripPlaceholders = <T>(value: T): T => {
  if (isPlaceholder(value)) {
    return undefined as unknown as T;
  }
  if (Array.isArray(value)) {
    // Drop an element that *is* a placeholder; recurse into one that merely
    // contains one, exactly as the object branch below drops only the offending
    // key and keeps its siblings. Dropping an entry because something nested
    // inside it could not travel would throw the whole entry away — the silent,
    // over-wide narrowing this file exists to prevent.
    return value.filter((entry) => !isPlaceholder(entry)).map(stripPlaceholders) as unknown as T;
  }
  if (typeof value === "object" && value !== null) {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (isPlaceholder(entry)) {
        continue;
      }
      result[key] = stripPlaceholders(entry);
    }
    return result as unknown as T;
  }
  return value;
};
