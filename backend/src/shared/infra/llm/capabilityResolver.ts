import type {
  LlmCapabilityConfig,
  LlmCapabilityName,
} from "./providerTypes.js";
import type { LlmCapabilityResolveInput } from "./workspaceContext.js";

export type { LlmCapabilityOverride, LlmCapabilityResolveInput } from "./workspaceContext.js";

/**
 * Resolves a final per-call `LlmCapabilityConfig` (provider, model, API key,
 * baseUrl) for a given capability and workspace context. Intended to be
 * imported only by the LLM infrastructure layer and the composition wiring
 * that assembles it — chat / retrieval call sites should depend on
 * `workspaceContext.ts` for the context shape, not on this interface.
 */
export interface LlmCapabilityResolver {
  resolve(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilityConfig>;
}
