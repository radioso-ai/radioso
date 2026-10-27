import type { WorkspaceModelAvailability } from "../../shared/domain/workspaceModelAvailability.js";
import {
  platformModelAvailability,
  type PlatformModelAvailability,
} from "../../shared/infra/llm/platformModelAvailability.js";
import type { LlmProviderName, ResolvedLlmConfig } from "../../shared/infra/llm/providerTypes.js";

interface WorkspaceProviderKeyPresencePort {
  /** Presence only; never decrypts. */
  hasCredentials(workspaceId: string, provider: LlmProviderName): Promise<boolean>;
}

/**
 * A workspace's own key never reaches the platform endpoint, so it runs any model on a provider
 * it holds a key for, and otherwise only what the platform key serves. The capability resolver
 * builds one from its own defaults and credentials for the per-call decision; composition builds
 * one from the same defaults and credential service for the settings and agent write paths, so
 * what a picker offers, what a write accepts, and what a call runs are one rule.
 */
export class PlatformAwareWorkspaceModelAvailability implements WorkspaceModelAvailability {
  private readonly platform: PlatformModelAvailability;

  constructor(private readonly deps: {
    defaults: Pick<ResolvedLlmConfig, "openAIPlatformEndpoint">;
    credentials: WorkspaceProviderKeyPresencePort;
  }) {
    this.platform = platformModelAvailability(deps.defaults);
  }

  /** The credential lookup runs only for a model the platform key does not serve. */
  async canRun(workspaceId: string, provider: LlmProviderName, model: string): Promise<boolean> {
    return this.platform.serves(provider, model) || this.deps.credentials.hasCredentials(workspaceId, provider);
  }

  async runnableModels(workspaceId: string, provider: LlmProviderName): Promise<readonly string[] | null> {
    const served = this.platform.servedModels(provider);
    if (served === null) {
      return null;
    }
    return (await this.deps.credentials.hasCredentials(workspaceId, provider)) ? null : served;
  }
}
