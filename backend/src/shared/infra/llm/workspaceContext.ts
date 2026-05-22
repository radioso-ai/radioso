import type { LlmProviderName } from "./providerTypes.js";

/**
 * Per-call hint that takes precedence over workspace-level capability preferences
 * and env defaults. Typically used to thread an agent's chat model override.
 */
export interface LlmCapabilityOverride {
  provider: LlmProviderName;
  model: string;
}

/**
 * Workspace context attached to chat / retrieval gateway calls so the LLM layer
 * can resolve the right provider, model, and API key for this workspace (with
 * an optional per-call override). Chat / retrieval services pass this through
 * gateways; they should not import the resolver itself.
 */
export interface LlmCapabilityResolveInput {
  workspaceId: string;
  /**
   * Pre-resolved per-call override (e.g. an agent's chat model override).
   * When set, takes precedence over the workspace-level preference and env default.
   */
  capabilityOverride?: LlmCapabilityOverride | null;
}
