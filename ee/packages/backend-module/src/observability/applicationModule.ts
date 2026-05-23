import type { ApplicationModule } from "../radiosoModuleTypes.js";
import { parseConfiguredSinks } from "./configuredSinks.js";
import { PosthogAnalyticsSink } from "./posthogAnalyticsSink.js";
import { SentryErrorSink } from "./sentryErrorSink.js";

interface ObservabilityEnv {
  PRODUCT_ANALYTICS_SINKS?: string;
  POSTHOG_HOST?: string;
  POSTHOG_API_KEY?: string;
  ERROR_SINKS?: string;
  SENTRY_DSN?: string;
}

const requireEnv = (env: ObservabilityEnv, key: keyof ObservabilityEnv): string => {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`${key} is required by the Enterprise observability adapter`);
  }
  return value;
};

const requireUrlEnv = (env: ObservabilityEnv, key: keyof ObservabilityEnv): string => {
  const value = requireEnv(env, key);
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${key} must be an HTTP(S) URL`);
  }
  return url.toString().replace(/\/+$/, "");
};

export const createEnterpriseObservabilityApplicationModule = (
  env: ObservabilityEnv = process.env,
): ApplicationModule => ({
  id: "radioso-enterprise-observability",
  name: "Radioso Enterprise Observability",
  register(context) {
    const productAnalyticsSinks = parseConfiguredSinks(env.PRODUCT_ANALYTICS_SINKS, {
      envName: "PRODUCT_ANALYTICS_SINKS",
      supportedSinks: ["audit", "posthog"],
    });
    const errorSinks = parseConfiguredSinks(env.ERROR_SINKS, {
      envName: "ERROR_SINKS",
      supportedSinks: ["audit", "sentry"],
    });

    if (productAnalyticsSinks.has("posthog")) {
      context.registerProductAnalyticsSink?.(new PosthogAnalyticsSink({
        apiKey: requireEnv(env, "POSTHOG_API_KEY"),
        host: requireUrlEnv(env, "POSTHOG_HOST"),
      }));
    }

    if (errorSinks.has("sentry")) {
      context.registerErrorSink?.(new SentryErrorSink({
        dsn: requireEnv(env, "SENTRY_DSN"),
      }));
    }
  },
});
