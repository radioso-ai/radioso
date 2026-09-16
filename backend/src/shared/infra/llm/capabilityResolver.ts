import type {
  LlmCapabilityConfig,
  LlmCapabilityName,
  LlmCapabilitySelection,
} from "./providerTypes.js";
import type { LlmCapabilityResolveInput } from "./workspaceContext.js";

export type { LlmCapabilityResolveInput } from "./workspaceContext.js";

/**
 * Resolves a final per-call `LlmCapabilityConfig` (provider, model, API key,
 * baseUrl) for a given capability and workspace context. Intended to be
 * imported only by the LLM infrastructure layer and the composition wiring
 * that assembles it — chat / retrieval call sites should depend on
 * `workspaceContext.ts` for the context shape, not on this interface.
 */
/** The call-time half of the resolver: what a client factory needs to build a credentialed client. */
export type LlmCapabilityConfigResolver = Pick<LlmCapabilityResolver, "resolve">;

export interface LlmCapabilityResolver {
  resolve(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilityConfig>;
  /**
   * The same provider/model decision as `resolve`, without touching keys or
   * base URLs. Lets a settings surface show what a call would run on.
   */
  resolveSelection(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilitySelection>;
}
