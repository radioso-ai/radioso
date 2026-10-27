import {
  callOpenAIResidencyProbeChatCompletion,
  callOpenAIResidencyProbeEmbeddings,
  callOpenAIResidencyProbeResponses,
} from "../shared/infra/llm/openAIResidencyProbeClient.js";
import { platformOpenAIModelCalls, resolveLlmConfig } from "../shared/infra/llm/providerConfig.js";
import {
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

/**
 * The OpenAI/Azure API surface a capability's own call shape uses. Chat and rewrite both run
 * through `chat.completions`; native-openai rerank runs through `responses` instead (see
 * `OpenAISemanticRerankGateway`/`providerRegistry.createRerankGateway`) — a different request and
 * error shape, so it is probed separately even when it shares a model string with chat.
 */
type ProbeSurface = "embeddings" | "chat_completion" | "responses";

const PROBE_SURFACE_BY_CAPABILITY: Record<LlmCapabilityName, ProbeSurface> = {
  embeddings: "embeddings",
  chat: "chat_completion",
  rewrite: "chat_completion",
  rerank: "responses",
};

interface ResidencyProbeTarget {
  model: string;
  capabilities: LlmCapabilityName[];
  surface: ProbeSurface;
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
  /** Defaults to a minimal `responses.create`, matching how native-openai rerank actually calls it. */
  callResponses?: (input: { apiKey: string; endpoint: PlatformOpenAIEndpoint; model: string }) => Promise<unknown>;
}

const defaultCallEmbeddings: Required<OpenAIResidencyStartupCheckDependencies>["callEmbeddings"] =
  callOpenAIResidencyProbeEmbeddings;
const defaultCallChatCompletion: Required<OpenAIResidencyStartupCheckDependencies>["callChatCompletion"] =
  callOpenAIResidencyProbeChatCompletion;
const defaultCallResponses: Required<OpenAIResidencyStartupCheckDependencies>["callResponses"] =
  callOpenAIResidencyProbeResponses;

/**
 * Every distinct (API surface, model) pair this deployment's platform OpenAI key is configured
 * to call, taken from `platformOpenAIModelCalls` — the same list the Azure endpoint's
 * `deployments` is derived from, so every model the platform claims to serve is one this probe
 * verified. A model configured for both chat and rewrite (the common case) is probed once on the
 * shared `chat_completion` surface, naming both capabilities if it is ever rejected; rerank never
 * dedupes with them even on the same model, since it calls a different surface (`responses`).
 */
const resolveProbeTargets = (config: ResolvedLlmConfig): ResidencyProbeTarget[] => {
  const targetsBySurfaceAndModel = new Map<string, ResidencyProbeTarget>();

  for (const { capability, model } of platformOpenAIModelCalls(config)) {
    const surface = PROBE_SURFACE_BY_CAPABILITY[capability];
    const key = `${surface}:${model}`;
    const existing = targetsBySurfaceAndModel.get(key);
    if (existing) {
      existing.capabilities.push(capability);
      continue;
    }
    targetsBySurfaceAndModel.set(key, { model, capabilities: [capability], surface });
  }

  return [...targetsBySurfaceAndModel.values()];
};

const buildRejectionError = (platform: PlatformOpenAIEndpoint, target: ResidencyProbeTarget): Error =>
  platform.kind === "azure"
    ? new AzureOpenAIDeploymentRejectedError(platform.baseUrl, target.model, target.capabilities)
    : new OpenAIRegionalEndpointRejectedError(platform.residency as RegionalResidency, target.model, target.capabilities);

const callProbeTarget = (
  target: ResidencyProbeTarget,
  deps: { callEmbeddings: typeof defaultCallEmbeddings; callChatCompletion: typeof defaultCallChatCompletion; callResponses: typeof defaultCallResponses },
  apiKey: string,
  endpoint: PlatformOpenAIEndpoint,
): Promise<unknown> => {
  switch (target.surface) {
    case "embeddings":
      return deps.callEmbeddings({ apiKey, endpoint, model: target.model });
    case "chat_completion":
      return deps.callChatCompletion({ apiKey, endpoint, model: target.model });
    case "responses":
      return deps.callResponses({ apiKey, endpoint, model: target.model });
  }
};

/**
 * One call per distinct (API surface, model) this deployment's platform OpenAI key is configured
 * to call, made in parallel once at startup before a runtime becomes ready. Skips outright at the
 * default (global, no Azure) platform endpoint, or with no platform OpenAI key — there is nothing
 * but OpenAI's own default host to validate, and logging a "skipped" line for the overwhelmingly
 * common default case would just be noise.
 *
 * A definitive rejection (401/403/404: wrong key, wrong project/region, or on Azure a missing
 * deployment) throws, so a misconfigured deploy never ships silently degraded chat, rewrite,
 * rerank, or embeddings; the caller lets this abort startup, and Cloud Run keeps serving the
 * previous revision. A transient failure (network error, timeout, 429, 5xx — anything that isn't
 * a definitive rejection) only warns and returns normally, so an OpenAI/Azure outage never blocks
 * an otherwise-good deploy. The probe clients themselves use a short timeout and no SDK-level
 * retries (see `openAIResidencyProbeClient.ts`), so a slow or 5xx-ing endpoint reaches the
 * transient-warning path quickly instead of holding up startup.
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
  const callDeps = {
    callEmbeddings: deps.callEmbeddings ?? defaultCallEmbeddings,
    callChatCompletion: deps.callChatCompletion ?? defaultCallChatCompletion,
    callResponses: deps.callResponses ?? defaultCallResponses,
  };

  const outcomes = await Promise.allSettled(
    targets.map((target) => callProbeTarget(target, callDeps, apiKey, platform)),
  );

  let sawTransientFailure = false;
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = outcomes[index];
    if (outcome.status === "fulfilled") {
      continue;
    }
    if (isDefinitiveRejection(outcome.reason)) {
      throw buildRejectionError(platform, targets[index]);
    }
    sawTransientFailure = true;
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
