import type { Env } from "../app/config/env.js";
import type { AppLogger } from "../shared/observability/logger.js";
import {
  initializeTracing,
  shutdownTracing,
  type RuntimeRole,
  type TraceSamplerName,
} from "../shared/observability/tracing/index.js";

const defaultServiceName = (runtimeRole: RuntimeRole): string => {
  switch (runtimeRole) {
    case "api":
      return "radioso-api";
    case "crawler-worker":
    case "crawler-worker-task-server":
      return "radioso-crawler-worker";
    case "document-worker":
    case "document-worker-task-server":
      return "radioso-worker";
  }
};

const serviceName = (env: Env, runtimeRole: RuntimeRole): string => {
  if (runtimeRole !== "api" && env.OBSERVABILITY_SERVICE_NAME === "radioso-api") {
    return defaultServiceName(runtimeRole);
  }
  return env.OBSERVABILITY_SERVICE_NAME ?? defaultServiceName(runtimeRole);
};

export const startRuntimeTracing = (
  env: Env,
  logger: AppLogger,
  runtimeRole: RuntimeRole,
): void => {
  initializeTracing({
    enabled: Boolean(env.OTEL_ENABLED),
    environment: env.OBSERVABILITY_ENVIRONMENT ?? env.NODE_ENV ?? "development",
    logger,
    otlpEndpoint: env.OTEL_EXPORTER_OTLP_ENDPOINT,
    runtimeRole,
    sampler: env.OTEL_TRACES_SAMPLER as TraceSamplerName | undefined,
    samplerArg: env.OTEL_TRACES_SAMPLER_ARG,
    serviceName: serviceName(env, runtimeRole),
    version: env.OBSERVABILITY_VERSION,
  });
};

export const stopRuntimeTracing = async (): Promise<void> => {
  await shutdownTracing();
};
