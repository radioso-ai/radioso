import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { loadConfiguredApplicationModules } from "./runtime/loadApplicationModules.js";
import { startCrawlerWorkerRuntime } from "./runtime/startCrawlerWorkerRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();
const logger = createLogger();

if (!env.WEBSITE_CRAWLER_ENABLED) {
  logger.info(
    { role: "crawler-worker" },
    "WEBSITE_CRAWLER_ENABLED=false; crawler worker is disabled. Exiting cleanly so the container can be removed.",
  );
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
