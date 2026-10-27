import type {
  LlmCapabilityConfig,
  LlmCapabilityDefault,
  LlmCapabilityName,
  LlmCapabilityResolvedBy,
  LlmCapabilitySelection,
  LlmProviderName,
  OpenAIDataResidency,
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
import { platformOpenAIEndpointFields, ProviderConfigurationError } from "../../shared/infra/llm/providerTypes.js";
import type { ManagedModelPolicy } from "../../shared/domain/managedModelPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import { PlatformAwareWorkspaceModelAvailability } from "./workspaceModelAvailability.js";

interface WorkspaceCapabilityPreferencePort {
  getPreference(
    workspaceId: string,
    capability: WorkspaceLlmCapability,
  ): Promise<WorkspaceLlmCapabilityPreference | null>;
}

interface WorkspaceCapabilityCredentialPort {
  getApiKey(workspaceId: string, provider: LlmProviderName): Promise<string | undefined>;
  /** Presence only; never decrypts. */
  hasCredentials(workspaceId: string, provider: LlmProviderName): Promise<boolean>;
  /**
   * The workspace's own OpenAI credential's authored residency; `global` when it has none. Only
   * ever called when an "openai" workspace credential just answered `getApiKey` above, so this
   * never has to invent a value for a provider or workspace with no credential.
   */
  getOpenAIResidency(workspaceId: string): Promise<OpenAIDataResidency>;
}

interface EnvProviderKeyResolver {
  resolveEnvApiKey(provider: LlmProviderName): string | undefined;
}

interface WorkspaceLlmCapabilityResolverDependencies {
  defaults: ResolvedLlmConfig;
  settings: WorkspaceCapabilityPreferencePort;
  credentials: WorkspaceCapabilityCredentialPort;
  envKeys: EnvProviderKeyResolver;
  /**
   * The env-configured openai-compatible base URL. Native `openai` never reaches this port —
   * its platform endpoint comes solely from `defaults.openAIPlatformEndpoint` — so there is
   * exactly one channel per provider for "where composition's env config supplies a base URL",
   * not two.
   */
  envBaseUrls?: { "openai-compatible"?: string };
  /** Absent means every workspace picks freely (self-host). */
  managedModelPolicy?: ManagedModelPolicy;
  logger?: Pick<AppLogger, "debug" | "info" | "warn">;
}

const isWorkspaceCapability = (capability: LlmCapabilityName): capability is WorkspaceLlmCapability =>
  capability === "chat" || capability === "rewrite" || capability === "rerank";

const selectionLogFields = (
  capability: LlmCapabilityName,
  workspaceId: string,
  selection: LlmCapabilitySelection,
) => ({
  capability,
  workspaceId,
  resolvedBy: selection.resolvedBy,
  provider: selection.provider,
  model: selection.model,
});

type UnmanagedResolvedBy = Exclude<LlmCapabilityResolvedBy, "managed_plan">;

/**
 * Which credential pool answered an API-key lookup. For native `openai`, this decides whose
 * endpoint governs the call: the platform's own (`defaults.openAIPlatformEndpoint`, which may
 * be a residency or an Azure endpoint) for an "environment" credential, or the workspace's own
 * authored residency (`credentials.getOpenAIResidency`) for a "workspace" one — never a mix of
 * the two.
 */
type LlmCredentialSource = "workspace" | "environment";

interface ResolvedApiKey {
  apiKey: string;
  source: LlmCredentialSource;
}

interface CandidateSelection {
  provider: LlmProviderName;
  model: string;
  resolvedBy: UnmanagedResolvedBy;
}

export class WorkspaceLlmCapabilityResolver implements LlmCapabilityResolver {
  private readonly modelAvailability: PlatformAwareWorkspaceModelAvailability;

  constructor(private readonly deps: WorkspaceLlmCapabilityResolverDependencies) {
    this.modelAvailability = new PlatformAwareWorkspaceModelAvailability({
      defaults: deps.defaults,
      credentials: deps.credentials,
    });
  }

  async resolve(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilityConfig> {
    const envDefault = this.deps.defaults[capability];

    const { provider, model, resolvedBy } = await this.resolveSelection(capability, input);

    const { apiKey, source } = await this.resolveApiKey(input.workspaceId, provider, capability);
    const { baseUrl, openAIDataResidency, openAIAzureBaseUrl } = await this.resolveProviderEndpoint(
      provider,
      capability,
      envDefault,
      input.capabilityOverride?.baseUrl,
      source,
      input.workspaceId,
    );

    return {
      capability,
      provider,
      model,
      apiKey,
      resolvedBy,
      ...(baseUrl ? { baseUrl } : {}),
      ...(openAIDataResidency ? { openAIDataResidency } : {}),
      ...(openAIAzureBaseUrl ? { openAIAzureBaseUrl } : {}),
    };
  }

  async resolveSelection(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilitySelection> {
    const candidate = await this.resolveCandidate(capability, input);
    const managed = await this.resolveManaged(capability, input.workspaceId, candidate.provider);
    const planned: LlmCapabilitySelection = managed
      ? { provider: managed.provider, model: managed.model, resolvedBy: "managed_plan" }
      : candidate;
    if (managed && candidate.resolvedBy !== "environment_default") {
      this.deps.logger?.info(
        {
          ...selectionLogFields(capability, input.workspaceId, planned),
          overrode: candidate.resolvedBy,
          requestedProvider: candidate.provider,
          requestedModel: candidate.model,
        },
        "Managed plan replaced the requested LLM model",
      );
    }

    const selection = await this.withinPlatformAvailability(capability, input.workspaceId, planned);
    this.deps.logger?.debug(selectionLogFields(capability, input.workspaceId, selection), "Resolved LLM capability");
    return selection;
  }

  /**
   * A model the platform key cannot serve fails every call (on Azure, 404 DeploymentNotFound), so
   * a text capability runs its environment default instead — always served, since the platform's
   * deployments are derived from those defaults. Embeddings never swap: a different embedding
   * model is a different vector space.
   */
  private async withinPlatformAvailability(
    capability: LlmCapabilityName,
    workspaceId: string,
    requested: LlmCapabilitySelection,
  ): Promise<LlmCapabilitySelection> {
    if (
      !isWorkspaceCapability(capability)
      || await this.modelAvailability.canRun(workspaceId, requested.provider, requested.model)
    ) {
      return requested;
    }
    const envDefault = this.deps.defaults[capability];
    const fallback: LlmCapabilitySelection = {
      provider: envDefault.provider,
      model: envDefault.model,
      resolvedBy: "environment_default",
    };
    this.deps.logger?.warn(
      {
        ...selectionLogFields(capability, workspaceId, fallback),
        overrode: requested.resolvedBy,
        requestedProvider: requested.provider,
        requestedModel: requested.model,
      },
      "Platform key cannot serve the requested LLM model; running the environment default",
    );
    return fallback;
  }

  private async resolveCandidate(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<CandidateSelection> {
    if (input.capabilityOverride) {
      return {
        provider: input.capabilityOverride.provider,
        model: input.capabilityOverride.model,
        resolvedBy: "agent_override",
      };
    }

    if (isWorkspaceCapability(capability)) {
      const preference = await this.deps.settings.getPreference(input.workspaceId, capability);
      if (preference) {
        return { provider: preference.provider, model: preference.model, resolvedBy: "workspace_preference" };
      }
    }

    const envDefault = this.deps.defaults[capability];
    return { provider: envDefault.provider, model: envDefault.model, resolvedBy: "environment_default" };
  }

  /**
   * The lock applies to text capabilities only, and only while the workspace
   * has no key of its own for the provider it would otherwise use.
   */
  private async resolveManaged(
    capability: LlmCapabilityName,
    workspaceId: string,
    candidateProvider: LlmProviderName,
  ) {
    if (!this.deps.managedModelPolicy || !isWorkspaceCapability(capability)) {
      return null;
    }
    const managed = await this.deps.managedModelPolicy.resolveManagedModel({ workspaceId, capability });
    if (!managed) {
      return null;
    }
    const ownsCandidateKey = await this.deps.credentials.hasCredentials(workspaceId, candidateProvider);
    return ownsCandidateKey ? null : managed;
  }

  private async resolveApiKey(
    workspaceId: string,
    provider: LlmProviderName,
    capability: LlmCapabilityName,
  ): Promise<ResolvedApiKey> {
    const workspaceKey = await this.deps.credentials.getApiKey(workspaceId, provider);
    if (workspaceKey) {
      return { apiKey: workspaceKey, source: "workspace" };
    }
    const envKey = this.deps.envKeys.resolveEnvApiKey(provider);
    if (envKey) {
      return { apiKey: envKey, source: "environment" };
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

  private async resolveProviderEndpoint(
    provider: LlmProviderName,
    capability: LlmCapabilityName,
    envDefault: LlmCapabilityDefault,
    overrideBaseUrl: string | undefined,
    credentialSource: LlmCredentialSource,
    workspaceId: string,
  ): Promise<{ baseUrl?: string; openAIDataResidency?: OpenAIDataResidency; openAIAzureBaseUrl?: string }> {
    if (provider === "openai") {
      return this.resolveOpenAIEndpoint(credentialSource, workspaceId);
    }

    if (provider !== "openai-compatible") {
      return {};
    }

    const inheritedBaseUrl = provider === envDefault.provider ? envDefault.baseUrl : undefined;
    const envBaseUrl = this.deps.envBaseUrls?.[provider];
    const baseUrl = overrideBaseUrl ?? inheritedBaseUrl ?? envBaseUrl;
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
    return { baseUrl };
  }

  /**
   * Native `openai` never takes an override or inherited binding base URL: the only endpoint a
   * call may ever reach is whichever key answered it resolved to — the workspace's own
   * authored residency (`this.deps.credentials.getOpenAIResidency`) when its BYOK key served the
   * call, or the platform's resolved endpoint (`this.deps.defaults.openAIPlatformEndpoint`,
   * derived once in `providerConfig` from `OPENAI_DATA_RESIDENCY` and `AZURE_OPENAI_ENDPOINT`)
   * when the environment key served it. A workspace's own key can only ever reach an
   * {@link OpenAIDataResidency} host — {@link WorkspaceCapabilityCredentialPort.getOpenAIResidency}
   * has no "azure" value to return — so the Azure endpoint is structurally unreachable from the
   * BYOK branch, never merely unselected by this method's logic. Both branches flatten through
   * `platformOpenAIEndpointFields`, the one place a residency or an Azure endpoint maps to
   * concrete capability fields, so a new region is never two edits.
   */
  private async resolveOpenAIEndpoint(
    credentialSource: LlmCredentialSource,
    workspaceId: string,
  ): Promise<{ baseUrl?: string; openAIDataResidency?: OpenAIDataResidency; openAIAzureBaseUrl?: string }> {
    if (credentialSource === "workspace") {
      const residency = await this.deps.credentials.getOpenAIResidency(workspaceId);
      return platformOpenAIEndpointFields({ kind: "openai", residency });
    }
    const platform = this.deps.defaults.openAIPlatformEndpoint;
    return platform ? platformOpenAIEndpointFields(platform) : {};
  }
}
