import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import OpenAI from "openai";

import {
  MODEL_CALL_PRESSURE_LOG_EVENT,
  ModelCallGovernor,
  runAsyncIterableWithModelCallGovernance,
  runInDeferrableModelCallLane,
  runWithModelCallGovernance,
  turnCallAdmissionLimits,
  type ModelCallGovernanceScope,
} from "../../src/shared/infra/llm/modelCallGovernance.js";
import { ModelCallShedError } from "../../src/shared/infra/llm/modelCallAdmission.js";
import { ModelInferencePipelineService } from "../../src/shared/infra/llm/modelInferencePipeline.js";
import type {
  TextGenerationClient,
  TextGenerationRequest,
  TextGenerationResult,
  TextGenerationStreamResult,
} from "../../src/shared/infra/llm/providerTypes.js";

const usageContext = { workspaceId: "w1", surface: "assistant", operation: "answer", attemptKey: "k" };

const rateLimited = (headers: Record<string, string> = {}, body: Record<string, unknown> = {}) =>
  new OpenAI.RateLimitError(429, body, "rate limited", new Headers(headers));

const unavailable = () => new OpenAI.InternalServerError(503, {}, "unavailable", new Headers());

/** A provider client that plays back one outcome per call: a text, or an error to throw. */
const scriptedClient = (outcomes: Array<string | Error>): TextGenerationClient & {
  requests: TextGenerationRequest[];
} => {
  const requests: TextGenerationRequest[] = [];
  return {
    requests,
    metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
    async complete(request): Promise<TextGenerationResult> {
      requests.push(request);
      const outcome = outcomes.shift();
      if (outcome instanceof Error) throw outcome;
      return { text: outcome ?? "" };
    },
    stream(request): TextGenerationStreamResult {
      requests.push(request);
      const outcome = outcomes.shift();
      return {
        textStream: (async function* () {
          if (outcome instanceof Error) throw outcome;
          for (const chunk of (outcome ?? "").split(" ")) yield chunk;
        })(),
        usage: Promise.resolve({ inputTokens: 1, outputTokens: 1, quality: "actual" as const }),
      };
    },
  };
};

/** A stream that yields its first chunk and then fails. */
const failingMidStreamClient = (): TextGenerationClient & { calls: () => number } => {
  let calls = 0;
  return {
    calls: () => calls,
    metadata: { capability: "chat", provider: "openai", model: "gpt-test" },
    complete: vi.fn(),
    stream(): TextGenerationStreamResult {
      calls += 1;
      return {
        textStream: (async function* () {
          yield "partial";
          throw unavailable();
        })(),
        usage: Promise.resolve(undefined),
      };
    },
  };
};

const governor = (overrides: Partial<ConstructorParameters<typeof ModelCallGovernor>[0]> = {}) => {
  const metrics = { incrementCounter: vi.fn(), setGauge: vi.fn(), observeHistogram: vi.fn() };
  const logger = { warn: vi.fn() };
  const instance = new ModelCallGovernor({
    limits: { maxConcurrentTurnCalls: 2, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 },
    retryPolicy: { maxAttempts: 2, baseDelayMs: 500, maxDelayMs: 2_000 },
    metrics,
    logger,
    random: () => 0,
    ...overrides,
  });
  return { instance, metrics, logger };
};

const turnScope = (instance: ModelCallGovernor, abandoned?: AbortSignal): ModelCallGovernanceScope =>
  ({ governor: instance, lane: "turn", ...(abandoned ? { abandoned } : {}) });

const drain = async (stream: AsyncIterable<string>): Promise<string[]> => {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe("model call governance on the inference pipeline", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("leaves a call outside any turn exactly as it was: one attempt, the SDK's own retries", async () => {
    const client = scriptedClient([rateLimited()]);
    const pipeline = new ModelInferencePipelineService(client);

    await expect(pipeline.complete({ prompt: "p", operation: usageContext })).rejects.toBeInstanceOf(OpenAI.RateLimitError);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]).not.toHaveProperty("maxProviderRetries");
  });

  it("retries a turn call once after the provider's Retry-After, with the SDK's own retries off", async () => {
    const { instance } = governor();
    const client = scriptedClient([rateLimited({ "retry-after": "1" }), "answer"]);
    const pipeline = new ModelInferencePipelineService(client);

    const result = runWithModelCallGovernance(turnScope(instance), () =>
      pipeline.complete({ prompt: "p", operation: usageContext }));
    await vi.advanceTimersByTimeAsync(999);
    expect(client.requests).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);

    await expect(result).resolves.toMatchObject({ text: "answer" });
    expect(client.requests.map((request) => request.maxProviderRetries)).toEqual([0, 0]);
  });

  it("fails a turn call at once when the provider asks for a longer wait than the cap", async () => {
    const { instance } = governor();
    const client = scriptedClient([rateLimited({ "retry-after": "30" }), "never"]);
    const pipeline = new ModelInferencePipelineService(client);

    await expect(runWithModelCallGovernance(turnScope(instance), () =>
      pipeline.complete({ prompt: "p", operation: usageContext }))).rejects.toBeInstanceOf(OpenAI.RateLimitError);
    expect(client.requests).toHaveLength(1);
  });

  it("never makes more than the policy's attempts, however long the provider keeps failing", async () => {
    const { instance } = governor();
    const client = scriptedClient([unavailable(), unavailable(), unavailable()]);
    const pipeline = new ModelInferencePipelineService(client);

    const result = runWithModelCallGovernance(turnScope(instance), () =>
      pipeline.complete({ prompt: "p", operation: usageContext }));
    const settled = expect(result).rejects.toBeInstanceOf(OpenAI.InternalServerError);
    await vi.advanceTimersByTimeAsync(2_000);
    await settled;
    expect(client.requests).toHaveLength(2);
  });

  it("logs and counts provider pushback with bounded fields only, never the prompt", async () => {
    const { instance, metrics, logger } = governor();
    const client = scriptedClient([rateLimited({}, { code: "insufficient_quota" })]);
    const pipeline = new ModelInferencePipelineService(client);

    await expect(runWithModelCallGovernance(turnScope(instance), () =>
      pipeline.complete({ prompt: "a visitor's private question", operation: usageContext }))).rejects.toThrow();

    expect(logger.warn).toHaveBeenCalledWith(
      {
        event: MODEL_CALL_PRESSURE_LOG_EVENT,
        signal: "provider_quota_exhausted",
        lane: "turn",
        provider: "openai",
        providerStatus: 429,
        providerCode: "insufficient_quota",
        retried: false,
      },
      expect.any(String),
    );
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("private question");
    expect(metrics.incrementCounter).toHaveBeenCalledWith("llm_provider_pressure_total", expect.objectContaining({
      labels: { lane: "turn", provider: "openai", kind: "quota_exhausted", retried: "false" },
    }));
  });

  it("counts a best-effort call's pushback by its lane but writes no pressure line: only a call a turn waits on is an alert", async () => {
    const { instance, metrics, logger } = governor();
    const pipeline = new ModelInferencePipelineService(scriptedClient([rateLimited({ "retry-after": "30" })]));

    await expect(runWithModelCallGovernance(turnScope(instance), () =>
      runInDeferrableModelCallLane(() => pipeline.complete({ prompt: "p", operation: usageContext }))))
      .rejects.toBeInstanceOf(OpenAI.RateLimitError);

    expect(metrics.incrementCounter).toHaveBeenCalledWith("llm_provider_pressure_total", expect.objectContaining({
      labels: { lane: "deferrable", provider: "openai", kind: "rate_limited", retried: "false" },
    }));
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("sheds a turn call over the instance cap with a typed busy failure, without calling the provider", async () => {
    const { instance, metrics, logger } = governor({
      limits: { maxConcurrentTurnCalls: 1, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 },
    });
    const held = await instance.admission.acquire({ lane: "turn" });
    const client = scriptedClient(["second"]);
    const blocked = new ModelInferencePipelineService(client);

    const result = runWithModelCallGovernance(turnScope(instance), () =>
      blocked.complete({ prompt: "p", operation: usageContext }));
    const settled = expect(result).rejects.toBeInstanceOf(ModelCallShedError);
    await vi.advanceTimersByTimeAsync(1_000);
    await settled;

    expect(client.requests).toHaveLength(0);
    expect(metrics.incrementCounter).toHaveBeenCalledWith("llm_calls_shed_total", expect.objectContaining({
      labels: { lane: "turn", reason: "queue_timeout" },
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      { event: MODEL_CALL_PRESSURE_LOG_EVENT, signal: "capacity_shed", lane: "turn", reason: "queue_timeout" },
      expect.any(String),
    );
    held();
  });

  it("records no usage for a shed call: it never reached the provider", async () => {
    const { instance } = governor({
      limits: { maxConcurrentTurnCalls: 1, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 },
    });
    const held = await instance.admission.acquire({ lane: "turn" });
    const recorder = { recordModelCall: vi.fn(async () => {}), recordEmbedding: vi.fn(async () => {}) };
    const pipeline = new ModelInferencePipelineService(scriptedClient(["never"]), recorder);
    const clientGone = new AbortController();
    clientGone.abort();
    const scope = turnScope(instance, clientGone.signal);

    await expect(runWithModelCallGovernance(scope, () => pipeline.complete({ prompt: "p", operation: usageContext })))
      .rejects.toBeInstanceOf(ModelCallShedError);
    await expect(drain(runAsyncIterableWithModelCallGovernance(scope, () =>
      pipeline.stream({ prompt: "p", operation: usageContext }).textStream))).rejects.toBeInstanceOf(ModelCallShedError);

    expect(recorder.recordModelCall).not.toHaveBeenCalled();
    held();
  });

  it("runs deferrable work on its own budget: a full deferrable lane sheds it while the turn's call proceeds", async () => {
    const { instance, logger } = governor();
    await instance.admission.acquire({ lane: "deferrable" });
    const client = scriptedClient(["turn answer"]);
    const deferredClient = scriptedClient(["shadow verdict"]);
    const pipeline = new ModelInferencePipelineService(client);
    const deferred = new ModelInferencePipelineService(deferredClient);

    await runWithModelCallGovernance(turnScope(instance), async () => {
      await expect(runInDeferrableModelCallLane(() => deferred.complete({ prompt: "p", operation: usageContext })))
        .rejects.toMatchObject({ lane: "deferrable", reason: "lane_full" });
      await expect(pipeline.complete({ prompt: "p", operation: usageContext })).resolves.toMatchObject({ text: "turn answer" });
    });
    expect(deferredClient.requests).toHaveLength(0);
    // Deferrable shedding is designed behaviour under load: counted, not logged.
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("stops starting model calls for an abandoned turn once the lane is full, and still runs them while there is room", async () => {
    const { instance } = governor({
      limits: { maxConcurrentTurnCalls: 1, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 },
    });
    const clientGone = new AbortController();
    clientGone.abort();
    const client = scriptedClient(["with room", "never"]);
    const pipeline = new ModelInferencePipelineService(client);
    const scope = turnScope(instance, clientGone.signal);

    await expect(runWithModelCallGovernance(scope, () => pipeline.complete({ prompt: "p", operation: usageContext })))
      .resolves.toMatchObject({ text: "with room" });

    const held = await instance.admission.acquire({ lane: "turn" });
    await expect(runWithModelCallGovernance(scope, () => pipeline.complete({ prompt: "p", operation: usageContext })))
      .rejects.toMatchObject({ reason: "abandoned" });
    expect(client.requests).toHaveLength(1);
    held();
  });

  it("retries a stream that fails before its first chunk and holds the permit until the stream ends", async () => {
    const { instance, metrics } = governor();
    const client = scriptedClient([unavailable(), "streamed answer"]);
    const pipeline = new ModelInferencePipelineService(client);

    const chunks = drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () =>
      pipeline.stream({ prompt: "p", operation: usageContext }).textStream));
    await vi.advanceTimersByTimeAsync(500);

    await expect(chunks).resolves.toEqual(["streamed", "answer"]);
    expect(client.requests.map((request) => request.maxProviderRetries)).toEqual([0, 0]);
    const inFlight = metrics.setGauge.mock.calls
      .filter(([name]) => name === "llm_calls_in_flight")
      .map(([, options]) => options.value);
    expect(inFlight).toEqual([1, 0]);
  });

  it("never retries a stream that already sent text", async () => {
    const { instance } = governor();
    const client = failingMidStreamClient();
    const pipeline = new ModelInferencePipelineService(client);

    await expect(drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () =>
      pipeline.stream({ prompt: "p", operation: usageContext }).textStream)))
      .rejects.toBeInstanceOf(OpenAI.InternalServerError);
    expect(client.calls()).toBe(1);
  });

  describe("a slot is held for the provider call, not for usage accounting", () => {
    const oneSlot = { maxConcurrentTurnCalls: 1, maxConcurrentDeferrableCalls: 1, maxQueueWaitMs: 1_000 };
    /** A usage recorder whose database write never returns. */
    const stalledRecorder = () => ({
      recordModelCall: vi.fn(() => new Promise<void>(() => {})),
      recordEmbedding: vi.fn(async () => {}),
    });
    const lastInFlight = (metrics: ReturnType<typeof governor>["metrics"]) =>
      metrics.setGauge.mock.calls
        .filter(([name]) => name === "llm_calls_in_flight")
        .map(([, options]) => options.value)
        .at(-1);

    it("gives a completed call's slot back while its usage is still being recorded", async () => {
      const { instance, metrics } = governor({ limits: oneSlot });
      const recorder = stalledRecorder();
      const pipeline = new ModelInferencePipelineService(scriptedClient(["answer"]), recorder);

      void runWithModelCallGovernance(turnScope(instance), () => pipeline.complete({ prompt: "p", operation: usageContext }));
      await vi.advanceTimersByTimeAsync(10);

      expect(recorder.recordModelCall).toHaveBeenCalledTimes(1);
      expect(lastInFlight(metrics)).toBe(0);
    });

    it("gives a failed call's slot back while its usage is still being recorded", async () => {
      const { instance, metrics } = governor({ limits: oneSlot });
      const recorder = stalledRecorder();
      const pipeline = new ModelInferencePipelineService(scriptedClient([new OpenAI.BadRequestError(400, {}, "bad", new Headers())]), recorder);

      void runWithModelCallGovernance(turnScope(instance), () => pipeline.complete({ prompt: "p", operation: usageContext }))
        .catch(() => {});
      await vi.advanceTimersByTimeAsync(10);

      expect(recorder.recordModelCall).toHaveBeenCalledTimes(1);
      expect(lastInFlight(metrics)).toBe(0);
    });

    it("gives a fully read stream's slot back while its usage is still being recorded", async () => {
      const { instance, metrics } = governor({ limits: oneSlot });
      const recorder = stalledRecorder();
      const pipeline = new ModelInferencePipelineService(scriptedClient(["one two"]), recorder);

      void drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () =>
        pipeline.stream({ prompt: "p", operation: usageContext }).textStream));
      await vi.advanceTimersByTimeAsync(10);

      expect(recorder.recordModelCall).toHaveBeenCalledTimes(1);
      expect(lastInFlight(metrics)).toBe(0);
    });

    it("gives a failed stream's slot back while its usage is still being recorded", async () => {
      const { instance, metrics } = governor({ limits: oneSlot });
      const recorder = stalledRecorder();
      const pipeline = new ModelInferencePipelineService(failingMidStreamClient(), recorder);

      void drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () =>
        pipeline.stream({ prompt: "p", operation: usageContext }).textStream)).catch(() => {});
      await vi.advanceTimersByTimeAsync(10);

      expect(recorder.recordModelCall).toHaveBeenCalledTimes(1);
      expect(lastInFlight(metrics)).toBe(0);
    });
  });

  it("never fails a fully read stream because its usage promise rejected", async () => {
    const { instance } = governor();
    const client = scriptedClient(["one two"]);
    const brokenUsage = Promise.reject(new Error("usage unavailable"));
    brokenUsage.catch(() => {});
    const pipeline = new ModelInferencePipelineService({
      ...client,
      stream: (request) => ({ ...client.stream(request), usage: brokenUsage }),
    });

    const result = runWithModelCallGovernance(turnScope(instance), () => pipeline.stream({ prompt: "p", operation: usageContext }));
    const chunks = await drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () => result.textStream));

    expect(chunks).toEqual(["one", "two"]);
    await expect(result.usage).resolves.toBeUndefined();
  });

  it("resolves the stream's usage from the attempt that answered", async () => {
    const { instance } = governor();
    const client = scriptedClient(["one two"]);
    const pipeline = new ModelInferencePipelineService(client);

    const result = runWithModelCallGovernance(turnScope(instance), () => pipeline.stream({ prompt: "p", operation: usageContext }));
    await drain(runAsyncIterableWithModelCallGovernance(turnScope(instance), () => result.textStream));

    await expect(result.usage).resolves.toMatchObject({ inputTokens: 1, outputTokens: 1 });
  });
});

describe("turnCallAdmissionLimits", () => {
  it("sizes the deferrable lane as an eighth of the turn lane, at least one, with the short queue wait", () => {
    expect(turnCallAdmissionLimits(64)).toEqual({ maxConcurrentTurnCalls: 64, maxConcurrentDeferrableCalls: 8, maxQueueWaitMs: 2_000 });
    expect(turnCallAdmissionLimits(4)).toMatchObject({ maxConcurrentDeferrableCalls: 1 });
  });
});
