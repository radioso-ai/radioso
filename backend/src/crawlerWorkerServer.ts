import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { startCrawlerWorkerTaskRuntime } from "./runtime/startCrawlerWorkerTaskRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();

if (!env.WEBSITE_CRAWLER_ENABLED) {
  createLogger().info(
    { role: "crawler-worker-task" },
    "WEBSITE_CRAWLER_ENABLED=false; crawler worker task server is disabled. Exiting cleanly so the container can be removed.",
  );
  process.exit(0);
}

const runtime = await startCrawlerWorkerTaskRuntime({
  env: process.env.OBSERVABILITY_SERVICE_NAME ? env : {
    ...env,
    OBSERVABILITY_SERVICE_NAME: "radioso-crawler-worker",
  },
});

process.once("SIGINT", () => {
  void runtime.shutdown("SIGINT");
});

process.once("SIGTERM", () => {
  void runtime.shutdown("SIGTERM");
});
