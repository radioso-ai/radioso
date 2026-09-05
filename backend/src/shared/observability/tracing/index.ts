import { context, SpanStatusCode, trace, TraceFlags } from "@opentelemetry/api";
import type { Span, SpanOptions, Tracer } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  BatchSpanProcessor,
  ParentBasedSampler,
  SimpleSpanProcessor,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace-base";
import type { Sampler, SpanExporter, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";

import type { AppLogger } from "../logger.js";
import type { RuntimeRole } from "../runtimeRole.js";
import { safeTraceAttributes } from "./attributePolicy.js";
import { type ActiveTraceCorrelation, correlationAttributes } from "./correlation.js";

export { correlationAttributes, safeTraceAttributes };
export type { ActiveTraceCorrelation } from "./correlation.js";

export const safeSpanAttributes = safeTraceAttributes;

export type { RuntimeRole } from "../runtimeRole.js";

export type TraceSamplerName =
  | "always_on"
  | "always_off"
  | "traceidratio"
  | "parentbased_always_on"
  | "parentbased_always_off"
  | "parentbased_traceidratio";

interface TracingLogger {
  error: AppLogger["error"];
  info?: AppLogger["info"];
}

interface TracingConfig {
  enabled: boolean;
  environment: string;
  logger?: TracingLogger;
  otlpEndpoint?: string;
  runtimeRole: RuntimeRole;
  sampler?: TraceSamplerName;
  samplerArg?: string;
  serviceName: string;
  spanExporter?: SpanExporter;
  version?: string;
}

interface ActiveTracing {
  enabled: true;
  provider: NodeTracerProvider;
  tracer: Tracer;
  logger?: TracingLogger;
}

interface DisabledTracing {
  enabled: false;
}

type TracingState = ActiveTracing | DisabledTracing;

const disabledTracing: DisabledTracing = { enabled: false };
let activeTracing: TracingState = disabledTracing;
const SHUTDOWN_TIMEOUT_MS = 5_000;

const ratioSampler = (samplerArg: string | undefined): TraceIdRatioBasedSampler => {
  const ratio = Number(samplerArg);
  return new TraceIdRatioBasedSampler(Number.isFinite(ratio) ? ratio : 1);
};

const buildRootSampler = (sampler: TraceSamplerName | undefined, samplerArg: string | undefined): Sampler => {
  switch (sampler) {
    case "always_off":
    case "parentbased_always_off":
      return new AlwaysOffSampler();
    case "traceidratio":
    case "parentbased_traceidratio":
      return ratioSampler(samplerArg);
    case "always_on":
    case "parentbased_always_on":
    case undefined:
      return new AlwaysOnSampler();
  }
};

const buildSampler = (sampler: TraceSamplerName | undefined, samplerArg: string | undefined): Sampler => {
  if (sampler?.startsWith("parentbased_") || sampler === undefined) {
    return new ParentBasedSampler({ root: buildRootSampler(sampler, samplerArg) });
  }

  return buildRootSampler(sampler, samplerArg);
};

const errorFields = (error: unknown): Record<string, string> => {
  if (error instanceof Error) {
    return {
      err: error.message,
    };
  }

  return {
    err: String(error),
  };
};

class LoggingSpanExporter implements SpanExporter {
  constructor(
    private readonly exporter: SpanExporter,
    private readonly logger: TracingLogger | undefined,
  ) {}

  export(spans: Parameters<SpanExporter["export"]>[0], callback: Parameters<SpanExporter["export"]>[1]): void {
    this.exporter.export(spans, (result) => {
      // result.code is @opentelemetry/core's ExportResultCode (SUCCESS = 0, FAILED = 1); comparing
      // to the literal avoids adding a direct dependency on that package for one enum value.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-enum-comparison -- see comment above
      if (result.code !== 0) {
        this.logger?.error(
          {
            err: result.error instanceof Error ? result.error.message : "span export failed",
            spanCount: spans.length,
          },
          "otel_export_failed",
        );
      }
      callback(result);
    });
  }

  forceFlush(): Promise<void> {
    return this.exporter.forceFlush?.() ?? Promise.resolve();
  }

  shutdown(): Promise<void> {
    return this.exporter.shutdown();
  }
}

const createSpanProcessor = (exporter: SpanExporter, useSimpleProcessor: boolean): SpanProcessor =>
  useSimpleProcessor ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter);

export const initializeTracing = (config: TracingConfig): void => {
  trace.disable();
  context.disable();
  activeTracing = disabledTracing;

  if (!config.enabled) {
    return;
  }

  try {
    const exporter = new LoggingSpanExporter(
      config.spanExporter ?? new OTLPTraceExporter({ url: config.otlpEndpoint }),
      config.logger,
    );
    const provider = new NodeTracerProvider({
      resource: resourceFromAttributes(safeTraceAttributes({
        [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: config.environment,
        [ATTR_SERVICE_NAME]: config.serviceName,
        [ATTR_SERVICE_VERSION]: config.version,
        "radioso.runtime_role": config.runtimeRole,
      })),
      sampler: buildSampler(config.sampler, config.samplerArg),
      spanLimits: {
        attributeValueLengthLimit: 512,
        attributeCountLimit: 64,
      },
      spanProcessors: [
        createSpanProcessor(exporter, Boolean(config.spanExporter)),
      ],
    });

    provider.register({
      contextManager: new AsyncLocalStorageContextManager(),
    });

    activeTracing = {
      enabled: true,
      logger: config.logger,
      provider,
      tracer: trace.getTracer("radioso-backend", config.version),
    };
    config.logger?.info?.(
      {
        environment: config.environment,
        runtimeRole: config.runtimeRole,
        serviceName: config.serviceName,
      },
      "otel_tracing_initialized",
    );
  } catch (error) {
    config.logger?.error(errorFields(error), "otel_tracing_init_failed");
    trace.disable();
    context.disable();
    activeTracing = disabledTracing;
    throw error;
  }
};

const recordSpanError = (span: Span, error: unknown): void => {
  if (error instanceof Error) {
    span.recordException(error);
    span.setStatus({ code: SpanStatusCode.ERROR, message: error.name });
    return;
  }

  span.setStatus({ code: SpanStatusCode.ERROR, message: String(error) });
};

const finishSpanResult = <T>(span: Span, value: T | Promise<T>): T | Promise<T> => {
  if (value instanceof Promise) {
    return value.then(
      (result) => {
        span.end();
        return result;
      },
      (error: unknown) => {
        recordSpanError(span, error);
        span.end();
        throw error;
      },
    );
  }

  span.end();
  return value;
};

export async function* streamActiveSpan<T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  createIterable: () => AsyncIterable<T>,
  options: Omit<SpanOptions, "attributes"> = {},
): AsyncIterable<T> {
  if (!activeTracing.enabled) {
    yield* createIterable();
    return;
  }

  const span = activeTracing.tracer.startSpan(name, {
    ...options,
    attributes: safeTraceAttributes(attributes),
  });
  const spanContext = trace.setSpan(context.active(), span);

  try {
    const iterator = context.with(spanContext, () => createIterable()[Symbol.asyncIterator]());
    while (true) {
      const result = await context.with(spanContext, () => iterator.next());
      if (result.done) {
        break;
      }
      yield result.value;
    }
  } catch (error) {
    recordSpanError(span, error);
    throw error;
  } finally {
    span.end();
  }
}

export const startActiveSpan = <T>(
  name: string,
  attributes: Record<string, unknown> | undefined,
  callback: (span?: Span) => T | Promise<T>,
  options: Omit<SpanOptions, "attributes"> = {},
): T | Promise<T> => {
  if (!activeTracing.enabled) {
    return callback();
  }

  return activeTracing.tracer.startActiveSpan(
    name,
    {
      ...options,
      attributes: safeTraceAttributes(attributes),
    },
    (span) => {
      try {
        return finishSpanResult(span, callback(span));
      } catch (error) {
        recordSpanError(span, error);
        span.end();
        throw error;
      }
    },
  );
};

export const setActiveSpanAttributes = (attributes: Record<string, unknown>): void => {
  trace.getActiveSpan()?.setAttributes(safeTraceAttributes(attributes));
};

export const currentTraceCorrelation = (): ActiveTraceCorrelation | undefined => {
  if (!activeTracing.enabled) {
    return undefined;
  }

  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext || !trace.isSpanContextValid(spanContext)) {
    return undefined;
  }

  return {
    sampled: (spanContext.traceFlags & TraceFlags.SAMPLED) !== 0,
    spanId: spanContext.spanId,
    traceId: spanContext.traceId,
  };
};

export const shutdownTracing = async (): Promise<void> => {
  if (!activeTracing.enabled) {
    trace.disable();
    context.disable();
    return;
  }

  const tracing = activeTracing;
  activeTracing = disabledTracing;

  const shutdown = async () => {
    await tracing.provider.forceFlush();
    await tracing.provider.shutdown();
  };
  const timeout = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), SHUTDOWN_TIMEOUT_MS).unref();
  });

  try {
    const result = await Promise.race([shutdown(), timeout]);
    if (result === "timeout") {
      tracing.logger?.error({ timeoutMs: SHUTDOWN_TIMEOUT_MS }, "otel_shutdown_timeout");
    }
  } catch (error) {
    tracing.logger?.error(errorFields(error), "otel_shutdown_failed");
  } finally {
    trace.disable();
    context.disable();
  }
};
