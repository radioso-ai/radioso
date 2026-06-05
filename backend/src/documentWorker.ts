import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { loadConfiguredApplicationModules } from "./runtime/loadApplicationModules.js";
import { startWorkerRuntime } from "./runtime/startWorkerRuntime.js";
import { installRuntimeProcessErrorHandlers } from "./runtime/processErrorHandlers.js";

loadEnvFileIfPresent();

const env = getEnv();
const logger = createLogger();
const applicationModules = await loadConfiguredApplicationModules(env, logger);
const runtime = await startWorkerRuntime({
  env: process.env.OBSERVABILITY_SERVICE_NAME ? env : {
    ...env,
    OBSERVABILITY_SERVICE_NAME: "radioso-worker",
  },
  logger,
  applicationModules,
});

installRuntimeProcessErrorHandlers(runtime, "worker");

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
