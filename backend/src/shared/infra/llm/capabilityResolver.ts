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

/** What the provider registry needs: the call-time half, plus the check its readiness probe makes. */
export type LlmRegistryCapabilityResolver = Pick<LlmCapabilityResolver, "resolve" | "assertResolvable">;

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
  /**
   * Fails with the error `resolve` would give (a missing or unreadable API key, a missing base URL)
   * but returns no config and logs nothing above debug. For a readiness check that asks whether a
   * call could run, often enough that `resolve`'s logging would be noisy.
   */
  assertResolvable(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<void>;
}
