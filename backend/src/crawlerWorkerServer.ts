import { getEnv } from "./app/config/env.js";
import { createLogger } from "./shared/observability/logger.js";
import { loadEnvFileIfPresent } from "./runtime/loadEnv.js";
import { shouldRunCrawlerWorker } from "./runtime/crawlerWorkerStartup.js";
import { startCrawlerWorkerTaskRuntime } from "./runtime/startCrawlerWorkerTaskRuntime.js";

loadEnvFileIfPresent();

const env = getEnv();

if (!shouldRunCrawlerWorker(env, createLogger(), "crawler-worker-task")) {
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
