import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { loadConfiguredApplicationModules } from "./runtime/loadApplicationModules.js";
import { startApiRuntime } from "./runtime/startApiRuntime.js";
import { installRuntimeProcessErrorHandlers } from "./runtime/processErrorHandlers.js";

loadEnvFileIfPresent();

const env = getEnv();
const logger = createLogger();
const applicationModules = await loadConfiguredApplicationModules(env, logger);
const runtime = await startApiRuntime({
  env,
  logger,
  applicationModules,
});

installRuntimeProcessErrorHandlers(runtime, "api");

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
