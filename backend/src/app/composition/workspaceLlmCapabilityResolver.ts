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
import { OPENAI_RESIDENCY_HOSTS, ProviderConfigurationError } from "../../shared/infra/llm/providerTypes.js";
import type { ManagedModelPolicy } from "../../shared/domain/managedModelPolicy.js";
import type { AppLogger } from "../../shared/observability/logger.js";

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
   * its platform endpoint comes solely from `defaults.openAIPlatformResidency` — so there is
   * exactly one channel per provider for "where composition's env config supplies a base URL",
   * not two.
   */
  envBaseUrls?: { "openai-compatible"?: string };
  /** Absent means every workspace picks freely (self-host). */
  managedModelPolicy?: ManagedModelPolicy;
  logger?: Pick<AppLogger, "debug" | "info">;
}

const isWorkspaceCapability = (capability: LlmCapabilityName): capability is WorkspaceLlmCapability =>
  capability === "chat" || capability === "rewrite" || capability === "rerank";

type UnmanagedResolvedBy = Exclude<LlmCapabilityResolvedBy, "managed_plan">;

/**
 * Which credential pool answered an API-key lookup. For native `openai`, this decides whose
 * residency choice governs the call: the platform's own (`defaults.openAIPlatformResidency`)
 * for an "environment" credential, or the workspace's own authored choice
 * (`credentials.getOpenAIResidency`) for a "workspace" one — never a mix of the two.
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
  constructor(private readonly deps: WorkspaceLlmCapabilityResolverDependencies) {}

  async resolve(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilityConfig> {
    const envDefault = this.deps.defaults[capability];

    const { provider, model, resolvedBy } = await this.resolveSelection(capability, input);

    const { apiKey, source } = await this.resolveApiKey(input.workspaceId, provider, capability);
    const { baseUrl, openAIDataResidency } = await this.resolveProviderEndpoint(
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
    };
  }

  async resolveSelection(
    capability: LlmCapabilityName,
    input: LlmCapabilityResolveInput,
  ): Promise<LlmCapabilitySelection> {
    const candidate = await this.resolveCandidate(capability, input);
    const managed = await this.resolveManaged(capability, input.workspaceId, candidate.provider);
    const selection: LlmCapabilitySelection = managed
      ? { provider: managed.provider, model: managed.model, resolvedBy: "managed_plan" }
      : candidate;

    const logFields = {
      capability,
      workspaceId: input.workspaceId,
      resolvedBy: selection.resolvedBy,
      provider: selection.provider,
      model: selection.model,
    };
    this.deps.logger?.debug(logFields, "Resolved LLM capability");
    if (managed && candidate.resolvedBy !== "environment_default") {
      this.deps.logger?.info(
        {
          ...logFields,
          overrode: candidate.resolvedBy,
          requestedProvider: candidate.provider,
          requestedModel: candidate.model,
        },
        "Managed plan replaced the requested LLM model",
      );
    }
    return selection;
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
  ): Promise<{ baseUrl?: string; openAIDataResidency?: OpenAIDataResidency }> {
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
   * call may ever reach is whichever key answered it resolved data-residency to — the
   * platform's (`this.deps.defaults.openAIPlatformResidency`, derived once in `providerConfig`
   * from `OPENAI_DATA_RESIDENCY`) when the environment key served the call, or the workspace's
   * own authored choice (`this.deps.credentials.getOpenAIResidency`) when its BYOK key served
   * it. Both branches resolve a host through the same table, `OPENAI_RESIDENCY_HOSTS` — the one
   * place a residency maps to a concrete OpenAI host — so a new region is never two edits.
   */
  private async resolveOpenAIEndpoint(
    credentialSource: LlmCredentialSource,
    workspaceId: string,
  ): Promise<{ baseUrl?: string; openAIDataResidency?: OpenAIDataResidency }> {
    const residency = credentialSource === "workspace"
      ? await this.deps.credentials.getOpenAIResidency(workspaceId)
      : this.deps.defaults.openAIPlatformResidency?.residency;
    // Omitted at the default (global) residency too, agreeing with providerConfig's own
    // present-only-when-it-matters convention for this field.
    if (!residency || residency === "global") {
      return {};
    }
    return { openAIDataResidency: residency, baseUrl: OPENAI_RESIDENCY_HOSTS[residency] };
  }
}
