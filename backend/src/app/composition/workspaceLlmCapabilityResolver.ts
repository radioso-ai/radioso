import type {
  LlmCapabilityConfig,
  LlmCapabilityName,
  LlmProviderName,
  ResolvedLlmConfig,
} from "../../shared/infra/llm/providerTypes.js";
import type {
  LlmCapabilityResolveInput,
  LlmCapabilityResolver,
} from "../../shared/infra/llm/capabilityResolver.js";
import type {
  WorkspaceLlmCapability,
  WorkspaceLlmCapabilityPreference,
} from "../../modules/settings/contracts/llmCapability.js";
import { ProviderConfigurationError } from "../../shared/infra/llm/providerTypes.js";

export interface WorkspaceCapabilityPreferencePort {
  getPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
  ): Promise<WorkspaceLlmCapabilityPreference | null>;
}

export interface WorkspaceCapabilityCredentialPort {
  getApiKey(workspaceId: string, provider: LlmProviderName): Promise<string | undefined>;
}

export interface EnvProviderKeyResolver {
  resolveEnvApiKey(provider: LlmProviderName): string | undefined;
}

export interface WorkspaceLlmCapabilityResolverDependencies {
  defaults: ResolvedLlmConfig;
  settings: WorkspaceCapabilityPreferencePort;
  credentials: WorkspaceCapabilityCredentialPort;
  envKeys: EnvProviderKeyResolver;
  /** Base URLs for env-configured providers (e.g. openai-compatible). */
  envBaseUrls?: Partial<Record<LlmProviderName, string>>;
}

const isWorkspaceCapability = (capability: LlmCapabilityName): capability is WorkspaceLlmCapability =>
  capability === "chat" || capability === "rewrite" || capability === "rerank";

export class WorkspaceLlmCapabilityResolver implements LlmCapabilityResolver {
  constructor(private readonly deps: WorkspaceLlmCapabilityResolverDependencies) {}

  async resolve(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilityConfig> {
    const envDefault = this.deps.defaults[capability];

    const resolvedProviderAndModel = await this.resolveProviderAndModel(capability, input);
    const { provider, model } = resolvedProviderAndModel;

    if (provider === envDefault.provider && model === envDefault.model) {
      const overrideKey = await this.deps.credentials.getApiKey(input.workspaceId, provider);
      if (overrideKey) {
        return { ...envDefault, apiKey: overrideKey };
      }
      return envDefault;
    }

    const apiKey = await this.resolveApiKey(input.workspaceId, provider, capability);
    const baseUrl = this.resolveBaseUrl(provider, capability, envDefault);

    return {
      capability,
      provider,
      model,
      apiKey,
      ...(baseUrl ? { baseUrl } : {}),
    };
  }

  private async resolveProviderAndModel(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<{ provider: LlmProviderName; model: string }> {
    if (input.capabilityOverride) {
      return {
        provider: input.capabilityOverride.provider,
        model: input.capabilityOverride.model,
      };
    }

    if (isWorkspaceCapability(capability)) {
      const preference = await this.deps.settings.getPreference(input.workspaceId, capability);
      if (preference) {
        return { provider: preference.provider, model: preference.model };
      }
    }

    const envDefault = this.deps.defaults[capability];
    return { provider: envDefault.provider, model: envDefault.model };
  }

  private async resolveApiKey(
    workspaceId: string,
    provider: LlmProviderName,
    capability: LlmCapabilityName,
  ): Promise<string> {
    const workspaceKey = await this.deps.credentials.getApiKey(workspaceId, provider);
    if (workspaceKey) {
      return workspaceKey;
    }
    const envKey = this.deps.envKeys.resolveEnvApiKey(provider);
    if (envKey) {
      return envKey;
    }
    throw new ProviderConfigurationError(
      `No API key configured for provider "${provider}". Add a workspace credential at Settings → Credentials, or set the matching environment variable and restart Radioso.`,
      {
        kind: "missing_api_key",
        provider,
        capability,
        remediation: "Add a workspace credential at Settings → Credentials, or set the matching environment variable and restart Radioso.",
      },
    );
  }

  private resolveBaseUrl(
    provider: LlmProviderName,
    capability: LlmCapabilityName,
    envDefault: LlmCapabilityConfig,
  ): string | undefined {
    if (provider !== "openai-compatible") {
      return undefined;
    }
    const inheritedBaseUrl = provider === envDefault.provider ? envDefault.baseUrl : undefined;
    const envBaseUrl = this.deps.envBaseUrls?.[provider];
    const baseUrl = inheritedBaseUrl ?? envBaseUrl;
    if (!baseUrl) {
      throw new ProviderConfigurationError(
        "openai-compatible requires OPENAI_COMPATIBLE_BASE_URL to be configured; selecting this provider for a workspace without a base URL would silently call the default OpenAI endpoint.",
        {
          kind: "missing_base_url",
          provider,
          capability,
          setting: "OPENAI_COMPATIBLE_BASE_URL",
          remediation: "Set OPENAI_COMPATIBLE_BASE_URL on the backend and restart Radioso.",
        },
      );
    }
    return baseUrl;
  }
}
