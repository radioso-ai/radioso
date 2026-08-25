import { z } from "zod";

import { parseRealtimeConfig, type RealtimeConfig } from "../modules/realtime/infrastructure/config.js";
import type { RuntimeTracingEnv } from "./tracing.js";

const optionalText = z.preprocess((value) => value === "" ? undefined : value, z.string().min(1).optional());
const optionalUrl = z.preprocess((value) => value === "" ? undefined : value, z.string().url().optional());
const booleanish = z.preprocess((value) => {
  if (value === true || value === false) return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return value;
}, z.boolean());

const enabledRuntimeEnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  PORT: z.coerce.number().int().positive().max(65_535).default(8080),
  SESSION_COOKIE_NAME: z.string().min(1).default("radioso_session"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  OBSERVABILITY_SERVICE_NAME: z.string().min(1).default("radioso-realtime"),
  OBSERVABILITY_ENVIRONMENT: optionalText,
  OBSERVABILITY_VERSION: optionalText,
  OTEL_ENABLED: booleanish.default(false),
  OTEL_EXPORTER_OTLP_ENDPOINT: optionalUrl,
  OTEL_TRACES_SAMPLER: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum([
      "always_on",
      "always_off",
      "traceidratio",
      "parentbased_always_on",
      "parentbased_always_off",
      "parentbased_traceidratio",
    ]).optional(),
  ),
  OTEL_TRACES_SAMPLER_ARG: optionalText,
  OTEL_LOGS_ENABLED: booleanish.default(false),
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: optionalUrl,
  OTEL_EXPORTER_OTLP_LOGS_AUTH_BEARER: optionalText,
  OTEL_LOGS_MIN_LEVEL: z.preprocess(
    (value) => value === "" ? undefined : value,
    z.enum(["trace", "debug", "info", "warn", "error", "fatal"]).optional(),
  ),
}).superRefine((value, context) => {
  if (value.OTEL_ENABLED && !value.OTEL_EXPORTER_OTLP_ENDPOINT) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OTEL_EXPORTER_OTLP_ENDPOINT is required when OTEL_ENABLED is true",
      path: ["OTEL_EXPORTER_OTLP_ENDPOINT"],
    });
  }
  if (value.OTEL_LOGS_ENABLED && !value.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT is required when OTEL_LOGS_ENABLED is true",
      path: ["OTEL_EXPORTER_OTLP_LOGS_ENDPOINT"],
    });
  }
  const samplerUsesRatio = value.OTEL_TRACES_SAMPLER === "traceidratio"
    || value.OTEL_TRACES_SAMPLER === "parentbased_traceidratio";
  if (samplerUsesRatio) {
    const ratio = Number(value.OTEL_TRACES_SAMPLER_ARG);
    if (!value.OTEL_TRACES_SAMPLER_ARG || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "OTEL_TRACES_SAMPLER_ARG must be a number from 0 to 1 for ratio samplers",
        path: ["OTEL_TRACES_SAMPLER_ARG"],
      });
    }
  } else if (value.OTEL_TRACES_SAMPLER_ARG) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "OTEL_TRACES_SAMPLER_ARG is only valid for ratio samplers",
      path: ["OTEL_TRACES_SAMPLER_ARG"],
    });
  }
});

export type RealtimeRuntimeEnv = {
  config: RealtimeConfig;
  enabled: false;
} | {
  config: RealtimeConfig;
  databaseUrl: string;
  enabled: true;
  port: number;
  sessionCookieName: string;
  tracing: RuntimeTracingEnv;
};

export const parseRealtimeRuntimeEnv = (raw: Record<string, unknown>): RealtimeRuntimeEnv => {
  const config = parseRealtimeConfig(raw);
  if (config.mode === "disabled") return { config, enabled: false };
  const value = enabledRuntimeEnvSchema.parse(raw);
  return {
    config,
    databaseUrl: value.DATABASE_URL,
    enabled: true,
    port: value.PORT,
    sessionCookieName: value.SESSION_COOKIE_NAME,
    tracing: value,
  };
};
