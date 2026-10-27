import type { WorkspaceModelAvailability } from "../../shared/domain/workspaceModelAvailability.js";
import { knownModelsByProvider } from "../../shared/infra/llm/knownModels.js";
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
 * it holds a key for, and otherwise only what the platform key serves. Composition builds one
 * instance and hands it to the capability resolver (what a call runs) and to the settings and
 * agent write paths (what a picker offers and a write accepts), so all three apply one rule.
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

  /** Served deployments outside the catalog (an embedding model) are never pickable, so they are left out. */
  async runnableModels(workspaceId: string, provider: LlmProviderName): Promise<readonly string[] | null> {
    const served = this.platform.servedModels(provider);
    if (served === null || await this.deps.credentials.hasCredentials(workspaceId, provider)) {
      return null;
    }
    return knownModelsByProvider[provider].filter((model) => served.includes(model));
  }
}
