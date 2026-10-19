import { callOpenAIResidencyProbeEmbeddings } from "../shared/infra/llm/openAIResidencyProbeClient.js";
import { resolveLlmConfig } from "../shared/infra/llm/providerConfig.js";
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
 * 401, 403, or 404: the key, project, or model is definitively wrong for this residency.
 * Reads only the HTTP status, never message text — the OpenAI error shapes observed for a
 * rejected key differ in `code` (`"incorrect_hostname"` for chat, `null` for embeddings) but
 * agree on status.
 */
const isDefinitiveRejection = (error: unknown): boolean =>
  isOpenAIApiErrorShape(error) && (error.status === 401 || error.status === 403 || error.status === 404);

export class OpenAIRegionalEndpointRejectedError extends Error {
  constructor(residency: RegionalResidency, embeddingModel: string) {
    super(
      `OPENAI_DATA_RESIDENCY=${residency} is configured, but the platform OPENAI_API_KEY was rejected ` +
        `by OpenAI's ${residency} regional embeddings endpoint for model "${embeddingModel}". The key ` +
        "must come from an OpenAI project created with that region — an existing (Global) project's " +
        "key cannot be switched to a regional endpoint after the fact.",
    );
    this.name = "OpenAIRegionalEndpointRejectedError";
  }
}

interface OpenAIResidencyStartupCheckDependencies {
  logger: Pick<AppLogger, "info" | "warn">;
  /**
   * Defaults to a one-token embeddings call through the pinned client factory
   * (`createOpenAIClient`), so the probe always reaches the same host a real embedding call
   * would. Tests inject this instead of touching the network.
   */
  callEmbeddings?: (input: { apiKey: string; residency: RegionalResidency; model: string }) => Promise<unknown>;
}

const defaultCallEmbeddings: Required<OpenAIResidencyStartupCheckDependencies>["callEmbeddings"] =
  callOpenAIResidencyProbeEmbeddings;

/**
 * One embeddings call against the platform key's resolved regional endpoint, made once at
 * startup before a runtime becomes ready. `global` residency and a deployment with no platform
 * OpenAI key both skip the call outright — there is no regional endpoint to validate, and
 * logging a "skipped" line for the overwhelmingly common default case would just be noise.
 *
 * A definitive rejection (401/403/404: wrong key, wrong project, or a model this region doesn't
 * serve) throws `OpenAIRegionalEndpointRejectedError`, so a misconfigured deploy never ships
 * silently degraded embeddings; the caller lets this abort startup, and Cloud Run keeps serving
 * the previous revision. A transient failure (network error, timeout, 429, 5xx — anything that
 * isn't a definitive rejection) only warns and returns normally, so an OpenAI outage never
 * blocks an otherwise-good deploy.
 */
export const runOpenAIResidencyStartupCheck = async (
  env: Env,
  deps: OpenAIResidencyStartupCheckDependencies,
): Promise<OpenAIResidencyProbeOutcome> => {
  const config = resolveLlmConfig(env);
  const platform = config.openAIPlatformResidency;
  if (!platform || platform.residency === "global") {
    return "skipped";
  }
  const residency = platform.residency;
  const apiKey = config.providerApiKeys?.openai;
  if (!apiKey) {
    return "skipped";
  }
  const embeddingModel = config.embeddingProviderConfigs.find((entry) => entry.provider === "openai")?.model
    ?? config.embeddings.model;
  const callEmbeddings = deps.callEmbeddings ?? defaultCallEmbeddings;

  try {
    await callEmbeddings({ apiKey, residency, model: embeddingModel });
  } catch (error) {
    if (isDefinitiveRejection(error)) {
      throw new OpenAIRegionalEndpointRejectedError(residency, embeddingModel);
    }
    // Content-free: a region code and the outcome only, never the key or a response body.
    deps.logger.warn({ openai: residency, probe: "transient_failure" }, "Resolved provider residency");
    return "transient_failure";
  }

  deps.logger.info({ openai: residency, probe: "ok" }, "Resolved provider residency");
  return "ok";
};
