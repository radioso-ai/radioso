import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { loadConfiguredApplicationModules } from "./runtime/loadApplicationModules.js";
import { shouldRunCrawlerWorker } from "./runtime/crawlerWorkerStartup.js";
import { startCrawlerWorkerRuntime } from "./runtime/startCrawlerWorkerRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();
const logger = createLogger();

if (!shouldRunCrawlerWorker(env, logger, "crawler-worker")) {
  process.exit(0);
}

const applicationModules = await loadConfiguredApplicationModules(env, logger);
const runtime = await startCrawlerWorkerRuntime({
  env: process.env.OBSERVABILITY_SERVICE_NAME ? env : {
    ...env,
    OBSERVABILITY_SERVICE_NAME: "radioso-crawler-worker",
  },
  logger,
  applicationModules,
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
