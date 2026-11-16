import { AsyncLocalStorage } from "node:async_hooks";

import { LLM_DEFAULTS } from "../../domain/behaviorConfig.js";
import type { AppLogger } from "../../observability/logger.js";
import type { MetricsRegistry } from "../../observability/metrics/metricsRegistry.js";
import { runAsyncIterableWithin } from "../asyncContextIterable.js";
import { classifyLlmProviderFailure, type LlmProviderFailureKind } from "./llmProviderFailureClassification.js";
import {
  ModelCallAdmission,
  type ModelCallAdmissionLimits,
  type ModelCallAdmissionObserver,
  type ModelCallLane,
  type ReleaseModelCallPermit,
} from "./modelCallAdmission.js";
import { providerRetryDelayMs, sleepUnlessAborted, type ProviderRetryPolicy } from "./providerCallRetry.js";
import type { ProviderUsage, TextGenerationStreamResult } from "./providerTypes.js";

/**
 * The `event` of the one log line written when the provider pushes back on a conversation
 * turn's model call or this instance sheds one. infra/terraform/monitoring.tf counts it.
 */
export const MODEL_CALL_PRESSURE_LOG_EVENT = "llm.call_pressure";

/** The provider failures that say it is saturated or out of credit, as the log line names them. */
const PRESSURE_SIGNAL_BY_KIND: Partial<Record<LlmProviderFailureKind, string>> = {
  rate_limited: "provider_rate_limited",
  quota_exhausted: "provider_quota_exhausted",
  provider_unavailable: "provider_unavailable",
};

const PROVIDER_LABELS = new Set(["openai", "openai-compatible", "gemini", "claude"]);

type GovernorMetrics = Pick<MetricsRegistry, "incrementCounter" | "setGauge" | "observeHistogram">;

/** The admission limits for a turn lane of `maxConcurrentTurnCalls`, from the composition-owned defaults. */
export const turnCallAdmissionLimits = (maxConcurrentTurnCalls: number): ModelCallAdmissionLimits => ({
  maxConcurrentTurnCalls,
  maxConcurrentDeferrableCalls: Math.max(1, Math.ceil(maxConcurrentTurnCalls / LLM_DEFAULTS.turnCalls.deferrableDivisor)),
  maxQueueWaitMs: LLM_DEFAULTS.turnCalls.maxQueueWaitMs,
});

interface ModelCallGovernorOptions {
  readonly limits: ModelCallAdmissionLimits;
  readonly retryPolicy: ProviderRetryPolicy;
  readonly metrics?: GovernorMetrics | null;
  readonly logger?: Pick<AppLogger, "warn"> | null;
  /** Jitter source; tests pin it. */
  readonly random?: () => number;
}

/**
 * Per-instance governance for the model calls conversation turns make: how many may be in
 * flight (admission), how a call retries a provider that pushed back, and the telemetry for
 * both. One instance per process, built by composition and handed to the turn host, which
 * opens a {@link ModelCallGovernanceScope} around each turn.
 */
export class ModelCallGovernor {
  readonly admission: ModelCallAdmission;
  readonly retryPolicy: ProviderRetryPolicy;
  readonly random: () => number;

  constructor(private readonly options: ModelCallGovernorOptions) {
    this.admission = new ModelCallAdmission(options.limits, this.admissionObserver());
    this.retryPolicy = options.retryPolicy;
    this.random = options.random ?? Math.random;
  }

  /** Records one failed attempt whose failure says the provider is saturated or out of credit. */
  recordProviderPressure(input: { lane: ModelCallLane; provider: string; error: unknown; retried: boolean }): void {
    const failure = classifyLlmProviderFailure(input.error);
    const signal = failure ? PRESSURE_SIGNAL_BY_KIND[failure.kind] : undefined;
    if (!failure || !signal) {
      return;
    }
    const provider = PROVIDER_LABELS.has(input.provider) ? input.provider : "other";
    this.options.metrics?.incrementCounter("llm_provider_pressure_total", {
      help: "Conversation-turn model call attempts the provider rate-limited, refused for quota, or failed as unavailable.",
      labels: { lane: input.lane, provider, kind: failure.kind, retried: String(input.retried) },
    });
    this.options.logger?.warn(
      {
        event: MODEL_CALL_PRESSURE_LOG_EVENT,
        signal,
        lane: input.lane,
        provider,
        providerStatus: failure.status,
        providerCode: failure.code,
        retried: input.retried,
      },
      "Model provider pushed back on a conversation turn call",
    );
  }

  private admissionObserver(): ModelCallAdmissionObserver {
    const { metrics, logger } = this.options;
    return {
      inFlight: (lane, count) => metrics?.setGauge("llm_calls_in_flight", {
        help: "Conversation-turn model calls in flight on this instance, by lane.",
        labels: { lane },
        value: count,
      }),
      queued: (lane, waitMs) => metrics?.observeHistogram("llm_call_queue_wait_ms", {
        help: "How long a conversation-turn model call waited for a free slot before it started.",
        labels: { lane },
        value: waitMs,
      }),
      shed: (lane, reason) => {
        metrics?.incrementCounter("llm_calls_shed_total", {
          help: "Conversation-turn model calls this instance refused to start because their lane was full.",
          labels: { lane, reason },
        });
        // Shedding deferrable work is the design working; only a shed turn call is pressure.
        if (lane === "turn") {
          logger?.warn(
            { event: MODEL_CALL_PRESSURE_LOG_EVENT, signal: "capacity_shed", lane, reason },
            "Model call shed: this instance is at its concurrent call limit",
          );
        }
      },
    };
  }
}

/** What a conversation turn's model calls run under: the governor, their lane, and whether anyone still waits. */
export interface ModelCallGovernanceScope {
  readonly governor: ModelCallGovernor;
  readonly lane: ModelCallLane;
  /** Fires when nobody is waiting for the turn's answer any more (the client's connection closed). */
  readonly abandoned?: AbortSignal;
}

const governanceStorage = new AsyncLocalStorage<ModelCallGovernanceScope>();

export const runWithModelCallGovernance = <T>(scope: ModelCallGovernanceScope, run: () => T): T =>
  governanceStorage.run(scope, run);

export const runAsyncIterableWithModelCallGovernance = <T>(
  scope: ModelCallGovernanceScope,
  createIterable: () => AsyncIterable<T>,
): AsyncIterable<T> => runAsyncIterableWithin((run) => governanceStorage.run(scope, run), createIterable);

/**
 * Runs work a turn starts but never waits on in the deferrable lane, so it draws on its own
 * budget and is shed first. Outside a turn it runs as it is.
 */
export const runInDeferrableModelCallLane = <T>(run: () => T): T => {
  const scope = governanceStorage.getStore();
  return scope ? governanceStorage.run({ ...scope, lane: "deferrable" }, run) : run();
};

/** The scope the current model call runs under, or `undefined` outside any conversation turn. */
export const currentModelCallGovernance = (): ModelCallGovernanceScope | undefined => governanceStorage.getStore();

const releaseNothing: ReleaseModelCallPermit = () => {};

/**
 * A permit for one model call in the scope's lane; outside any conversation turn (no scope),
 * one that holds nothing. A shed call rejects with `ModelCallShedError` before it reaches the
 * provider, so a caller takes the permit before it starts accounting for the call.
 */
export const acquireModelCallPermit = (
  scope: ModelCallGovernanceScope | undefined,
  signal: AbortSignal | undefined,
): Promise<ReleaseModelCallPermit> =>
  scope
    ? scope.governor.admission.acquire({
        lane: scope.lane,
        ...(signal ? { signal } : {}),
        ...(scope.abandoned ? { abandoned: scope.abandoned } : {}),
      })
    : Promise.resolve(releaseNothing);

/**
 * The wait before retrying the attempt that failed, or `null` to give up — recording the
 * provider's pushback either way. The caller's permit stays held through the wait, so a
 * provider that pushes back also lowers how much this instance sends it.
 */
const retryDelayAfter = (
  scope: ModelCallGovernanceScope,
  provider: string,
  error: unknown,
  attempt: number,
  retryable = true,
): number | null => {
  const delayMs = retryable
    ? providerRetryDelayMs(error, attempt, scope.governor.retryPolicy, scope.governor.random)
    : null;
  scope.governor.recordProviderPressure({ lane: scope.lane, provider, error, retried: delayMs !== null });
  return delayMs;
};

interface GovernedCallInput {
  readonly provider: string;
  readonly signal?: AbortSignal;
}

/** Runs one non-streaming provider call under the scope's bounded retries. */
export const governedCall = async <T>(
  scope: ModelCallGovernanceScope,
  input: GovernedCallInput & { readonly call: () => Promise<T> },
): Promise<T> => {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await input.call();
    } catch (error) {
      const delayMs = retryDelayAfter(scope, input.provider, error, attempt);
      if (delayMs === null) {
        throw error;
      }
      await sleepUnlessAborted(delayMs, input.signal);
    }
  }
};

/**
 * Runs one streaming provider call under the scope's bounded retries. A failure before the
 * first chunk is retried within the policy, one after it is not (the caller already has part
 * of an answer). `usage` resolves from the attempt that answered, or `undefined` when none did.
 */
export const governedStream = (
  scope: ModelCallGovernanceScope,
  input: GovernedCallInput & { readonly open: () => TextGenerationStreamResult },
): TextGenerationStreamResult => {
  let resolveUsage!: (usage: ProviderUsage | undefined) => void;
  const usage = new Promise<ProviderUsage | undefined>((resolve) => {
    resolveUsage = resolve;
  });
  const textStream = (async function* () {
    try {
      for (let attempt = 1; ; attempt += 1) {
        const result = input.open();
        let sentText = false;
        try {
          for await (const chunk of result.textStream) {
            sentText = true;
            yield chunk;
          }
          resolveUsage(await result.usage);
          return;
        } catch (error) {
          const delayMs = retryDelayAfter(scope, input.provider, error, attempt, !sentText);
          if (delayMs === null) {
            throw error;
          }
          await sleepUnlessAborted(delayMs, input.signal);
        }
      }
    } finally {
      resolveUsage(undefined);
    }
  })();
  return { textStream, usage };
};
