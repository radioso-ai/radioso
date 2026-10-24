import {
  callOpenAIResidencyProbeChatCompletion,
  callOpenAIResidencyProbeEmbeddings,
} from "../shared/infra/llm/openAIResidencyProbeClient.js";
import { resolveLlmConfig } from "../shared/infra/llm/providerConfig.js";
import {
  type LlmCapabilityDefault,
  type LlmCapabilityName,
  platformOpenAIEndpointLogFields,
  type PlatformOpenAIEndpoint,
  type ResolvedLlmConfig,
} from "../shared/infra/llm/providerTypes.js";
import type { Env } from "../app/config/env.js";
import type { AppLogger } from "../shared/observability/logger.js";

type OpenAIResidencyProbeOutcome = "ok" | "skipped" | "transient_failure";

type RegionalResidency = "us" | "eu";

interface OpenAIApiErrorShape {
  status?: unknown;
}

const isOpenAIApiErrorShape = (error: unknown): error is OpenAIApiErrorShape =>
  typeof error === "object" && error !== null && "status" in error;

/**
 * 401, 403, or 404: the key, project, or model (on Azure: the deployment) is definitively wrong
 * for this endpoint. Reads only the HTTP status, never message text — the OpenAI and Azure OpenAI
 * error shapes observed for a rejected key or a missing deployment differ in `code`
 * (`"incorrect_hostname"` for chat, `null` for embeddings, `"DeploymentNotFound"` on Azure) but
 * agree on status.
 */
const isDefinitiveRejection = (error: unknown): boolean =>
  isOpenAIApiErrorShape(error) && (error.status === 401 || error.status === 403 || error.status === 404);

const describeTargetCapabilities = (capabilities: readonly LlmCapabilityName[]): string => capabilities.join(", ");

export class OpenAIRegionalEndpointRejectedError extends Error {
  constructor(residency: RegionalResidency, model: string, capabilities: readonly LlmCapabilityName[]) {
    super(
      `OPENAI_DATA_RESIDENCY=${residency} is configured, but the platform OPENAI_API_KEY was rejected ` +
        `by OpenAI's ${residency} regional endpoint for model "${model}" (${describeTargetCapabilities(capabilities)}). ` +
        "The key must come from an OpenAI project created with that region — an existing (Global) " +
        "project's key cannot be switched to a regional endpoint after the fact.",
    );
    this.name = "OpenAIRegionalEndpointRejectedError";
  }
}

/**
 * On Azure OpenAI, a missing deployment reports 404 the same way a rejected key does, so this
 * error always names both possibilities: deploy the model, or verify the key. Azure's own request
 * `model` field is the deployment name, not the underlying model id — so the remediation calls
 * that out explicitly rather than assuming the operator already knows the convention.
 */
export class AzureOpenAIDeploymentRejectedError extends Error {
  constructor(azureBaseUrl: string, model: string, capabilities: readonly LlmCapabilityName[]) {
    super(
      `AZURE_OPENAI_ENDPOINT=${azureBaseUrl} is configured, but Azure rejected the platform OPENAI_API_KEY ` +
        `(now an Azure key) for model "${model}" (${describeTargetCapabilities(capabilities)}). Deploy "${model}" ` +
        'as a Data Zone Standard deployment on this resource with the deployment name equal to the model name, ' +
        "or verify the key.",
    );
    this.name = "AzureOpenAIDeploymentRejectedError";
  }
}

interface ResidencyProbeTarget {
  model: string;
  capabilities: LlmCapabilityName[];
  kind: "embeddings" | "chat_completion";
}

interface OpenAIResidencyStartupCheckDependencies {
  logger: Pick<AppLogger, "info" | "warn">;
  /**
   * Defaults to a one-token embeddings call through the pinned client factory
   * (`createOpenAIClient`), so the probe always reaches the same host a real embedding call
   * would. Tests inject this instead of touching the network.
   */
  callEmbeddings?: (input: { apiKey: string; endpoint: PlatformOpenAIEndpoint; model: string }) => Promise<unknown>;
  /** Defaults to a minimal chat completion through the same pinned client factory. */
  callChatCompletion?: (input: { apiKey: string; endpoint: PlatformOpenAIEndpoint; model: string }) => Promise<unknown>;
}

const defaultCallEmbeddings: Required<OpenAIResidencyStartupCheckDependencies>["callEmbeddings"] =
  callOpenAIResidencyProbeEmbeddings;
const defaultCallChatCompletion: Required<OpenAIResidencyStartupCheckDependencies>["callChatCompletion"] =
  callOpenAIResidencyProbeChatCompletion;

/**
 * Every distinct platform-OpenAI model this deployment is configured to call, grouped by probe
 * shape. Embeddings is checked unconditionally whenever a platform OpenAI key exists — the owner
 * requirement embeddings must never fail — because `resolveLlmConfig` always makes an
 * openai-embeddings capability latently available alongside the key, even when a workspace's own
 * preference or a different env default routes active embedding traffic elsewhere. Chat and
 * rerank are checked only when each one's own env default actually resolved to provider
 * `"openai"`; unlike embeddings there is no always-latent openai chat/rerank capability, so
 * probing a model nothing calls would just be noise. A model configured for both chat and rerank
 * (common on Azure, where there is no EU Data Zone quota for a nano-sized rerank model) is probed
 * once, naming both capabilities if it is ever rejected.
 */
const resolveProbeTargets = (config: ResolvedLlmConfig): ResidencyProbeTarget[] => {
  const targets: ResidencyProbeTarget[] = [];

  const embeddingModel = config.embeddingProviderConfigs.find((entry) => entry.provider === "openai")?.model
    ?? config.embeddings.model;
  targets.push({ model: embeddingModel, capabilities: ["embeddings"], kind: "embeddings" });

  const chatLikeCapabilities: ReadonlyArray<[LlmCapabilityName, LlmCapabilityDefault]> = [
    ["chat", config.chat],
    ["rerank", config.rerank],
  ];
  const chatLikeModels = new Map<string, LlmCapabilityName[]>();
  for (const [capability, capabilityConfig] of chatLikeCapabilities) {
    if (capabilityConfig.provider !== "openai") {
      continue;
    }
    chatLikeModels.set(capabilityConfig.model, [...(chatLikeModels.get(capabilityConfig.model) ?? []), capability]);
  }
  for (const [model, capabilities] of chatLikeModels) {
    targets.push({ model, capabilities, kind: "chat_completion" });
  }

  return targets;
};

const buildRejectionError = (platform: PlatformOpenAIEndpoint, target: ResidencyProbeTarget): Error =>
  platform.kind === "azure"
    ? new AzureOpenAIDeploymentRejectedError(platform.baseUrl, target.model, target.capabilities)
    : new OpenAIRegionalEndpointRejectedError(platform.residency as RegionalResidency, target.model, target.capabilities);

/**
 * One call per distinct configured platform-OpenAI model, made once at startup before a runtime
 * becomes ready. Skips outright at the default (global, no Azure) platform endpoint, or with no
 * platform OpenAI key — there is nothing but OpenAI's own default host to validate, and logging a
 * "skipped" line for the overwhelmingly common default case would just be noise.
 *
 * A definitive rejection (401/403/404: wrong key, wrong project/region, or on Azure a missing
 * deployment) throws, so a misconfigured deploy never ships silently degraded chat, rerank, or
 * embeddings; the caller lets this abort startup, and Cloud Run keeps serving the previous
 * revision. A transient failure (network error, timeout, 429, 5xx — anything that isn't a
 * definitive rejection) only warns and returns normally, so an OpenAI/Azure outage never blocks an
 * otherwise-good deploy.
 */
export const runOpenAIResidencyStartupCheck = async (
  env: Env,
  deps: OpenAIResidencyStartupCheckDependencies,
): Promise<OpenAIResidencyProbeOutcome> => {
  const config = resolveLlmConfig(env);
  const platform = config.openAIPlatformEndpoint;
  if (!platform || (platform.kind === "openai" && platform.residency === "global")) {
    return "skipped";
  }
  const apiKey = config.providerApiKeys?.openai;
  if (!apiKey) {
    return "skipped";
  }

  const targets = resolveProbeTargets(config);
  const callEmbeddings = deps.callEmbeddings ?? defaultCallEmbeddings;
  const callChatCompletion = deps.callChatCompletion ?? defaultCallChatCompletion;

  let sawTransientFailure = false;
  for (const target of targets) {
    try {
      if (target.kind === "embeddings") {
        await callEmbeddings({ apiKey, endpoint: platform, model: target.model });
      } else {
        await callChatCompletion({ apiKey, endpoint: platform, model: target.model });
      }
    } catch (error) {
      if (isDefinitiveRejection(error)) {
        throw buildRejectionError(platform, target);
      }
      sawTransientFailure = true;
    }
  }

  // Content-free: a region code (or "azure" plus the Azure resource host) and the outcome only,
  // never a key, a model name, or a response body.
  const logFields = platformOpenAIEndpointLogFields(platform);
  if (sawTransientFailure) {
    deps.logger.warn({ ...logFields, probe: "transient_failure" }, "Resolved provider residency");
    return "transient_failure";
  }

  deps.logger.info({ ...logFields, probe: "ok" }, "Resolved provider residency");
  return "ok";
};
